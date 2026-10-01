//go:build featurecoverage

package orm

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
)

func TestCoverageDSNConnection(t *testing.T) {
	driver, dsn := os.Getenv("ORM_FEATURE_DATABASE"), os.Getenv("ORM_FEATURE_DSN")
	if dsn == "" || (driver != "mysql" && driver != "postgres" && driver != "sqlite") {
		t.Fatal("selected database and DSN are required")
	}
	parsed, err := DriverFromDSN(dsn)
	if err != nil || parsed != driver {
		t.Fatalf("DSN driver: %s, %v; want %s", parsed, err, driver)
	}
	if _, err := DriverFromDSN("invalid://database"); err == nil {
		t.Fatal("unsupported DSN scheme was accepted")
	}
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "schema", "bench.dbspec"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := Connect(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	if db.Driver() != driver {
		t.Fatalf("connected to %s, want %s", db.Driver(), driver)
	}
}
