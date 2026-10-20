//go:build featurecoverage

package testdb

import (
	"os"
	"testing"
)

// FeatureDatabase returns the database and DSN that the feature coverage checker
// selected through ORM_FEATURE_DATABASE and ORM_FEATURE_DSN. If either one is
// missing, or the database is not mysql, postgres or sqlite, the test fails.
func FeatureDatabase(t testing.TB) (string, string) {
	t.Helper()
	driver, dsn := os.Getenv("ORM_FEATURE_DATABASE"), os.Getenv("ORM_FEATURE_DSN")
	if dsn == "" || (driver != "mysql" && driver != "postgres" && driver != "sqlite") {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) and ORM_FEATURE_DSN are required")
	}
	return driver, dsn
}
