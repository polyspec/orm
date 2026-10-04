//go:build featurecoverage

package orm_test

import (
	"os"
	"slices"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// TestCoverageStatementEvents는 feature-check가 고른 database(ORM_FEATURE_DATABASE)에서
// tests/events/vectors.json의 모든 case를 case마다 새 case database로 실행하고 기대 event와
// 비교한다. bench database는 읽거나 쓰지 않는다.
func TestCoverageStatementEvents(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver := os.Getenv("ORM_FEATURE_DATABASE")
	if !slices.Contains([]string{"mysql", "postgres", "sqlite"}, driver) {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required")
	}
	runEventCases(t, driver)
}
