package orm_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
)

// ddlRenderVectors is tests/dbspec/ddl.json: the rendered statements of each vector and its behavior steps.
type ddlRenderVectors struct {
	Version int `json:"version"`
	Cases   []struct {
		ID         string              `json:"id"`
		Statements map[string][]string `json:"statements"`
		Behavior   []ddlRenderStep     `json:"behavior"`
	} `json:"cases"`
}

// ddlRenderStep runs sql, which must succeed or, with fails, fail; or runs query, whose first value must equal want.
// Dialects limits the step to the dialects it names.
type ddlRenderStep struct {
	SQL      string   `json:"sql"`
	Fails    bool     `json:"fails"`
	Query    string   `json:"query"`
	Want     string   `json:"want"`
	Dialects []string `json:"dialects"`
}

// renderConnectionRules are the statements every client runs on a new connection (docs/spec/dbspec.md "Types",
// docs/spec/dialects.md "Foreign keys").
var renderConnectionRules = map[string][]string{
	"mysql":    {"SET time_zone = '+00:00'"},
	"postgres": {"SET TimeZone = 'UTC'"},
	"sqlite":   {"PRAGMA foreign_keys = ON"},
}

// TestDBSpecRenderPhysical runs the rendered statements of every vector of tests/dbspec/ddl.json that has behavior steps on
// a fresh case database of MySQL, PostgreSQL and SQLite, then runs its steps through database/sql. Each case database is
// created by testdb.New, which fails naming ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN when it is unset.
// Requirement: DIA-113 (check-recipes CR16-1-6).
func TestDBSpecRenderPhysical(t *testing.T) {
	testcase.Group(t)
	raw, err := os.ReadFile("../../../tests/dbspec/ddl.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors ddlRenderVectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.Version != 1 || len(vectors.Cases) == 0 {
		t.Fatalf("tests/dbspec/ddl.json has version %d and %d cases", vectors.Version, len(vectors.Cases))
	}
	for _, c := range vectors.Cases {
		if len(c.Behavior) == 0 {
			continue
		}
		for _, db := range []string{"mysql", "postgres", "sqlite"} {
			t.Run(db+"/"+c.ID, func(t *testing.T) {
				testcase.Start(t, testcase.Database)
				statements := c.Statements[db]
				if len(statements) == 0 {
					t.Fatalf("%s has no %s statements", c.ID, db)
				}
				conn := openRenderDatabase(t, db)
				for _, rule := range renderConnectionRules[db] {
					mustExec(t, conn, rule)
				}
				for _, statement := range statements {
					mustExec(t, conn, statement)
				}
				runRenderSteps(t, conn, db, c.Behavior)
			})
		}
	}
}

// openRenderDatabase creates the case database of the driver and returns a handle to it, closed when the test ends.
func openRenderDatabase(t *testing.T, driver string) *sql.DB {
	t.Helper()
	dsn := testdb.New(t, driver)
	conn := testdb.Open(t, driver, dsn)
	t.Cleanup(func() { testcase.Close(t, conn) })
	return conn
}

// mustExec runs one statement and fails the test when it does not succeed.
func mustExec(t *testing.T, conn *sql.DB, statement string) {
	t.Helper()
	if _, err := conn.Exec(statement); err != nil {
		t.Fatalf("%s: %v", statement, err)
	}
}

// runRenderSteps runs the steps of one vector on the database of driver db.
func runRenderSteps(t *testing.T, conn *sql.DB, db string, steps []ddlRenderStep) {
	t.Helper()
	for _, step := range steps {
		if len(step.Dialects) > 0 && !slices.Contains(step.Dialects, db) {
			continue
		}
		if step.SQL != "" {
			_, err := conn.Exec(step.SQL)
			if step.Fails {
				if err == nil {
					t.Fatalf("%s: %s must fail", db, step.SQL)
				}
				continue
			}
			if err != nil {
				t.Fatalf("%s: %s: %v", db, step.SQL, err)
			}
			continue
		}
		var got sql.NullString
		if err := conn.QueryRow(step.Query).Scan(&got); err != nil {
			t.Fatalf("%s: %s: %v", db, step.Query, err)
		}
		if got.String != step.Want {
			t.Fatalf("%s: %s: got %q, want %q", db, step.Query, got.String, step.Want)
		}
	}
}
