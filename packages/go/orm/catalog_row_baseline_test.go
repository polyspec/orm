package orm

import (
	"math"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-107.
func TestCatalogRowBaselineComparesExactTypedValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, test := range []struct {
		name  string
		left  any
		right any
	}{
		{name: "float bits", left: float64(0), right: math.Copysign(0, -1)},
		{name: "decimal scale", left: "100.23000", right: "100.23"},
		{name: "binary bytes", left: []byte{0, 255}, right: []byte{0, 254}},
		{name: "boolean and integer", left: false, right: int64(0)},
	} {
		t.Run(test.name, func(t *testing.T) {
			equal, err := catalogSameRow([]any{test.left}, []any{test.right})
			if err != nil || equal {
				t.Fatalf("catalogSameRow(%#v, %#v) = %v, %v; want unequal typed values", test.left, test.right, equal, err)
			}
		})
	}

	page := CatalogTablePage{
		Metadata: CatalogTableMetadata{
			Table: CatalogTableRef{Namespace: "main", Name: "computed_values"},
			Kind:  CatalogKindTable,
			Columns: []CatalogColumn{
				{Name: "id", NativeType: "INTEGER"},
				{Name: "value", NativeType: "TEXT"},
				{Name: "value_length", NativeType: "INTEGER", Generated: true},
			},
			PrimaryKey: []string{"id"}, ReliableRowIdentity: true,
		},
		Result: CatalogResult{
			Columns: []CatalogColumn{
				{Name: "id", NativeType: "INTEGER"},
				{Name: "value", NativeType: "TEXT"},
				{Name: "value_length", NativeType: "INTEGER", Generated: true},
			},
			Rows: [][]any{{int64(1), "four", int64(4)}},
		},
		Limit: 1, OrderBy: []string{"id"},
	}
	original, err := CatalogSnapshotFromPage(page, 0)
	if err != nil || original.cells[2] != int64(4) {
		t.Fatalf("generated-column original = %#v, err %v; want 4", original.cells, err)
	}
	changed := page
	changed.Result.Rows = [][]any{{int64(1), "changed", int64(7)}}
	if original.revision == "" || original.revision == mustCatalogRevision(t, changed.Metadata, changed.Result.Rows[0]) {
		t.Fatal("a changed generated-column original did not change the row revision")
	}
}

func mustCatalogRevision(t *testing.T, metadata CatalogTableMetadata, cells []any) string {
	t.Helper()
	revision, err := catalogRevision(metadata, cells)
	if err != nil {
		t.Fatal(err)
	}
	return revision
}
