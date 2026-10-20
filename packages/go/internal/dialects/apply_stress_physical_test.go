//go:build physical

package dialects

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/testcase"
)

// stressStallLimit is the time that may pass with no step applied at all. Each step is one statement and its commit, so
// on a working database one step takes well under a second.
const stressStallLimit = 30 * time.Second

// stressTables is the table count of the stress document. It is more than PostgreSQL's default
// max_locks_per_transaction (64), so an apply that kept its statements in one transaction would hold more relation
// locks than one transaction is granted by default; a larger document proves nothing more.
const stressTables = 100

// stressReportEvery is the number of applied steps between two progress lines.
const stressReportEvery = 200

// TestApplyStressPlan applies the stressTables-table document of tests/dbspec/stress.mts as the first plan to the
// database (docs/spec/plans.md "Verification"). It proves that each statement commits separately: on PostgreSQL, with the
// default max_locks_per_transaction 64, the applying session holds no relation lock after any applied step, so the lock
// count does not depend on the plan size. Every database records each step in its history.
func TestApplyStressPlan(t *testing.T) {
	testcase.Group(t)
	mysqlDSN, postgresDSN := testDSNs(t)
	// Creating the stress document is one node process, so it has the testcase.Process deadline.
	generating, cancelGenerate := context.WithTimeout(context.Background(), testcase.Process)
	out, err := exec.CommandContext(generating, "node", filepath.Join(repoRoot, "tests", "dbspec", "stress.mts"), strconv.Itoa(stressTables)).Output()
	cancelGenerate()
	if err != nil {
		t.Fatalf("node tests/dbspec/stress.mts: %v", err)
	}
	text := strings.Replace(string(out), "dbspec 1 stress\n", "dbspec 1 schema\n", 1)
	plan := parsePlan(t, "dbplan 1 stress\nfrom empty\n\n"+text)
	token := uniqueToken(t)
	for _, db := range []string{"mysql", "postgres", "sqlite"} {
		t.Run(db, func(t *testing.T) {
			// The deadline of a case is set by the plan's step count (testcase.StepBudget). A stalled step is found first by the stall guard.
			steps := planSteps(t, []*dbspec.Plan{plan}, 0, db)
			c := testcase.Start(t, testcase.StepBudget(len(steps)))
			name := "dbspec_stress_" + token + "_" + db
			c.Step("%d steps on %s", len(steps), name)
			uri, cleanup := compareDatabase(t, db, name, mysqlDSN, postgresDSN)
			defer func() {
				cleanup()
				c.Step("dropped %s", name)
			}()
			pool := openURI(t, db, uri)
			defer testcase.Close(t, pool)
			ctx, progressed, stopGuard := testcase.StallGuard(c.Context(), stressStallLimit)
			defer stopGuard()
			conn, err := pool.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, conn)
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
			// heldLocks counts, from a second session, the relation locks that the applying session holds; it is nil
			// outside PostgreSQL.
			var heldLocks func() (int, error)
			if db == "postgres" {
				var pid int
				if err := conn.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
					t.Fatal(err)
				}
				watch, err := pool.Conn(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer testcase.Close(t, watch)
				heldLocks = func() (int, error) {
					var n int
					err := watch.QueryRowContext(ctx, "SELECT count(*) FROM pg_locks WHERE pid = $1 AND locktype = 'relation'", pid).Scan(&n)
					return n, err
				}
			}
			started := time.Now()
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
					if heldLocks != nil {
						n, err := heldLocks()
						if err != nil {
							return fmt.Errorf("count the locks after step %d: %w", applied, err)
						}
						if n != 0 {
							return fmt.Errorf("after step %d the applying session holds %d relation locks, want 0", applied, n)
						}
					}
					if applied%stressReportEvery == 0 || applied == ev.Steps {
						c.Step("%d of %d steps applied, %s", applied, ev.Steps, time.Since(started).Round(time.Millisecond))
					}
				case "verified":
					c.Step("verified, %s", time.Since(started).Round(time.Millisecond))
				}
				return nil
			}
			if err := applyCommand(ctx, conn, dbspec.Dialect(db), []*dbspec.Plan{plan}, fixedNow, progress); err != nil {
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
