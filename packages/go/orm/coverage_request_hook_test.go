//go:build featurecoverage

package orm_test

import (
	"os"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// request_hook coverage: runs one shared case on the database that the feature check selected (ORM_FEATURE_DATABASE)
// in a new case database used only by that case. It neither reads nor writes the database of ORM_FEATURE_DSN.
func runRequestHookCoverage(t *testing.T, id string) {
	driver := os.Getenv("ORM_FEATURE_DATABASE")
	if !slices.Contains([]string{"mysql", "postgres", "sqlite"}, driver) {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check, which sets it for each coverage case")
	}
	for _, c := range requestHookCases {
		if c.id == id {
			db, e, entry := hookFixture(t, newDatabase(t, driver))
			c.run(t, db, e, entry)
			return
		}
	}
	t.Fatalf("request hook case %s is not declared", id)
}

func TestCoverageRequestHookWithoutHook(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "without_hook")
}

func TestCoverageRequestHookReadFilter(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "read_filter")
}

func TestCoverageRequestHookInsertAssign(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "insert_assign")
}

func TestCoverageRequestHookLoadedRowWrites(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "loaded_row_writes")
}

func TestCoverageRequestHookInvalidParam(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "invalid_param")
}

func TestCoverageRequestHookRestoreKey(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_key")
}

func TestCoverageRequestHookRestoreCondition(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_condition")
}

func TestCoverageRequestHookRestoreNoKey(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_no_key")
}

func TestCoverageRequestHookRestoreRewrittenKey(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_rewritten_key")
}

func TestCoverageRequestHookRestoreHookSetKey(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_hook_set_key")
}

func TestCoverageRequestHookRestoreRewrittenKeySetScope(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_rewritten_key_set_scope")
}
