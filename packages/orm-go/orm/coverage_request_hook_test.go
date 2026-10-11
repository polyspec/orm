//go:build featurecoverage

package orm_test

import (
	"os"
	"slices"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// request_hook coverage: feature-check가 고른 database(ORM_FEATURE_DATABASE)에서 공유 case 하나를
// 그 case만의 새 case database로 실행한다. ORM_FEATURE_DSN의 database는 읽거나 쓰지 않는다.
func runRequestHookCoverage(t *testing.T, id string) {
	testcase.Start(t, testcase.Database)
	driver := os.Getenv("ORM_FEATURE_DATABASE")
	if !slices.Contains([]string{"mysql", "postgres", "sqlite"}, driver) {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check, which sets it for each coverage case")
	}
	for _, c := range requestHookCases {
		if c.id == id {
			db, e := hookFixture(t, newDatabase(t, driver))
			c.run(t, db, e)
			return
		}
	}
	t.Fatalf("request hook case %s is not declared", id)
}

func TestCoverageRequestHookWithoutHook(t *testing.T) { runRequestHookCoverage(t, "without_hook") }

func TestCoverageRequestHookReadFilter(t *testing.T) { runRequestHookCoverage(t, "read_filter") }

func TestCoverageRequestHookInsertAssign(t *testing.T) { runRequestHookCoverage(t, "insert_assign") }

func TestCoverageRequestHookLoadedRowWrites(t *testing.T) {
	runRequestHookCoverage(t, "loaded_row_writes")
}

func TestCoverageRequestHookInvalidParam(t *testing.T) { runRequestHookCoverage(t, "invalid_param") }
