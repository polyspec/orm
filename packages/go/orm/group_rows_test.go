package orm

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestGroupRowsRejectInvalidCountsAndPreserveSelectedValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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
	testcase.Start(t, testcase.Compute)
	column := plan.OutCol{Name: "is_close", Column: "is_close", Type: "bool"}
	declared := &runtimemodel.Field{Name: "is_close", Type: "bool"}
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

// TestGroupCountRejectsInvalidStoredBoolean checks PRT-36 at the model result decoder.
func TestGroupCountRejectsInvalidStoredBoolean(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	column := plan.OutCol{Name: "is_close", Column: "is_close", Type: "bool"}
	declared := &runtimemodel.Field{Name: "is_close", Type: "bool"}
	for _, raw := range []any{int64(2), float64(1), "invalid"} {
		_, err := groupColumnValue(nil, nil, column, declared, raw)
		if err == nil || !strings.Contains(err.Error(), fmt.Sprint(raw)) {
			t.Fatalf("invalid boolean group value %#v error = %v", raw, err)
		}
		if !strings.Contains(err.Error(), CodeCodecDecode) {
			t.Fatalf("invalid boolean group value %#v error code = %v", raw, err)
		}
	}
}

// Requirements: PRT-69. The grouped row exposes the selected i64 as an exact integer value.
func TestGroupCountPreservesExactI64Value(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	const want int64 = 9007199254740991
	column := plan.OutCol{Name: "exact_value", Column: "exact_value", Type: "i64"}
	declared := &runtimemodel.Field{Name: "exact_value", Type: "i64"}
	value, err := groupColumnValue(nil, nil, column, declared, want)
	if err != nil || value != want {
		t.Fatalf("decoded i64 group value = %#v, %v; want %d", value, err, want)
	}
	row, err := newGroupRow([]groupValue{{name: "exact_value", value: value}, {name: "row_count", value: int64(1)}})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := row.Value("exact_value"); err != nil || got != want {
		t.Fatalf("assembled i64 group value = %#v, %v; want %d", got, err, want)
	}
}

func TestGroupColumnDeclarationRejectsMissingAndDuplicateCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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

// Requirements: INT-90.
func TestGroupRowNegativeCountIsCodecDecode(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, count := range []any{int64(-1), "-1", float64(-1)} {
		_, err := newGroupRow([]groupValue{{name: "row_count", value: count}})
		if code := ErrorCode(err); code != CodeCodecDecode {
			t.Fatalf("negative count %v: code %s, want %s", count, code, CodeCodecDecode)
		}
	}
}

// Requirements: PRT-69, INT-90. The row count remains an exact nonnegative integer in the grouped result.
func TestGroupRowCountEnforcesExactness(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, count := range []any{true, float64(1.5), int64(-1), int64(9007199254740992), float64(9007199254740992), "9007199254740992"} {
		if _, err := newGroupRow([]groupValue{{name: "row_count", value: count}}); ErrorCode(err) != CodeCodecDecode {
			t.Errorf("invalid row_count %#v error = %v, want %s", count, err, CodeCodecDecode)
		}
	}
	if _, err := newGroupRow([]groupValue{{name: "selected", value: "x"}}); ErrorCode(err) != CodeInternal {
		t.Fatalf("missing row_count error = %v, want %s", err, CodeInternal)
	}
	for _, tc := range []struct {
		input any
		want  int64
	}{{int64(0), 0}, {"0", 0}, {int64(9007199254740991), 9007199254740991}, {"9007199254740991", 9007199254740991}} {
		row, err := newGroupRow([]groupValue{{name: "row_count", value: tc.input}})
		if err != nil || row.Count() != tc.want || row.ToArray()["row_count"] != tc.want {
			t.Errorf("row_count %v assembled as %#v, %v; want %d", tc.input, row.ToArray(), err, tc.want)
		}
	}
}
