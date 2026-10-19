package orm_test

import (
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestMySQLInstallInsideTransaction rejects a MySQL install in a transaction,
// where the implicit commit of schema statements would end the transaction.
func TestMySQLInstallInsideTransaction(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := newDatabase(t, "mysql")
	s := fixtureSchema(t, "zone")
	manifest := s
	db, err := orm.ConnectSchema(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var inside error
	if err := db.Transaction(func() error {
		inside = db.Utils().Schema().Install(manifest)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if orm.ErrorCode(inside) != orm.CodeConfig {
		t.Fatalf("install inside a transaction = %v, want CONFIG", inside)
	}
	if err := db.Utils().Schema().Install(manifest); err != nil {
		t.Fatal(err)
	}
	if ok, err := db.Utils().Schema().Installed(dbName(t, dsn), "zone_event"); err != nil || !ok {
		t.Fatalf("installed = %v %v", ok, err)
	}
}

// TestSchemaEmpty checks Utils().Schema().Empty() on a new database of each
// dialect: the new database is empty, a PostgreSQL schema other than public is
// content even without objects, and an installed table is content. Each
// dialect gets a case database of its own (internal/testdb), because the
// databases that ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name are shared
// and may hold tables of other runs.
func TestSchemaEmpty(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "zone")
	manifest := s
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			dsn := newDatabase(t, driver)
			db, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			expect := func(want bool, state string) {
				t.Helper()
				if got, err := db.Utils().Schema().Empty(); err != nil || got != want {
					t.Fatalf("empty() with %s = %v %v, want %v", state, got, err, want)
				}
			}
			expect(true, "a new database")
			if driver == "postgres" {
				raw := openNative(t, driver, dsn)
				defer raw.Close()
				if _, err := raw.Exec("CREATE SCHEMA unowned_empty"); err != nil {
					t.Fatal(err)
				}
				expect(false, "an empty schema other than public")
				if _, err := raw.Exec("DROP SCHEMA unowned_empty"); err != nil {
					t.Fatal(err)
				}
				expect(true, "the empty schema dropped")
			}
			if err := db.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}
			expect(false, "an installed table")
		})
	}
}

func dbName(t *testing.T, dsn string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimPrefix(u.Path, "/")
}

// TestInstallAppliesRenderedStatements checks that the statements rendered for the dbspec document set
// in the connection's dialect are applied. The second install changes nothing,
// and if only some of the set's tables exist, it is CONFIG.
func TestInstallAppliesRenderedStatements(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := fixtureSchema(t, "audit")
	m, diagnostics := runtimemodel.Load(s.Text)
	if len(diagnostics) > 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			start := time.Now()
			t.Logf("start %s", driver)
			defer func() { t.Logf("end %s in %s", driver, time.Since(start)) }()
			dsn := newDatabase(t, driver)
			db, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			for i := 0; i < 2; i++ {
				if err := db.Utils().Schema().Install(s); err != nil {
					t.Fatalf("install %d: %v", i+1, err)
				}
			}
			statements, diagnostics := dbspec.Render(m.Documents, dbspec.Dialect(driver))
			if len(diagnostics) > 0 {
				t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
			}
			var raw *sql.DB
			if driver == "sqlite" {
				if raw, err = sql.Open("sqlite", strings.TrimPrefix(dsn, "sqlite://")); err != nil {
					t.Fatal(err)
				}
			} else {
				raw = openNative(t, driver, dsn)
			}
			defer raw.Close()
			// If the rendered trigger exists in the database, the statement was applied.
			query := map[string]string{
				"sqlite":   "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'",
				"mysql":    "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()",
				"postgres": "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = current_schema()",
			}[driver]
			var triggers int
			if err := raw.QueryRow(query).Scan(&triggers); err != nil {
				t.Fatal(err)
			}
			want := 0
			for _, statement := range statements {
				if strings.HasPrefix(statement, "CREATE TRIGGER") {
					want++
				}
			}
			if want != 3 || triggers != want {
				t.Fatalf("triggers = %d, rendered %d, want 3", triggers, want)
			}
			if _, err := raw.Exec(map[string]string{"mysql": "DROP TABLE `item_history`"}[driver] + map[string]string{"sqlite": `DROP TABLE "item_history"`, "postgres": `DROP TABLE "item_history"`}[driver]); err != nil {
				t.Fatal(err)
			}
			if err := db.Utils().Schema().Install(s); orm.ErrorCode(err) != orm.CodeConfig {
				t.Fatalf("install over a partly installed set = %v, want CONFIG", err)
			}
		})
	}
}

// changedDatabase is contracts/fixtures/install/changed_database.json. For each case, the document is
// changed with a statement from outside the ORM on the database where the set was installed; then installing the same set gives, for each dialect, a message
// that is CONFIG, and the remaining query reads the changed database.
type changedDatabase struct {
	Feature string `json:"feature"`
	Cases   []struct {
		ID        string `json:"id"`
		Operation string `json:"operation"`
		Document  string `json:"document"`
		Statement string `json:"statement"`
		Remaining string `json:"remaining"`
		Expected  struct {
			Code    string            `json:"code"`
			Message map[string]string `json:"message"`
		} `json:"expected"`
	} `json:"cases"`
}

// TestInstallVerifiesTheDatabase checks that install compares the whole database, not only the table names,
// with the set (docs/spec/schema.md "Schema installation"). Installing the same set again on a database changed outside the ORM
// gives CONFIG that carries the differences, and the database is left as it is.
func TestInstallVerifiesTheDatabase(t *testing.T) {
	testcase.Start(t, testcase.Database)
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "install", "changed_database.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture changedDatabase
	if err := json.Unmarshal(text, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("contracts/fixtures/install/changed_database.json has no cases")
	}
	for _, c := range fixture.Cases {
		if c.Operation != "install" {
			t.Fatalf("case %s has the operation %s, want install", c.ID, c.Operation)
		}
		s := fixtureSchema(t, strings.TrimSuffix(c.Document, ".dbs"))
		t.Run(c.ID, func(t *testing.T) {
			for _, driver := range []string{"sqlite", "mysql", "postgres"} {
				func() {
					t.Logf("driver %s", driver)
					dsn := newDatabase(t, driver)
					db, err := orm.Connect(dsn, orm.Config{})
					if err != nil {
						t.Fatal(err)
					}
					defer db.Close()
					if err := db.Utils().Schema().Install(s); err != nil {
						t.Fatalf("install: %v", err)
					}
					var raw *sql.DB
					if driver == "sqlite" {
						if raw, err = sql.Open("sqlite", strings.TrimPrefix(dsn, "sqlite://")); err != nil {
							t.Fatal(err)
						}
					} else {
						raw = openNative(t, driver, dsn)
					}
					defer raw.Close()
					if _, err := raw.Exec(c.Statement); err != nil {
						t.Fatal(err)
					}
					want := c.Expected.Code + ": " + c.Expected.Message[driver]
					err = db.Utils().Schema().Install(s)
					if orm.ErrorCode(err) != c.Expected.Code || err.Error() != want {
						t.Fatalf("install over the changed database = %v, want %s", err, want)
					}
					if _, err := raw.Exec(c.Remaining); err != nil {
						t.Fatalf("%s: the rejected install changed the database: %v", driver, err)
					}
				}()
			}
		})
	}
}
