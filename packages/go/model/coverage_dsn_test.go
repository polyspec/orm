//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: CFG-1.
func TestCoverageGeneratedModelConnection(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn := testdb.FeatureDatabase(t)
	db, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	if db.Driver() != driver {
		t.Fatalf("model connected to %s, want %s", db.Driver(), driver)
	}
	if _, err := model.Author().Connect(db).GetCount(); err != nil {
		t.Fatal(err)
	}
}
