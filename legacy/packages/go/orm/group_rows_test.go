package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/testcase"
)

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

// TestGroupRowDriverCellForms reads the forms of a count that only a driver cell holds: a text, a float, and a repeated column. The
// answer of a listener holds none of them, since its count is a JSON number and its row a JSON object (PRT-69), so the collection
// recipe cannot write them (FCV-2). Requirements: INT-68, INT-90.
func TestGroupRowDriverCellForms(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, count := range []any{"three", "-1", "00", "+1", "", "9007199254740992", float64(1.5), float64(-1), float64(9007199254740992)} {
		if _, err := newGroupRow([]groupValue{{name: "row_count", value: count}}); ErrorCode(err) != CodeCodecDecode {
			t.Errorf("invalid row_count %#v error = %v, want %s", count, err, CodeCodecDecode)
		}
	}
	for _, tc := range []struct {
		input any
		want  int64
	}{{"0", 0}, {"9007199254740991", 9007199254740991}, {float64(3), 3}, {float64(9007199254740991), 9007199254740991}} {
		row, err := newGroupRow([]groupValue{{name: "row_count", value: tc.input}})
		if err != nil || row.Count() != tc.want || row.ToArray()["row_count"] != tc.want {
			t.Errorf("row_count %#v assembled as %#v, %v; want %d", tc.input, row.ToArray(), err, tc.want)
		}
	}
	if _, err := newGroupRow([]groupValue{{name: "row_count", value: int64(1)}, {name: "row_count", value: int64(2)}}); ErrorCode(err) != CodeConfig {
		t.Fatalf("repeated row_count error = %v, want %s", err, CodeConfig)
	}
}
