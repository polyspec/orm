package recipe

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/internal/dbspec/ddlcases"
	"github.com/polyspec/orm/packages/go/internal/dbspec/plancases"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
)

// planHiddenLeft reads the number of tables and columns whose name begins with dbspec$ in the database.
var planHiddenLeft = map[string]string{
	"mysql":    "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%')",
	"postgres": "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%')",
	"sqlite":   "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%')",
}

// planPhysical runs one dbspec.plan_physical step on one native connection of the case database (PLN-102): the connection
// rules, the rendered source and the before steps; the plan steps before finalize, on SQLite with foreign keys off and no
// row of foreign_key_check, and the public Introspect reads the target with nothing unsupported; without an irreversible
// step, the rollback statements return to the source and the steps run again; then the after steps and the finalize steps
// run, the target is read again and no table or column named dbspec$ remains.
func planPhysical(s databaseStep, c *databaseContext) error {
	path := filepath.Join(c.dir, s.k("vectors").Vectors)
	cases, err := plancases.Read(path)
	if err != nil {
		return err
	}
	index := slices.IndexFunc(cases, func(candidate plancases.Case) bool { return candidate.ID == s.k("case").Case })
	if index < 0 {
		return fmt.Errorf("the vectors have no case %s", s.k("case").Case)
	}
	vector := cases[index]
	text, err := os.ReadFile(filepath.Join(filepath.Dir(path), "plans-physical.json"))
	if err != nil {
		return err
	}
	records, err := plancases.ParsePhysical(text)
	if err != nil {
		return err
	}
	record, ok := records[vector.ID]
	if !ok {
		return fmt.Errorf("%s: no physical record in plans-physical.json", vector.ID)
	}
	var before, after []ddlcases.Step
	if err := json.Unmarshal(record.Before, &before); err != nil {
		return err
	}
	if err := json.Unmarshal(record.After, &after); err != nil {
		return err
	}
	plan, diagnostics := dbspec.ParsePlan(strings.Join(vector.Plan, "\n") + "\n")
	if len(diagnostics) > 0 {
		return fmt.Errorf("the plan: %v", diagnostics)
	}
	target, diagnostics := dbspec.ManifestOf([]*dbspec.Document{plan.Schema})
	if len(diagnostics) > 0 {
		return fmt.Errorf("the manifest of the target: %v", diagnostics)
	}
	dialect := dbspec.Dialect(c.dialect())
	var source *dbspec.Document
	var setup []string
	sourceText := ""
	if vector.Source != nil {
		document, _, diagnostics := dbspec.Parse(strings.Join(vector.Source, "\n")+"\n", nil)
		if len(diagnostics) > 0 {
			return fmt.Errorf("the source: %v", diagnostics)
		}
		source = document
		if setup, diagnostics = dbspec.Render([]*dbspec.Document{source}, dialect); len(diagnostics) > 0 {
			return fmt.Errorf("the render of the source: %v", diagnostics)
		}
		manifest, diagnostics := dbspec.ManifestOf([]*dbspec.Document{source})
		if len(diagnostics) > 0 {
			return fmt.Errorf("the manifest of the source: %v", diagnostics)
		}
		sourceText = manifest.SchemaText
	}
	steps, diagnostics := dbspec.PlanSteps(source, plan, dialect)
	if len(diagnostics) > 0 {
		return fmt.Errorf("the plan steps: %v", diagnostics)
	}
	reversible := !slices.ContainsFunc(steps, func(step dbspec.PlanStep) bool { return !step.Finalize && step.Rollback == "" })
	raw := testdb.Open(c.t, c.database, c.dsn)
	defer testcase.Close(c.t, raw)
	// One connection, so that the connection rules and the foreign key setting hold for every statement after them.
	raw.SetMaxOpenConns(1)
	run := planRun{c: c, raw: raw, dialect: dialect}
	sqlite := c.dialect() == "sqlite"
	if err := run.exec(introspectConnectionRules[c.dialect()]...); err != nil {
		return err
	}
	if err := run.exec(setup...); err != nil {
		return err
	}
	if err := run.behavior(before); err != nil {
		return err
	}
	// SQLite turns foreign keys off while it recreates a table, and checks them afterwards.
	if sqlite {
		if err := run.exec("PRAGMA foreign_keys = OFF", "PRAGMA legacy_alter_table = OFF"); err != nil {
			return err
		}
	}
	forward := func(restore bool) error {
		for _, step := range steps {
			if step.Finalize {
				break
			}
			statement := step.Statement
			if restore && step.Restore != "" {
				statement = step.Restore
			}
			if err := run.exec(statement); err != nil {
				return err
			}
		}
		return run.foreignKeys(sqlite)
	}
	if err := forward(false); err != nil {
		return err
	}
	if err := run.schemaIs("applied", target.SchemaText); err != nil {
		return err
	}
	if reversible {
		// A rollback that goes all the way back recreates the old table with the added column hidden.
		for _, step := range slices.Backward(steps) {
			if step.Finalize {
				continue
			}
			statement := step.Rollback
			if step.RollbackRestore != "" {
				statement = step.RollbackRestore
			}
			if err := run.exec(statement); err != nil {
				return err
			}
		}
		if err := run.foreignKeys(sqlite); err != nil {
			return err
		}
		if err := run.schemaIs("rolled back", sourceText); err != nil {
			return err
		}
		if err := forward(true); err != nil {
			return err
		}
		if err := run.schemaIs("applied again", target.SchemaText); err != nil {
			return err
		}
	}
	if sqlite {
		if err := run.exec("PRAGMA foreign_keys = ON"); err != nil {
			return err
		}
	}
	if err := run.behavior(after); err != nil {
		return err
	}
	// Finalize also runs with SQLite foreign keys off, as apply does: hidden tables can reference each other.
	if sqlite {
		if err := run.exec("PRAGMA foreign_keys = OFF"); err != nil {
			return err
		}
	}
	for _, step := range steps {
		if step.Finalize {
			if err := run.exec(step.Statement); err != nil {
				return err
			}
		}
	}
	if err := run.foreignKeys(sqlite); err != nil {
		return err
	}
	if sqlite {
		if err := run.exec("PRAGMA foreign_keys = ON"); err != nil {
			return err
		}
	}
	if err := run.schemaIs("finalized", target.SchemaText); err != nil {
		return err
	}
	hidden, err := run.value(planHiddenLeft[c.dialect()])
	if err != nil {
		return err
	}
	if hidden != "0" {
		return fmt.Errorf("%s tables or columns named dbspec$ remain after finalize", hidden)
	}
	return nil
}

// planRun is the native connection of one dbspec.plan_physical step.
type planRun struct {
	c       *databaseContext
	raw     *sql.DB
	dialect dbspec.Dialect
}

// exec runs the statements in order.
func (r planRun) exec(statements ...string) error {
	for _, statement := range statements {
		if _, err := r.raw.ExecContext(r.c.ctx, statement); err != nil {
			return fmt.Errorf("%s: %w", statement, err)
		}
	}
	return nil
}

// value reads the first value of the first row as text; a NULL or absent value fails.
func (r planRun) value(query string) (string, error) {
	var got sql.NullString
	if err := r.raw.QueryRowContext(r.c.ctx, query).Scan(&got); err != nil {
		return "", fmt.Errorf("%s: %w", query, err)
	}
	if !got.Valid {
		return "", fmt.Errorf("%s: NULL value", query)
	}
	return got.String, nil
}

// behavior runs the steps for the database: a step with dialects runs only on those, a statement with fails must fail, a
// query compares its first value, as text, with want.
func (r planRun) behavior(steps []ddlcases.Step) error {
	for _, step := range steps {
		if len(step.Dialects) > 0 && !slices.Contains(step.Dialects, r.c.dialect()) {
			continue
		}
		if step.SQL != "" {
			if err := execBehaviorStep(r.c.ctx, r.raw, step); err != nil {
				return err
			}
			continue
		}
		got, err := r.value(step.Query)
		if err != nil {
			return err
		}
		if got != step.Want {
			return fmt.Errorf("%s: got %q, want %q", step.Query, got, step.Want)
		}
	}
	return nil
}

// foreignKeys checks on SQLite that no row violates a foreign key.
func (r planRun) foreignKeys(sqlite bool) error {
	if !sqlite {
		return nil
	}
	violations, err := r.value("SELECT COUNT(*) FROM pragma_foreign_key_check")
	if err != nil {
		return err
	}
	if violations != "0" {
		return fmt.Errorf("foreign_key_check returns %s rows", violations)
	}
	return nil
}

// schemaIs checks that the public Introspect reads the schema text want, with nothing unsupported; an empty database has
// the empty text.
func (r planRun) schemaIs(what, want string) error {
	document, unsupported, err := dbspec.Introspect(r.c.ctx, r.raw, r.dialect, "introspected")
	if err != nil {
		return fmt.Errorf("%s: introspect: %w", what, err)
	}
	if len(unsupported) > 0 {
		return fmt.Errorf("%s: unsupported objects %+v", what, unsupported)
	}
	got := ""
	if len(document.Tables) > 0 {
		manifest, diagnostics := dbspec.ManifestOf([]*dbspec.Document{document})
		if len(diagnostics) > 0 {
			return fmt.Errorf("%s: the manifest of the result: %v", what, diagnostics)
		}
		got = manifest.SchemaText
	}
	if got != want {
		return fmt.Errorf("%s: the schema text differs\n--- want\n%s--- got\n%s", what, want, got)
	}
	return nil
}
