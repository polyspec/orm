//go:build featurecoverage

package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: CFG-1.
func TestCoverageDSNConnection(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn := testdb.FeatureDatabase(t)
	parsed, err := DriverFromDSN(dsn)
	if err != nil || parsed != driver {
		t.Fatalf("DSN driver: %s, %v; want %s", parsed, err, driver)
	}
	if _, err := DriverFromDSN("invalid://database"); err == nil {
		t.Fatal("unsupported DSN scheme was accepted")
	}
	db := openBench(t, dsn)
	defer testcase.Close(t, db)
	if db.Driver() != driver {
		t.Fatalf("connected to %s, want %s", db.Driver(), driver)
	}
}
