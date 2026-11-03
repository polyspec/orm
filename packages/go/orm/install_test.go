package orm_test

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestMySQLInstallInsideTransaction rejects a MySQL install in a transaction,
// where the implicit commit of schema statements would end the transaction.
// Requirements: INT-55, PLN-44.
func TestMySQLInstallInsideTransaction(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := newDatabase(t, "mysql")
	s := fixtureSchema(t, "zone")
	manifest := s
	db := connectSchemaDB(t, dsn, s)
	defer testcase.Close(t, db)
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

func dbName(t *testing.T, dsn string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimPrefix(u.Path, "/")
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
					defer testcase.Close(t, db)
					if err := db.Utils().Schema().Install(s); err != nil {
						t.Fatalf("install: %v", err)
					}
					raw := openRaw(t, driver, dsn)
					defer testcase.Close(t, raw)
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
