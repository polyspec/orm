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

// Requirements: CFG-9.
func TestCoverageRequestHookWithoutHook(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "without_hook")
}

// Requirements: DSL-65, PRT-2.
func TestCoverageRequestHookReadFilter(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "read_filter")
}

// Requirements: PRT-4, PRT-5, PRT-41.
func TestCoverageRequestHookInsertAssign(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "insert_assign")
}

// Requirements: CFG-21, INT-36, INT-37, PLN-16.
func TestCoverageRequestHookLoadedRowWrites(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "loaded_row_writes")
}

// Requirements: PRT-65.
func TestCoverageRequestHookInvalidParam(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "invalid_param")
}

// Requirements: DIA-161.
func TestCoverageRequestHookRestoreKey(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_key")
}

// Requirements: DIA-161, INT-38.
func TestCoverageRequestHookRestoreCondition(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_condition")
}

// Requirements: DIA-161.
func TestCoverageRequestHookRestoreNoKey(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_no_key")
}

// Requirements: DIA-161.
func TestCoverageRequestHookRestoreRewrittenKey(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_rewritten_key")
}

// Requirements: DIA-161.
func TestCoverageRequestHookRestoreHookSetKey(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_hook_set_key")
}

// Requirements: DIA-161.
func TestCoverageRequestHookRestoreRewrittenKeySetScope(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runRequestHookCoverage(t, "restore_rewritten_key_set_scope")
}
