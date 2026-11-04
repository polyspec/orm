package orm_test

import (
	"net/url"
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
