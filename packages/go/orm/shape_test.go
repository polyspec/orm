package orm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestShapeIgnoresParamValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	a := &request{}
	b := &request{}
	for _, r := range []*request{a, b} {
		r.ir.Kind = "all"
		r.ir.Entity = "author"
		i := r.param(int64(len(r.params)))
		r.ir.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "seq", Op: "eq", P: &i}}}}
	}
	a.params[0], b.params[0] = int64(1), int64(2)
	if shapeKey(&a.ir) != shapeKey(&b.ir) {
		t.Error("different param values must share a shape")
	}
}

// Requirements: INT-143.
func TestPlanIDFixedWidthLowercaseHex(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, tc := range []struct {
		key  uint64
		want string
	}{
		{key: 0, want: "0000000000000000"},
		{key: 0x1f, want: "000000000000001f"},
		{key: ^uint64(0), want: "ffffffffffffffff"},
	} {
		if got := PlanID(tc.key); got != tc.want {
			t.Errorf("PlanID(%#x) = %q, want %q", tc.key, got, tc.want)
		}
	}
}

// TestInsertPartsFixture checks that the row count of each shared case in contracts/fixtures/insert_parts.json
// divides into the same batches as its batch size (docs/spec/protocol.md multi-row insert).
// Requirements: PLN-44.
func TestInsertPartsFixture(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "insert_parts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []struct {
			ID        string `json:"id"`
			Operation string `json:"operation"`
			Input     struct {
				Rows  int `json:"rows"`
				Batch int `json:"batch"`
			} `json:"input"`
			Expected []int `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(text, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("insert_parts.json has no cases")
	}
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			if c.Operation != "insert_parts" {
				t.Fatalf("unknown operation %q", c.Operation)
			}
			got := insertParts(c.Input.Rows, c.Input.Batch)
			if !slices.Equal(got, c.Expected) {
				t.Errorf("parts %v, want %v", got, c.Expected)
			}
		})
	}
}
