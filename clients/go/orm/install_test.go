package orm_test

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

// TestMySQLInstallInsideTransaction rejects a MySQL install in a transaction,
// where the implicit commit of schema statements would end the transaction.
func TestMySQLInstallInsideTransaction(t *testing.T) {
	dsn := requireDSN(t, "ORM_TEST_MYSQL_DSN")
	d, err := schema.Parse(zoneSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.New(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open(dsn, eng, orm.Config{})
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
	d, err := schema.Parse(zoneSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			dsn := newDatabase(t, driver)
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			db, err := orm.Open(dsn, eng, orm.Config{})
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
