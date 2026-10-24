package planner

import (
	"errors"
	"strings"
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

func TestColumnFunctionMissingPostValidationFieldIsInternal(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m := testModel(t, runtimeDocument)
	p := func(i int) *int { return &i }
	request := func(column string, selectFunction bool) *ir.Request {
		q := ir.Query{Entity: "note"}
		if selectFunction {
			q.Columns = &ir.Columns{Mode: "none", Fn: map[string]ir.ColFunc{"selected": {Column: column, Fn: ir.Func{Name: "year"}}}}
		} else {
			q.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: column, Op: "eq", Fn: &ir.Func{Name: "date"}, P: p(0)}}}}
		}
		r := &ir.Request{Kind: "all", NParams: 1, Query: q}
		r.IRVersion, r.ManifestHash = ir.Version, m.ManifestHash
		return r
	}
	valid := request("created_at", false)
	if err := ir.Validate(m, valid); err != nil {
		t.Fatalf("valid column function failed validation: %v", err)
	}
	publicInvalid := request("missing_column", false)
	publicErr := ir.Validate(m, publicInvalid)
	var publicPlannerErr *ir.Error
	if !errors.As(publicErr, &publicPlannerErr) || publicPlannerErr.Code != "COLUMN_UNKNOWN" {
		t.Fatalf("public validation error = %v, want COLUMN_UNKNOWN", publicErr)
	}
	for _, tc := range []struct {
		name    string
		request *ir.Request
	}{
		{"predicate", request("created_at", false)},
		{"selection", request("created_at", true)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ir.Validate(m, tc.request); err != nil {
				t.Fatalf("valid request failed validation: %v", err)
			}
			if _, err := (&Planner{M: m, D: dialect.SQLite{}}).Compile(tc.request); err != nil {
				t.Fatalf("valid column-function request failed planning: %v", err)
			}
			if tc.name == "predicate" {
				tc.request.Where.Items[0].Pred.Column = "missing_column"
			} else {
				columnFunction := tc.request.Columns.Fn["selected"]
				columnFunction.Column = "missing_column"
				tc.request.Columns.Fn["selected"] = columnFunction
			}
			_, err := (&Planner{M: m, D: dialect.SQLite{}}).Compile(tc.request)
			var plannerErr *ir.Error
			if !errors.As(err, &plannerErr) || plannerErr.Code != "INTERNAL" || !strings.Contains(plannerErr.Msg, "note.missing_column") {
				t.Fatalf("planner error = %#v, want INTERNAL naming note.missing_column", err)
			}
		})
	}
}
