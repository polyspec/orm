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
