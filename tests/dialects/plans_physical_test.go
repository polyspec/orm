//go:build physical

package dialects

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/engine/dbspec"
)

// TestPlanApply는 tests/dbspec/plans.json의 각 case를 세 database에 적용한다:
// source를 렌더링해 적용하고, before step, plan statement, after step을
// 실행한 뒤 introspect한 schema text가 plan의 target과 같은지 확인한다.
func TestPlanApply(t *testing.T) {
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	raw, err := os.ReadFile(filepath.Join("..", "dbspec", "plans.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			ID         string              `json:"id"`
			Source     []string            `json:"source"`
			Plan       []string            `json:"plan"`
			Statements map[string][]string `json:"statements"`
			Before     []ddlStep           `json:"before"`
			After      []ddlStep           `json:"after"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	connect, cancel := context.WithTimeout(context.Background(), probeDeadline)
	servers, err := OpenServers(connect, mysqlDSN, postgresDSN, t.TempDir(), "plan"+strconv.Itoa(os.Getpid()))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := servers.Close(); err != nil {
			t.Error(err)
		}
	})
	index := 0
	for _, c := range vectors.Cases {
		p, diagnostics := dbspec.ParsePlan(strings.Join(c.Plan, "\n") + "\n")
		if len(diagnostics) > 0 {
			t.Fatalf("%s: %v", c.ID, diagnostics)
		}
		target, _ := dbspec.ManifestOf([]*dbspec.Document{p.Schema})
		var source []*dbspec.Document
		if c.Source != nil {
			d, diagnostics := dbspec.Parse(strings.Join(c.Source, "\n")+"\n", nil)
			if len(diagnostics) > 0 {
				t.Fatalf("%s: %v", c.ID, diagnostics)
			}
			source = []*dbspec.Document{d}
		}
		for _, db := range []string{"mysql", "postgres", "sqlite"} {
			var setup []string
			if source != nil {
				setup, diagnostics = dbspec.Render(source, dbspec.Dialect(db))
				if len(diagnostics) > 0 {
					t.Fatalf("%s: %v", c.ID, diagnostics)
				}
			}
			statements := c.Statements[db]
			steps := func(e *Env, steps []ddlStep) {
				for _, step := range steps {
					if len(step.Dialects) > 0 && !slices.Contains(step.Dialects, db) {
						continue
					}
					switch {
					case step.Query != "":
						e.Want(step.Query, step.Want)
					case step.Fails:
						e.FailsAny(step.SQL)
					default:
						e.Exec(step.SQL)
					}
				}
			}
			probe := Probe{ID: db + ".plan." + strings.ReplaceAll(c.ID, "-", "_"), DB: db, Fact: "plan " + c.ID + " applies and reaches its target", Run: func(e *Env) {
				e.Exec(connectionRules[db]...)
				e.Exec(setup...)
				steps(e, c.Before)
				// SQLite는 table을 다시 만드는 동안 foreign key를 끄고, 끝난 뒤 검사한다.
				if db == "sqlite" {
					e.Exec("PRAGMA foreign_keys = OFF")
				}
				e.Exec(statements...)
				if db == "sqlite" {
					e.Want("SELECT COUNT(*) FROM pragma_foreign_key_check", "0")
					e.Exec("PRAGMA foreign_keys = ON")
				}
				steps(e, c.After)
				if e.Err != nil {
					return
				}
				document, unsupported, err := dbspec.Introspect(e.Ctx, e.Conn, dbspec.Dialect(db), "introspected")
				if err != nil {
					e.fail("introspect: %v", err)
					return
				}
				if len(unsupported) > 0 {
					e.fail("unsupported: %+v", unsupported)
					return
				}
				got, _ := dbspec.ManifestOf([]*dbspec.Document{document})
				if got.SchemaText != target.SchemaText {
					e.fail("schema text differs\n--- want\n%s--- got\n%s", target.SchemaText, got.SchemaText)
				}
			}}
			index++
			t.Run(probe.ID, func(t *testing.T) {
				begin := time.Now()
				t.Logf("start %s: %d statements", probe.ID, len(statements))
				_, err := runWithDeadline(servers, probe, index)
				elapsed := time.Since(begin).Round(time.Millisecond)
				if err != nil {
					t.Errorf("result %s: FAIL after %s: %v", probe.ID, elapsed, err)
					return
				}
				t.Logf("result %s: PASS after %s", probe.ID, elapsed)
			})
		}
	}
}
