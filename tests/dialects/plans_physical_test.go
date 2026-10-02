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

// hiddenLeft는 dialect에서 이름이 dbspec$로 시작하는 table과 column의 수를 읽는다.
var hiddenLeft = map[string]string{
	"mysql":    "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%')",
	"postgres": "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%')",
	"sqlite":   "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%')",
}

// planStep은 plans.json의 step object다(docs/plans.md "Steps").
type planStep struct {
	Statement    string `json:"statement"`
	Rollback     string `json:"rollback"`
	Irreversible string `json:"irreversible"`
	Restore      string `json:"restore"`
	// RollbackRestore는 옛 table이 숨긴 더한 column을 가질 때의 rollback이다. 끝까지
	// 되돌리는 rollback은 옛 table을 그 column과 함께 다시 만든다.
	RollbackRestore string `json:"rollback_restore"`
	Finalize        bool   `json:"finalize"`
}

// TestPlanApply는 tests/dbspec/plans.json의 각 case를 세 database에 적용한다:
// source를 렌더링해 적용하고, before step과 finalize 앞의 plan step을 실행해 target을
// 확인하고, 되돌릴 수 없는 step이 없으면 rollback statement로 source를 확인한 뒤 다시
// 적용하고, after step과 finalize step을 실행한 뒤 target과 숨긴 이름이 없음을 확인한다.
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
			ID     string                `json:"id"`
			Source []string              `json:"source"`
			Plan   []string              `json:"plan"`
			Steps  map[string][]planStep `json:"steps"`
			Before []ddlStep             `json:"before"`
			After  []ddlStep             `json:"after"`
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
		sourceText := ""
		if c.Source != nil {
			d, diagnostics := dbspec.Parse(strings.Join(c.Source, "\n")+"\n", nil)
			if len(diagnostics) > 0 {
				t.Fatalf("%s: %v", c.ID, diagnostics)
			}
			source = []*dbspec.Document{d}
			m, _ := dbspec.ManifestOf(source)
			sourceText = m.SchemaText
		}
		for _, db := range []string{"mysql", "postgres", "sqlite"} {
			var setup []string
			if source != nil {
				setup, diagnostics = dbspec.Render(source, dbspec.Dialect(db))
				if len(diagnostics) > 0 {
					t.Fatalf("%s: %v", c.ID, diagnostics)
				}
			}
			planSteps := c.Steps[db]
			reversible := true
			for _, s := range planSteps {
				if !s.Finalize && s.Rollback == "" {
					reversible = false
				}
			}
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
			// schemaIs는 introspect한 schema text가 want인지 확인한다.
			schemaIs := func(e *Env, what, want string) {
				if e.Err != nil {
					return
				}
				document, unsupported, err := dbspec.Introspect(e.Ctx, e.Conn, dbspec.Dialect(db), "introspected")
				if err != nil {
					e.fail("introspect %s: %v", what, err)
					return
				}
				if len(unsupported) > 0 {
					e.fail("unsupported %s: %+v", what, unsupported)
					return
				}
				got := ""
				if len(document.Tables) > 0 {
					m, _ := dbspec.ManifestOf([]*dbspec.Document{document})
					got = m.SchemaText
				}
				if got != want {
					e.fail("%s schema text differs\n--- want\n%s--- got\n%s", what, want, got)
				}
			}
			// forward는 finalize 앞의 step을 실행한다. restore이면 restore statement가 있는
			// step은 그것을 실행한다(rollback이 숨긴 더한 column이 있다).
			forward := func(e *Env, restore bool) {
				for _, s := range planSteps {
					if s.Finalize {
						break
					}
					if restore && s.Restore != "" {
						e.Exec(s.Restore)
					} else {
						e.Exec(s.Statement)
					}
				}
				if db == "sqlite" {
					e.Want("SELECT COUNT(*) FROM pragma_foreign_key_check", "0")
				}
			}
			probe := Probe{ID: db + ".plan." + strings.ReplaceAll(c.ID, "-", "_"), DB: db, Fact: "plan " + c.ID + " applies, rolls back and reaches its target", Run: func(e *Env) {
				e.Exec(connectionRules[db]...)
				e.Exec(setup...)
				steps(e, c.Before)
				// SQLite는 table을 다시 만드는 동안 foreign key를 끄고, 끝난 뒤 검사한다.
				if db == "sqlite" {
					e.Exec("PRAGMA foreign_keys = OFF", "PRAGMA legacy_alter_table = OFF")
				}
				forward(e, false)
				schemaIs(e, "applied", target.SchemaText)
				if reversible {
					for i := len(planSteps) - 1; i >= 0; i-- {
						switch {
						case planSteps[i].Finalize:
						case planSteps[i].RollbackRestore != "":
							e.Exec(planSteps[i].RollbackRestore)
						default:
							e.Exec(planSteps[i].Rollback)
						}
					}
					if db == "sqlite" {
						e.Want("SELECT COUNT(*) FROM pragma_foreign_key_check", "0")
					}
					schemaIs(e, "rolled back", sourceText)
					forward(e, true)
					schemaIs(e, "applied again", target.SchemaText)
				}
				if db == "sqlite" {
					e.Exec("PRAGMA foreign_keys = ON")
				}
				steps(e, c.After)
				// finalize도 apply처럼 SQLite foreign key를 끄고 실행한다. 숨긴 table끼리
				// 참조할 수 있다.
				if db == "sqlite" {
					e.Exec("PRAGMA foreign_keys = OFF")
				}
				for _, s := range planSteps {
					if s.Finalize {
						e.Exec(s.Statement)
					}
				}
				if db == "sqlite" {
					e.Want("SELECT COUNT(*) FROM pragma_foreign_key_check", "0")
					e.Exec("PRAGMA foreign_keys = ON")
				}
				schemaIs(e, "finalized", target.SchemaText)
				e.Want(hiddenLeft[db], "0")
			}}
			index++
			t.Run(probe.ID, func(t *testing.T) {
				begin := time.Now()
				t.Logf("start %s: %d steps, reversible %v", probe.ID, len(planSteps), reversible)
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
