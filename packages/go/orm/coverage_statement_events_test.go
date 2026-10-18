//go:build featurecoverage

package orm_test

import (
	"os"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageStatementEvents runs on the database that the feature check selected (ORM_FEATURE_DATABASE)
// all cases of tests/events/vectors.json, each in a new case database, and compares them with the expected events
// The bench database is neither read nor written.
func TestCoverageStatementEvents(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver := os.Getenv("ORM_FEATURE_DATABASE")
	if !slices.Contains([]string{"mysql", "postgres", "sqlite"}, driver) {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check, which sets it for each coverage case")
	}
	runEventCases(t, driver, false)
}
