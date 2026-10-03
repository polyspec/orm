//go:build featurecoverage

package model_test

import (
	"os"
	"testing"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

func TestCoverageGeneratedModelConnection(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn := os.Getenv("ORM_FEATURE_DATABASE"), os.Getenv("ORM_FEATURE_DSN")
	if dsn == "" || (driver != "mysql" && driver != "postgres" && driver != "sqlite") {
		t.Fatal("selected database and DSN are required")
	}
	db, err := model.Connect(dsn, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	if db.Driver() != driver {
		t.Fatalf("model connected to %s, want %s", db.Driver(), driver)
	}
	if _, err := model.Author().Connect(db).GetCount(); err != nil {
		t.Fatal(err)
	}
}
