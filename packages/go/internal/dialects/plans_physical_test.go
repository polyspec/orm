//go:build physical

package dialects

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/testcase"
)

// hiddenLeft reads the number of tables and columns whose name starts with dbspec$ in the dialect.
var hiddenLeft = map[string]string{
	"mysql":    "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%')",
	"postgres": "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%')",
	"sqlite":   "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%')",
}

// planStep is the step object of plans.json (docs/spec/plans.md "Steps").
type planStep struct {
	Statement    string `json:"statement"`
	Rollback     string `json:"rollback"`
	Irreversible string `json:"irreversible"`
	Restore      string `json:"restore"`
	// RollbackRestore is the rollback when the old table has an added column that was hidden. It rolls back to the end
	// and re-creates the old table with that column.
	RollbackRestore string `json:"rollback_restore"`
	Finalize        bool   `json:"finalize"`
}

// TestPlanApply applies each case of tests/dbspec/plans.json to three databases:
// it renders and applies the source, runs the before steps and the plan steps before finalize to check the target,
// checks the source with rollback statements if there are no irreversible steps, then re-applies,
// and after running the after steps and the finalize step, checks the target and that no hidden names remain.
// Requirements: PLN-102.
func TestPlanApply(t *testing.T) {
	testcase.Group(t)
	mysqlDSN, postgresDSN := testDSNs(t)
	raw := readDBSpecFile(t, "plans.json")
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
	servers := openTestServers(t, mysqlDSN, postgresDSN, "plan"+strconv.Itoa(os.Getpid()))
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
			d, _, diagnostics := dbspec.Parse(strings.Join(c.Source, "\n")+"\n", nil)
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
				runDDLSteps(e, db, steps)
			}
			// schemaIs checks that the introspected schema text is want.
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
				got := schemaTextOf(document)
				if got != want {
					e.fail("%s schema text differs\n--- want\n%s--- got\n%s", what, want, got)
				}
			}
			// forward runs the steps before finalize. If it is restore, the step with the restore statement
			// runs it (there is an added column that rollback hid).
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
				// SQLite turns off foreign keys while re-creating a table, and checks them afterward.
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
				// finalize also turns off SQLite foreign keys and runs, as apply does. Hidden tables
				// can reference each other.
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
				runProbeCase(t, servers, probe, index, fmt.Sprintf("%d steps, reversible %v", len(planSteps), reversible))
			})
		}
	}
}
