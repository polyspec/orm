package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: DIA-29.
// TestCatalogDescribedBool is the table of the bool read: a boolean column is read as a bool by its column type on MySQL
// tinyint(1), on SQLite BOOLEAN and on PostgreSQL boolean; a value of any other column is left as it is, and any value
// other than 0 or 1 of a boolean column fails.
func TestCatalogDescribedBool(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	cases := []struct {
		name    string
		dialect string
		native  string
		value   any
		want    any
		fails   bool
	}{
		{"mysql tinyint(1) zero", "mysql", "tinyint(1)", int64(0), false, false},
		{"mysql tinyint(1) one", "mysql", "tinyint(1)", int64(1), true, false},
		{"mysql tinyint(1) null", "mysql", "tinyint(1)", nil, nil, false},
		{"mysql tinyint(1) two", "mysql", "tinyint(1)", int64(2), nil, true},
		{"mysql plain tinyint stays integer", "mysql", "tinyint", int64(2), int64(2), false},
		{"sqlite BOOLEAN zero", "sqlite", "BOOLEAN", int64(0), false, false},
		{"sqlite BOOLEAN one", "sqlite", "BOOLEAN", int64(1), true, false},
		{"sqlite BOOLEAN minus one", "sqlite", "BOOLEAN", int64(-1), nil, true},
		{"sqlite BOOLEAN text", "sqlite", "BOOLEAN", "1", nil, true},
		{"sqlite integer stays integer", "sqlite", "INTEGER", int64(1), int64(1), false},
		{"postgres boolean bool", "postgres", "boolean", true, true, false},
		{"postgres boolean two", "postgres", "boolean", int64(2), nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			column := CatalogColumn{Name: "b", NativeType: tc.native}
			got, err := catalogDescribedBool(tc.value, column, tc.dialect)
			if tc.fails {
				if err == nil {
					t.Fatalf("catalogDescribedBool(%v) = %v, want an error", tc.value, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("catalogDescribedBool(%v): %v", tc.value, err)
			}
			if got != tc.want {
				t.Fatalf("catalogDescribedBool(%v) = %v (%T), want %v (%T)", tc.value, got, got, tc.want, tc.want)
			}
		})
	}
}
