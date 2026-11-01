//go:build featurecoverage

package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageStatementRunner runs the statement runner case of statement_runner_test.go on the database that the feature
// check selected (ORM_FEATURE_DATABASE), each in a new case database. The bench database is neither read nor written.
// Requirements: INT-150.
func TestCoverageStatementRunner(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, _ := featureDatabase(t)
	statementRunnerCase(t, driver)
}
