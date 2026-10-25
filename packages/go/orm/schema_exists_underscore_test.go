package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-57.
func TestSchemaExistsEscapesUnderscoreSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := newDatabase(t, "sqlite")
	raw := openRaw(t, "sqlite", dsn)
	defer testcase.Close(t, raw)
	if _, err := raw.Exec(`CREATE TABLE "fooXbar__schema_probe" (id INTEGER)`); err != nil {
		t.Fatal(err)
	}

	db, err := orm.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	if got, err := db.Utils().Schema().Exists("foo_bar"); err != nil || got {
		t.Fatalf("exists(foo_bar) = %v, %v; underscore must be literal", got, err)
	}
	if got, err := db.Utils().Schema().Exists("fooXbar"); err != nil || !got {
		t.Fatalf("exists(fooXbar) = %v, %v; exact prefix must be found", got, err)
	}
}
