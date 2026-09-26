package orm

import (
	"reflect"
	"testing"

	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/schema"
)

func TestGroupRowsRejectInvalidCountsAndPreserveSelectedValues(t *testing.T) {
	for _, tc := range []struct {
		name   string
		values []groupValue
	}{
		{"missing count", []groupValue{{name: "is_close", value: false}}},
		{"invalid count", []groupValue{{name: "row_count", value: "three"}}},
		{"boolean count", []groupValue{{name: "row_count", value: true}}},
		{"negative count", []groupValue{{name: "row_count", value: int64(-1)}}},
		{"duplicate column", []groupValue{{name: "row_count", value: int64(1)}, {name: "row_count", value: int64(2)}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := newGroupRow(tc.values); err == nil {
				t.Fatal("invalid grouped row accepted")
			}
		})
	}
	row, err := newGroupRow([]groupValue{{name: "is_close", value: false}, {name: "row_count", value: int64(3)}})
	if err != nil {
		t.Fatal(err)
	}
	if row.Count() != 3 {
		t.Fatalf("count = %d", row.Count())
	}
	if value, err := row.Value("is_close"); err != nil || value != false {
		t.Fatalf("group value = %#v, error = %v", value, err)
	}
	if _, err := row.Value("name"); ErrorCode(err) != CodeColumnUnselected {
		t.Fatalf("unselected group value error = %v", err)
	}
	nullRow, err := newGroupRow([]groupValue{{name: "nullable", value: nil}, {name: "row_count", value: int64(1)}})
	if err != nil {
		t.Fatal(err)
	}
	if value, err := nullRow.Value("nullable"); err != nil || value != nil {
		t.Fatalf("selected SQL NULL = %#v, error = %v", value, err)
	}
	rows := &GroupRows{rows: []GroupRow{row}}
	if want := []map[string]any{{"is_close": false, "row_count": int64(3)}}; !reflect.DeepEqual(rows.ToArray(), want) {
		t.Fatalf("group rows = %#v, want %#v", rows.ToArray(), want)
	}
}

func TestGroupColumnValueChecksDeclaredType(t *testing.T) {
	column := plan.OutCol{Name: "is_close", Column: "is_close", Type: "bool"}
	declared := &schema.Col{Name: "is_close", Type: "bool"}
	for raw, want := range map[any]bool{int64(0): false, int64(1): true} {
		got, err := groupColumnValue(nil, nil, column, declared, raw)
		if err != nil || got != want {
			t.Fatalf("boolean group value %#v = %#v, %v", raw, got, err)
		}
	}
	for _, raw := range []any{int64(2), "invalid", nil} {
		if _, err := groupColumnValue(nil, nil, column, declared, raw); err == nil {
			t.Fatalf("invalid boolean group value %#v accepted", raw)
		}
	}
	count := plan.OutCol{Name: "row_count", Type: "i64"}
	if _, err := groupColumnValue(nil, nil, count, nil, true); err == nil {
		t.Fatal("boolean row count accepted")
	}
}

func TestGroupColumnDeclarationRejectsMissingAndDuplicateCount(t *testing.T) {
	for _, columns := range [][]plan.OutCol{
		{{Name: "is_close"}},
		{{Name: "row_count"}, {Name: "row_count"}},
	} {
		if err := validateGroupColumns(columns); err == nil {
			t.Fatalf("invalid group declaration accepted: %#v", columns)
		}
	}
	if err := validateGroupColumns([]plan.OutCol{{Name: "is_close"}, {Name: "row_count"}}); err != nil {
		t.Fatal(err)
	}
}
