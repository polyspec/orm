package orm_test

import (
	"database/sql"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/engine/runtimemodel"
)

// TestMySQLInstallInsideTransaction rejects a MySQL install in a transaction,
// where the implicit commit of schema statements would end the transaction.
func TestMySQLInstallInsideTransaction(t *testing.T) {
	dsn := requireDSN(t, "ORM_TEST_MYSQL_DSN")
	s := fixtureSchema(t, "zone")
	manifest := s
	db, err := orm.ConnectSchema(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	dropTable(t, "mysql", dsn, "zone_event")
	defer dropTable(t, "mysql", dsn, "zone_event")
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
// content even without objects, and an installed table is content. The MySQL
// and PostgreSQL databases are created for the test, because the Go test
// packages run in parallel against the databases that ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN name.
func TestSchemaEmpty(t *testing.T) {
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

// TestInstallAppliesRenderedStatements는 dbspec document set을 연결의
// dialect로 render한 statement를 적용하는지 확인한다. 두 번째 install은 아무것도
// 바꾸지 않고, set의 table이 일부만 있으면 CONFIG다.
func TestInstallAppliesRenderedStatements(t *testing.T) {
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
			// render된 trigger가 database에 있으면 statement가 적용된 것이다.
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
