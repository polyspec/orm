package main

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	planmodel "github.com/polyspec/orm/engine/plan"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
)

type compilerServer struct{ engine *engine.Engine }

func (s *compilerServer) Compile(_ context.Context, req *connect.Request[compilerv1.CompileRequest]) (*connect.Response[compilerv1.CompileResponse], error) {
	input := requestFromProto(req.Msg)
	if err := ir.Validate(s.engine.M, input); err != nil {
		return connect.NewResponse(compileFailure(err)), nil
	}
	output, err := s.engine.P.Compile(input)
	if err != nil {
		return connect.NewResponse(compileFailure(err)), nil
	}
	return connect.NewResponse(&compilerv1.CompileResponse{Result: &compilerv1.CompileResponse_Plan{Plan: planToProto(output)}}), nil
}

func compileFailure(err error) *compilerv1.CompileResponse {
	code, message := "INTERNAL", err.Error()
	var compileErr *ir.Error
	if errors.As(err, &compileErr) {
		code, message = compileErr.Code, compileErr.Msg
	}
	return &compilerv1.CompileResponse{Result: &compilerv1.CompileResponse_Error{Error: &compilerv1.CompileError{Code: code, Message: message}}}
}

func (s *compilerServer) GetMetadata(_ context.Context, _ *connect.Request[compilerv1.GetMetadataRequest]) (*connect.Response[compilerv1.GetMetadataResponse], error) {
	return connect.NewResponse(&compilerv1.GetMetadataResponse{SchemaHash: s.engine.M.SchemaHash, Dialect: s.engine.P.D.Name(), IrVersion: ir.Version}), nil
}

func requestFromProto(in *compilerv1.CompileRequest) *ir.Request {
	out := &ir.Request{IRVersion: int(in.IrVersion), SchemaHash: in.SchemaHash, Kind: kindFromProto(in.Kind), NParams: int(in.ParameterCount), Agg: in.Aggregate, Debug: in.Debug}
	if in.Root != nil {
		out.Query = *queryFromProto(in.Root)
	}
	out.Set = assignmentsFromProto(in.Set)
	out.OnDuplicate = assignmentsFromProto(in.OnDuplicate)
	if in.Optimistic != nil {
		out.Optimistic = &ir.Optimist{Column: in.Optimistic.Column, P: int(in.Optimistic.Parameter)}
	}
	if in.Raw != nil {
		out.Raw = &ir.Raw{SQL: in.Raw.Sql, Ps: uintsToInts(in.Raw.Parameters)}
	}
	return out
}

func queryFromProto(in *compilerv1.QueryNode) *ir.Query {
	if in == nil {
		return nil
	}
	out := &ir.Query{Entity: in.Entity, On: groupFromProto(in.On), Where: groupFromProto(in.Where), Having: groupFromProto(in.Having), GroupBy: append([]string(nil), in.GroupBy...), Distinct: in.Distinct, ForceIdx: in.ForceIndex, KeyBy: in.KeyBy, Flatten: in.Flatten, LimitPerParent: int(in.LimitPerParent), DropChildKey: in.DropChildKey, NoCascadeDelete: in.NoCascadeDelete}
	if in.ScopeParameter != nil {
		value := int(*in.ScopeParameter)
		out.ScopeP = &value
	}
	if in.Columns != nil {
		modes := map[compilerv1.Projection_Mode]string{compilerv1.Projection_MODE_DEFAULT: "", compilerv1.Projection_MODE_ALL: "all", compilerv1.Projection_MODE_NONE: "none"}
		out.Columns = &ir.Columns{Mode: modes[in.Columns.Mode], Add: append([]string(nil), in.Columns.Add...), Remove: append([]string(nil), in.Columns.Remove...), As: cloneMap(in.Columns.Aliases), Expr: cloneMap(in.Columns.Expressions)}
	}
	for _, value := range in.Joins {
		out.Joins = append(out.Joins, &ir.Join{Rel: value.Relation, Kind: value.Kind, Query: queryFromProto(value.Query)})
	}
	for _, value := range in.Relations {
		out.Relations = append(out.Relations, &ir.Relation{Rel: value.Relation, Query: queryFromProto(value.Query)})
	}
	for _, value := range in.Order {
		out.Order = append(out.Order, ir.Order{Column: value.Column, Expr: value.Expression, Desc: value.Descending})
	}
	for _, value := range in.GroupByExpression {
		out.GroupByExpr = append(out.GroupByExpr, ir.GroupExpr{Expr: value.Expression, As: value.Alias})
	}
	if in.Limit != nil {
		out.Limit = &ir.Limit{Offset: int(in.Limit.Offset), Count: int(in.Limit.Count)}
	}
	if in.IfParent != nil {
		out.IfParent = &ir.IfParent{Column: in.IfParent.Column, P: int(in.IfParent.Parameter)}
	}
	return out
}

func groupFromProto(in *compilerv1.Group) *ir.Group {
	if in == nil {
		return nil
	}
	out := &ir.Group{Conn: in.Connector, Items: make([]ir.Item, 0, len(in.Items))}
	for _, value := range in.Items {
		item := ir.Item{Group: groupFromProto(value.GetGroup())}
		if value.GetPredicate() != nil {
			p := value.GetPredicate()
			item.Pred = &ir.Pred{Conn: p.Connector, Column: p.Column, Op: p.Operator, Ps: uintsToInts(p.Parameters), Expr: p.Expression, Match: append([]string(nil), p.MatchColumns...)}
			if p.Parameter != nil {
				v := int(*p.Parameter)
				item.Pred.P = &v
			}
			if p.Reference != nil {
				item.Pred.Ref = &ir.ColRef{Path: p.Reference.Path, Column: p.Reference.Column}
			}
		}
		if value.GetNavigation() != nil {
			navigation := value.GetNavigation()
			item.Nav = &ir.Nav{Conn: navigation.Connector, Rel: navigation.Relation, Group: groupFromProto(navigation.Group)}
		}
		out.Items = append(out.Items, item)
	}
	return out
}

func assignmentsFromProto(values []*compilerv1.Assignment) []ir.Assign {
	out := make([]ir.Assign, 0, len(values))
	for _, value := range values {
		item := ir.Assign{Column: value.Column, Null: value.SetNull, Expr: value.Expression, Ps: uintsToInts(value.ExpressionParameters)}
		if value.Parameter != nil {
			v := int(*value.Parameter)
			item.P = &v
		}
		if value.PlusParameter != nil {
			v := int(*value.PlusParameter)
			item.PlusP = &v
		}
		if value.MinusParameter != nil {
			v := int(*value.MinusParameter)
			item.MinusP = &v
		}
		out = append(out, item)
	}
	return out
}

func planToProto(in *planmodel.Plan) *compilerv1.Plan {
	out := &compilerv1.Plan{SchemaHash: in.SchemaHash, Kind: kindToProto(in.Kind)}
	for i := range in.Steps {
		out.Steps = append(out.Steps, stepToProto(&in.Steps[i]))
	}
	return out
}

func stepToProto(in *planmodel.Step) *compilerv1.PlanStep {
	out := &compilerv1.PlanStep{Id: uint32(in.ID), Role: in.Role, Sql: in.SQL, Assemble: assembleToProto(in.Assemble)}
	for _, value := range in.BindSlots {
		out.Binds = append(out.Binds, &compilerv1.BindSlot{Source: value.From, Parameter: uint32(value.Param), Transform: value.Transform, Name: value.Name, Step: uint32(value.Step), Column: value.Column, HostStyles: append([]string(nil), value.HostStyles...), ColumnType: value.ColType})
	}
	if in.Parent != nil {
		out.Parent = &compilerv1.ParentReference{Step: uint32(in.Parent.Step), Column: in.Parent.Column, Index: uint32(in.Parent.Index)}
		if in.Parent.IfParent != nil {
			out.Parent.IfParent = &compilerv1.ParentCondition{Column: in.Parent.IfParent.Column, Index: uint32(in.Parent.IfParent.Index), Parameter: uint32(in.Parent.IfParent.Param)}
		}
	}
	return out
}

func assembleToProto(in *planmodel.Assemble) *compilerv1.Assemble {
	if in == nil {
		return nil
	}
	out := &compilerv1.Assemble{Entity: in.Entity, Alias: in.Alias}
	for _, value := range in.Columns {
		out.Columns = append(out.Columns, &compilerv1.OutputColumn{Index: uint32(value.Index), Name: value.Name, Column: value.Column, Type: value.Type, Styles: append([]string(nil), value.Styles...), Hidden: value.Hidden})
	}
	for _, value := range in.Children {
		out.Children = append(out.Children, &compilerv1.Child{Relation: value.Rel, Kind: value.Kind, Step: uint32(value.Step), ParentColumn: value.ParentColumn, ParentIndex: uint32(value.ParentIndex), ChildColumn: value.ChildColumn, ChildIndex: uint32(value.ChildIndex), KeyBy: value.KeyBy, KeyIndex: uint32(value.KeyIndex), Flatten: value.Flatten, Cascade: value.Cascade, Assemble: assembleToProto(value.Assemble)})
	}
	return out
}

func kindFromProto(value compilerv1.QueryKind) string {
	return map[compilerv1.QueryKind]string{compilerv1.QueryKind_QUERY_KIND_ONE: "one", compilerv1.QueryKind_QUERY_KIND_ALL: "all", compilerv1.QueryKind_QUERY_KIND_COUNT: "count", compilerv1.QueryKind_QUERY_KIND_GROUP_COUNT: "group_count", compilerv1.QueryKind_QUERY_KIND_COUNT_DISTINCT: "count_distinct", compilerv1.QueryKind_QUERY_KIND_SUM: "sum", compilerv1.QueryKind_QUERY_KIND_AVG: "avg", compilerv1.QueryKind_QUERY_KIND_MIN: "min", compilerv1.QueryKind_QUERY_KIND_MAX: "max", compilerv1.QueryKind_QUERY_KIND_PAGINATE: "paginate", compilerv1.QueryKind_QUERY_KIND_INSERT: "insert", compilerv1.QueryKind_QUERY_KIND_UPDATE: "update", compilerv1.QueryKind_QUERY_KIND_DELETE: "delete", compilerv1.QueryKind_QUERY_KIND_RAW: "raw"}[value]
}
func kindToProto(value string) compilerv1.QueryKind {
	for key, candidate := range map[compilerv1.QueryKind]string{compilerv1.QueryKind_QUERY_KIND_ONE: "one", compilerv1.QueryKind_QUERY_KIND_ALL: "all", compilerv1.QueryKind_QUERY_KIND_COUNT: "count", compilerv1.QueryKind_QUERY_KIND_GROUP_COUNT: "group_count", compilerv1.QueryKind_QUERY_KIND_COUNT_DISTINCT: "count_distinct", compilerv1.QueryKind_QUERY_KIND_SUM: "sum", compilerv1.QueryKind_QUERY_KIND_AVG: "avg", compilerv1.QueryKind_QUERY_KIND_MIN: "min", compilerv1.QueryKind_QUERY_KIND_MAX: "max", compilerv1.QueryKind_QUERY_KIND_PAGINATE: "paginate", compilerv1.QueryKind_QUERY_KIND_INSERT: "insert", compilerv1.QueryKind_QUERY_KIND_UPDATE: "update", compilerv1.QueryKind_QUERY_KIND_DELETE: "delete", compilerv1.QueryKind_QUERY_KIND_RAW: "raw"} {
		if candidate == value {
			return key
		}
	}
	return compilerv1.QueryKind_QUERY_KIND_UNSPECIFIED
}
func uintsToInts(values []uint32) []int {
	out := make([]int, len(values))
	for i, value := range values {
		out[i] = int(value)
	}
	return out
}
func cloneMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
