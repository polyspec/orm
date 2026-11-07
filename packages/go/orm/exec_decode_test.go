package orm

import (
	"math"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-98a.
func TestDecodeSelectedRowRejectsInvalidRuntimeScalars(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, tc := range []struct {
		name  string
		type_ string
		value any
		want  string
	}{
		{name: "sqlite text i64", type_: "i64", value: "not-an-integer", want: "CODEC_DECODE: typed_value.value: i64 cell is not an exact integer in its range"},
		{name: "mysql unsigned overflow", type_: "i64", value: uint64(math.MaxUint64), want: "CODEC_DECODE: typed_value.value: i64 cell is not an exact integer in its range"},
		{name: "postgres non-finite float", type_: "f64", value: math.NaN(), want: "CODEC_DECODE: typed_value.value: f64 cell is not a finite number"},
		{name: "invalid bool", type_: "bool", value: int64(2), want: "CODEC_DECODE: typed_value.value: bool cell is not boolean"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			step := &plan.Step{Assemble: &plan.Assemble{Entity: "typed_value", Columns: []plan.OutCol{{Index: 0, Name: "value", Column: "value", Type: tc.type_}}}}
			err := decodeSelectedRow([]any{tc.value}, &scanInfo{}, step, AESKeyring{})
			if err == nil || err.Error() != tc.want {
				t.Fatalf("invalid %s cell error = %v, want %s", tc.name, err, tc.want)
			}
		})
	}
	step := &plan.Step{Assemble: &plan.Assemble{Entity: "typed_value", Columns: []plan.OutCol{
		{Index: 0, Name: "wide", Column: "wide", Type: "i64"}, {Index: 1, Name: "ratio", Column: "ratio", Type: "f64"},
		{Index: 2, Name: "active", Column: "active", Type: "bool"},
	}}}
	if err := decodeSelectedRow([]any{int64(7), float64(1.25), true}, &scanInfo{}, step, AESKeyring{}); err != nil {
		t.Fatalf("valid scalar cells failed decoding: %v", err)
	}
}
