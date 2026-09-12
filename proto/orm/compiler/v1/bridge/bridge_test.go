package bridge

import (
	"testing"

	"github.com/polyspec/orm/engine/ir"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
)

func TestRequestConversionRejectsInvalidBoundaryValues(t *testing.T) {
	tests := []struct {
		name string
		req  *ir.Request
	}{
		{"nil request", nil},
		{"negative IR version", &ir.Request{IRVersion: -1}},
		{"negative parameter count", &ir.Request{NParams: -1}},
		{"nil join query", &ir.Request{Query: ir.Query{Joins: []*ir.Join{{}}}}},
		{"nil relation query", &ir.Request{Query: ir.Query{Relations: []*ir.Relation{{}}}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := RequestToProto(test.req); err == nil {
				t.Fatal("expected conversion error")
			}
		})
	}
}

func TestRequestFromProtoRejectsMalformedRepeatedMessages(t *testing.T) {
	tests := []struct {
		name string
		req  *compilerv1.CompileRequest
	}{
		{"nil request", nil},
		{"nil assignment", &compilerv1.CompileRequest{Set: []*compilerv1.Assignment{nil}}},
		{"nil join", &compilerv1.CompileRequest{Root: &compilerv1.QueryNode{Joins: []*compilerv1.Join{nil}}}},
		{"nil join query", &compilerv1.CompileRequest{Root: &compilerv1.QueryNode{Joins: []*compilerv1.Join{{}}}}},
		{"nil relation", &compilerv1.CompileRequest{Root: &compilerv1.QueryNode{Relations: []*compilerv1.Relation{nil}}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := RequestFromProto(test.req); err == nil {
				t.Fatal("expected conversion error")
			}
		})
	}
}

func TestNavigationModeRoundTrips(t *testing.T) {
	req := &ir.Request{IRVersion: ir.Version, SchemaHash: "schema", Kind: "all", NParams: 1, Query: ir.Query{
		Entity: "account",
		Where:  &ir.Group{Items: []ir.Item{{Nav: &ir.Nav{Rel: "items", Mode: "exists", Group: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "state", Op: "eq", P: intPtr(0)}}}}}}}},
	}}
	wire, err := RequestToProto(req)
	if err != nil {
		t.Fatal(err)
	}
	nav := wire.Root.GetWhere().Items[0].GetNavigation()
	if nav == nil || nav.GetMode() != "exists" {
		t.Fatalf("navigation mode was not encoded: %#v", nav)
	}
	decoded, err := RequestFromProto(wire)
	if err != nil {
		t.Fatal(err)
	}
	got := decoded.Query.Where.Items[0].Nav
	if got == nil || got.Mode != "exists" {
		t.Fatalf("navigation mode was not decoded: %#v", got)
	}
}

func intPtr(v int) *int { return &v }

func TestPlanFromProtoRejectsMissingPlanData(t *testing.T) {
	if _, err := PlanFromProto(nil); err == nil {
		t.Fatal("expected nil plan error")
	}
	if _, err := PlanFromProto(&compilerv1.Plan{Kind: compilerv1.QueryKind_QUERY_KIND_UNSPECIFIED}); err == nil {
		t.Fatal("expected unknown kind error")
	}
	if _, err := PlanFromProto(&compilerv1.Plan{Kind: compilerv1.QueryKind_QUERY_KIND_ALL, Steps: []*compilerv1.PlanStep{nil}}); err == nil {
		t.Fatal("expected nil step error")
	}
}
