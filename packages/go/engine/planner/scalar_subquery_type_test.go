package planner

import (
	"errors"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/dialect"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/internal/testmodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

const runtimeDocument = `dbspec 1 runtime

table note {
  id i64 identity
  rank i16
  body text
  payload bytes null
  meta text null
  secret_note text null
  created_at datetime(6) default now
  primary key (id)
  settings {
    select explicit secret_note
    codec meta ordered_json
  }
}

table item {
  seq i64 identity
  title varchar(191)
  audit_seq i64
  deleted_at datetime(6) null
  primary key (seq)
  index ix_item_audit (audit_seq)
  foreign key fk_item_audit (audit_seq) references audit (seq) on delete restrict on update restrict
  settings {
    soft_delete deleted_at
    audit into item_history column audit_seq references audit action change previous previous_audit_seq
  }
}

table item_history {
  history_id i64 identity
  change varchar(8)
  previous_audit_seq i64 null
  seq i64
  title varchar(191)
  audit_seq i64
  deleted_at datetime(6) null
  primary key (history_id)
  index ix_item_history_row (seq)
}

table audit {
  seq i64 identity
  actor varchar(64)
  primary key (seq)
}
`

// testModel is the runtime model of one dbspec document.
func testModel(t *testing.T, document string) *runtimemodel.Model {
	return testmodel.Load(t, document)
}

func intp(i int) *int { return &i }

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
