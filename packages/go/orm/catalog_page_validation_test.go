package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-121.
func TestCatalogPageRejectsChangedDescriptors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	before := CatalogTableMetadata{
		Table:      CatalogTableRef{Namespace: "main", Name: "page_probe"},
		Columns:    []CatalogColumn{{Name: "id", NativeType: "INTEGER"}},
		PrimaryKey: []string{"id"}, ReliableRowIdentity: true,
	}
	changed := before
	changed.Columns = []CatalogColumn{{Name: "id", NativeType: "INTEGER", Nullable: true}}
	if sameDescriptor(before, changed) {
		t.Fatal("a changed column nullability matched the original descriptor")
	}
	if err := catalogSameNames([]string{"renamed"}, before.Columns); ErrorCode(err) != catalogCodePageChanged {
		t.Fatalf("prepared column name mismatch error = %v, want %s", err, catalogCodePageChanged)
	}
}
