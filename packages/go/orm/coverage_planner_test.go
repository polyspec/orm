package orm_test

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

// paramUseOut is one use of a parameter as planner.json writes it: the slot's logical type and, for a
// column slot, the column with its length, precision, scale and nullability.
type paramUseOut struct {
	Type      string  `json:"type"`
	Assign    bool    `json:"assign,omitempty"`
	Column    *string `json:"column,omitempty"`
	Length    *int    `json:"length,omitempty"`
	Null      *bool   `json:"null,omitempty"`
	Precision *int    `json:"precision,omitempty"`
	Scale     *int    `json:"scale,omitempty"`
}

// paramUsesCase validates the request of a param_uses case of planner.json and compares
// ir.ParamUses with the expected uses of each parameter.
func paramUsesCase(t *testing.T, id string) {
	t.Helper()
	c := featureFixture(t, "planner", id, "param_uses")
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", filepath.FromSlash(c.Schema)))
	if err != nil {
		t.Fatal(err)
	}
	var request ir.Request
	decodeFixture(t, c.Input, &request)
	request.ManifestHash = m.ManifestHash
	if err := ir.Validate(m, &request); err != nil {
		t.Fatal(err)
	}
	got := [][]paramUseOut{}
	parameterUses, err := ir.ParamUses(m, &request)
	if err != nil {
		t.Fatal(err)
	}
	for _, uses := range parameterUses {
		list := []paramUseOut{}
		for _, u := range uses {
			out := paramUseOut{Type: u.Type, Assign: u.Assign}
			if f := u.Column; f != nil {
				out.Column, out.Length, out.Null, out.Precision, out.Scale = &f.Name, &f.Length, &f.Null, &f.Precision, &f.Scale
			}
			list = append(list, out)
		}
		got = append(got, list)
	}
	var expected struct {
		Uses [][]paramUseOut `json:"uses"`
	}
	decodeFixture(t, c.Expected, &expected)
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(expected.Uses)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("param uses:\n got %s\nwant %s", gotJSON, wantJSON)
	}
}

// coveragePlannerParamUsesColumnFunction: a parameter compared with a column function takes the
// function's result type, or the column when the result has the column's type.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesColumnFunction(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_column_function")
}

// coveragePlannerParamUsesInterval: the interval of a relative time function is i32, or f64 for seconds.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesInterval(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_interval")
}

// coveragePlannerParamUsesContains: the value of contains and contains_binary is text.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesContains(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_contains")
}

// coveragePlannerParamUsesIfParent: the value of if_parent takes the parent column.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesIfParent(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_if_parent")
}

// coveragePlannerParamUsesOptimistic: the value of optimistic takes its column.
// Requirements: DIA-31, PRT-67.
func coveragePlannerParamUsesOptimistic(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	paramUsesCase(t, "param_uses_optimistic")
}

// TestCoveragePlanner runs the param_uses cases of contracts/fixtures/planner.json with the test of that case, so the parity
// check runs the suite under its case ids. The compile cases are the recipe tests/planner/compile.json (TestRecipePlannerCompileNone).
func TestCoveragePlanner(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	runFixtureCases(t, "planner", map[string]func(*testing.T){
		"param_uses_column_function": coveragePlannerParamUsesColumnFunction,
		"param_uses_interval":        coveragePlannerParamUsesInterval,
		"param_uses_contains":        coveragePlannerParamUsesContains,
		"param_uses_if_parent":       coveragePlannerParamUsesIfParent,
		"param_uses_optimistic":      coveragePlannerParamUsesOptimistic,
	})
}
