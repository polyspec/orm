package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-121.
// TestCatalogPagePreparedColumnsDifferFromTheDescriptor holds what no server can answer (INT-121): a statement names its
// columns in the select list, and a server answers with those names.
func TestCatalogPagePreparedColumnsDifferFromTheDescriptor(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	columns := []CatalogColumn{{Name: "id", NativeType: "INTEGER"}}
	if err := catalogSameNames([]string{"renamed"}, columns); ErrorCode(err) != catalogCodePageChanged {
		t.Fatalf("prepared column name mismatch error = %v, want %s", err, catalogCodePageChanged)
	}
	if err := catalogSameNames([]string{"id", "extra"}, columns); ErrorCode(err) != catalogCodePageChanged {
		t.Fatalf("prepared column count mismatch error = %v, want %s", err, catalogCodePageChanged)
	}
	if err := catalogSameNames([]string{"id"}, columns); err != nil {
		t.Fatalf("the same names were refused: %v", err)
	}
}
