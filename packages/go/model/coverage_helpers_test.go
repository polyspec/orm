//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/testdb"
)

// featureDatabase is the database and DSN that the feature coverage checker chose.
// If either one is missing, the test fails.
func featureDatabase(t *testing.T) (string, string) {
	t.Helper()
	return testdb.FeatureDatabase(t)
}
