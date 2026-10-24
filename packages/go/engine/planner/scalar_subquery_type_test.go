package planner

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dialect"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestScalarSubqueryMissingColumnIsInternal(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m := testModel(t, runtimeDocument)
	request := &ir.Request{
		Kind: "all",
		Query: ir.Query{
			Entity: "note",
			Columns: &ir.Columns{Sub: map[string]*ir.Sub{
				"selected": {Column: "title", Query: &ir.Query{
					Entity: "item", Order: []ir.Order{{Column: "seq"}}, Limit: &ir.Limit{Count: 1},
				}},
			}},
		},
	}
	request.IRVersion, request.ManifestHash = ir.Version, m.ManifestHash
	if err := ir.Validate(m, request); err != nil {
		t.Fatalf("valid scalar subquery did not pass validation: %v", err)
	}
	request.Query.Columns.Sub["selected"].Column = "missing_column"
	_, err := (&Planner{M: m, D: dialect.SQLite{}}).Compile(request)
	if err == nil {
		t.Fatal("planner accepted a missing post-validation scalar subquery column")
	}
	var plannerErr *ir.Error
	if !errors.As(err, &plannerErr) || plannerErr.Code != "INTERNAL" || plannerErr.Msg != "item.missing_column is missing from a validated scalar subquery" {
		t.Fatalf("planner error = %#v, want INTERNAL naming item.missing_column", err)
	}
}

func TestScalarSubqueryAggregateTypes(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m := testModel(t, runtimeDocument)
	for _, tc := range []struct {
		aggregate string
		want      string
	}{{"count", "i64"}, {"avg", "f64"}} {
		t.Run(tc.aggregate, func(t *testing.T) {
			request := &ir.Request{Kind: "all", Query: ir.Query{
				Entity: "note",
				Columns: &ir.Columns{Sub: map[string]*ir.Sub{
					"selected": {Agg: tc.aggregate, Column: "rank", Query: &ir.Query{Entity: "note"}},
				}},
			}}
			request.IRVersion, request.ManifestHash = ir.Version, m.ManifestHash
			if err := ir.Validate(m, request); err != nil {
				t.Fatalf("valid %s subquery did not pass validation: %v", tc.aggregate, err)
			}
			compiled, err := (&Planner{M: m, D: dialect.SQLite{}}).Compile(request)
			if err != nil {
				t.Fatal(err)
			}
			for _, col := range compiled.Steps[0].Assemble.Columns {
				if col.Name == "selected" {
					if col.Type != tc.want {
						t.Fatalf("%s output type = %s, want %s", tc.aggregate, col.Type, tc.want)
					}
					return
				}
			}
			t.Fatalf("%s output column missing from assembly: %+v", tc.aggregate, compiled.Steps[0].Assemble.Columns)
		})
	}
}
