package model_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

func TestCoverageGeneratedModelConnection(t *testing.T) {
	driver, dsn := os.Getenv("ORM_FEATURE_DATABASE"), os.Getenv("ORM_FEATURE_DSN")
	if dsn == "" || (driver != "mysql" && driver != "postgres" && driver != "sqlite") {
		t.Fatal("selected database and DSN are required")
	}
	path := filepath.Join("..", "..", "..", "schema", "schema.json")
	db, err := model.Connect(dsn, path, orm.Config{})
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
	if _, err := model.Battle().Connect(db).GetCount(); err != nil {
		t.Fatal(err)
	}
}
