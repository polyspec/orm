package orm

import (
	"math"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestDecodeSelectedRowRejectsInvalidRuntimeScalars(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, tc := range []struct {
		name  string
		type_ string
		value any
	}{
		{name: "sqlite text i64", type_: "i64", value: "not-an-integer"},
		{name: "mysql unsigned overflow", type_: "i64", value: uint64(math.MaxUint64)},
		{name: "postgres non-finite float", type_: "f64", value: math.NaN()},
		{name: "invalid bool", type_: "bool", value: int64(2)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			step := &plan.Step{Assemble: &plan.Assemble{Entity: "typed_value", Columns: []plan.OutCol{{Index: 0, Name: "value", Type: tc.type_}}}}
			err := decodeSelectedRow([]any{tc.value}, &scanInfo{}, step, AESKeyring{})
			if ErrorCode(err) != CodeCodecDecode {
				t.Fatalf("invalid %s cell error = %v, want %s", tc.name, err, CodeCodecDecode)
			}
		})
	}
	step := &plan.Step{Assemble: &plan.Assemble{Entity: "typed_value", Columns: []plan.OutCol{
		{Index: 0, Name: "wide", Type: "i64"}, {Index: 1, Name: "ratio", Type: "f64"}, {Index: 2, Name: "active", Type: "bool"},
	}}}
	if err := decodeSelectedRow([]any{int64(7), float64(1.25), true}, &scanInfo{}, step, AESKeyring{}); err != nil {
		t.Fatalf("valid scalar cells failed decoding: %v", err)
	}
}
