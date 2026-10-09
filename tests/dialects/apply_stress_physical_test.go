//go:build physical

package dialects

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/internal/testcase"
)

// TestApplyStressPlan은 tests/dbspec/stress.mjs의 2000 table 문서를 첫 plan으로 세
// database에 적용한다(docs/plans.md "Verification"). PostgreSQL은 기본 lock 설정
// (max_locks_per_transaction 64)이어야 한다. statement마다 따로 commit하므로 lock
// table은 plan 크기와 상관없다.
func TestApplyStressPlan(t *testing.T) {
	testcase.Group(t)
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	// stress 문서 생성은 node process 하나이므로 testcase.Process 기한을 가진다.
	generating, cancelGenerate := context.WithTimeout(context.Background(), testcase.Process)
	out, err := exec.CommandContext(generating, "node", filepath.Join("..", "dbspec", "stress.mjs")).Output()
	cancelGenerate()
	if err != nil {
		t.Fatalf("node tests/dbspec/stress.mjs: %v", err)
	}
	text := strings.Replace(string(out), "dbspec 1 stress\n", "dbspec 1 schema\n", 1)
	plan := parsePlan(t, "dbplan 1 stress\nfrom empty\n\n"+text)
	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	token := strconv.Itoa(os.Getpid()) + "_" + hex.EncodeToString(random)
	for _, db := range []string{"mysql", "postgres", "sqlite"} {
		t.Run(db, func(t *testing.T) {
			// 한 case의 기한은 plan의 step 수에서 정한다(stressCaseBudget). 멈춘 step은 stall guard가 먼저 찾는다.
			steps := planSteps(t, []*dbspec.Plan{plan}, 0, db)
			c := testcase.Start(t, stressCaseBudget(len(steps)))
			name := "dbspec_stress_" + token + "_" + db
			c.Step("%d steps on %s", len(steps), name)
			uri, cleanup := compareDatabase(t, db, name, mysqlDSN, postgresDSN)
			defer func() {
				cleanup()
				c.Step("dropped %s", name)
			}()
			pool := openURI(t, db, uri)
			defer pool.Close()
			ctx, progressed, stopGuard := newStallGuard(c.Context(), stressStallLimit)
			defer stopGuard()
			conn, err := pool.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if db == "postgres" {
				var locks string
				if err := conn.QueryRowContext(ctx, "SHOW max_locks_per_transaction").Scan(&locks); err != nil {
					t.Fatal(err)
				}
				if locks != "64" {
					t.Fatalf("max_locks_per_transaction is %s; the case needs the default 64", locks)
				}
				c.Step("postgres max_locks_per_transaction %s", locks)
			}
			for _, s := range connectionRules[db] {
				if _, err := conn.ExecContext(ctx, s); err != nil {
					t.Fatal(err)
				}
			}
			applied := 0
			progress := func(ev dbspec.ApplyEvent) error {
				switch ev.Kind {
				case "applied":
					applied++
					progressed()
					if applied%2000 == 0 {
						c.Step("%d of %d steps applied", applied, ev.Steps)
					}
				case "verified":
					c.Step("verified")
				}
				return nil
			}
			if err := dbspec.Apply(ctx, conn, dbspec.Dialect(db), []*dbspec.Plan{plan}, fixedNow, progress); err != nil {
				t.Fatalf("apply: %v (%v)", err, context.Cause(ctx))
			}
			var row string
			if err := conn.QueryRowContext(ctx, "SELECT "+map[string]string{"mysql": "CONCAT(state, ' ', step)"}[db]+map[string]string{"postgres": "state || ' ' || step", "sqlite": "state || ' ' || step"}[db]+" FROM "+historyOf(db)).Scan(&row); err != nil {
				t.Fatal(err)
			}
			if want := fmt.Sprintf("applied %d", len(steps)); row != want || applied != len(steps) {
				t.Fatalf("history row %q and %d applied events, want %q and %d", row, applied, want, len(steps))
			}
			c.Step("%d steps, history %q", applied, row)
		})
	}
}
