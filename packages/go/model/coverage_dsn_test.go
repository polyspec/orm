package model_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/benchset"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageGeneratedModelConnection connects the generated Go model to a case database of each driver and reads through
// it. The connection itself is the recipe contracts/fixtures/dsn_connection/dsn_connection.json, which every runtime runs
// (FCV-2); only the generated Connect and read of the Go model, which a recipe does not name (T334-3-5-1), are tested here.
// Requirements: CFG-1.
func TestCoverageGeneratedModelConnection(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, driver := range []string{"mysql", "postgres", "sqlite"} {
		t.Run(driver, func(t *testing.T) {
			db, err := model.Connect(testdb.New(t, driver), orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer testcase.Close(t, db)
			if db.Driver() != driver {
				t.Fatalf("model connected to %s, want %s", db.Driver(), driver)
			}
			if err := benchset.Install(db); err != nil {
				t.Fatal(err)
			}
			if count, err := model.Author().Connect(db).GetCount(); err != nil || count != 0 {
				t.Fatalf("author count of a new database = %d, %v", count, err)
			}
		})
	}
}
