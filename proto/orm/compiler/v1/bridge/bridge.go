// Package bridge converts the engine IR and plan structures to and from the
// generated compiler Protobuf messages.
package bridge

import (
	"fmt"
	"math"

	"github.com/polyspec/orm/engine/ir"
	planmodel "github.com/polyspec/orm/engine/plan"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
)

// RequestFromProto converts a typed compiler request to the engine IR.
func RequestFromProto(in *compilerv1.CompileRequest) (*ir.Request, error) {
	if in == nil {
		return nil, invalid("compiler request is nil")
	}
	out := &ir.Request{IRVersion: int(in.IrVersion), SchemaHash: in.SchemaHash, Kind: KindFromProto(in.Kind), NParams: int(in.ParameterCount), Agg: in.Aggregate, Debug: in.Debug}
	if in.Root != nil {
		query, err := queryFromProto(in.Root, "root")
		if err != nil {
			return nil, err
		}
		out.Query = *query
	}
	var err error
	if out.Set, err = assignmentsFromProto(in.Set, "set"); err != nil {
		return nil, err
	}
	if out.OnDuplicate, err = assignmentsFromProto(in.OnDuplicate, "on_duplicate"); err != nil {
		return nil, err
	}
	if in.Optimistic != nil {
		out.Optimistic = &ir.Optimist{Column: in.Optimistic.Column, P: int(in.Optimistic.Parameter)}
	}
	if in.Raw != nil {
		out.Raw = &ir.Raw{SQL: in.Raw.Sql, Ps: uintsToInts(in.Raw.Parameters)}
	}
	return out, nil
}

// RequestToProto converts engine IR to a typed compiler request and rejects
// integer values that cannot be represented by the wire format.
func RequestToProto(in *ir.Request) (*compilerv1.CompileRequest, error) {
	if in == nil {
		return nil, invalid("engine request is nil")
	}
	irVersion, err := uint32Value(in.IRVersion, "ir_version")
	if err != nil {
		return nil, err
	}
	parameterCount, err := uint32Value(in.NParams, "parameter_count")
	if err != nil {
		return nil, err
	}
	root, err := queryToProto(&in.Query, "root")
	if err != nil {
		return nil, err
	}
	set, err := assignmentsToProto(in.Set, "set")
	if err != nil {
		return nil, err
	}
	onDuplicate, err := assignmentsToProto(in.OnDuplicate, "on_duplicate")
	if err != nil {
		return nil, err
	}
	out := &compilerv1.CompileRequest{IrVersion: irVersion, SchemaHash: in.SchemaHash, Kind: KindToProto(in.Kind), Root: root, Set: set, OnDuplicate: onDuplicate, ParameterCount: parameterCount, Aggregate: in.Agg, Debug: in.Debug}
	if in.Optimistic != nil {
		parameter, err := uint32Value(in.Optimistic.P, "optimistic.parameter")
		if err != nil {
			return nil, err
		}
		out.Optimistic = &compilerv1.Optimistic{Column: in.Optimistic.Column, Parameter: parameter}
	}
	if in.Raw != nil {
		parameters, err := intsToUints(in.Raw.Ps, "raw.parameters")
		if err != nil {
			return nil, err
		}
		out.Raw = &compilerv1.Raw{Sql: in.Raw.SQL, Parameters: parameters}
	}
	return out, nil
}

func queryFromProto(in *compilerv1.QueryNode, path string) (*ir.Query, error) {
	if in == nil {
		return nil, invalid("%s is nil", path)
	}
	out := &ir.Query{Entity: in.Entity, On: groupFromProto(in.On), Where: groupFromProto(in.Where), Having: groupFromProto(in.Having), GroupBy: append([]string(nil), in.GroupBy...), Distinct: in.Distinct, ForceIdx: in.ForceIndex, Lock: in.Lock, KeyBy: in.KeyBy, Flatten: in.Flatten, LimitPerParent: int(in.LimitPerParent), DropChildKey: in.DropChildKey, NoCascadeDelete: in.NoCascadeDelete}
	if in.ScopeParameter != nil {
		value := int(*in.ScopeParameter)
		out.ScopeP = &value
	}
	if in.Columns != nil {
		modes := map[compilerv1.Projection_Mode]string{compilerv1.Projection_MODE_DEFAULT: "", compilerv1.Projection_MODE_ALL: "all", compilerv1.Projection_MODE_NONE: "none"}
		out.Columns = &ir.Columns{Mode: modes[in.Columns.Mode], Add: append([]string(nil), in.Columns.Add...), Remove: append([]string(nil), in.Columns.Remove...), As: cloneMap(in.Columns.Aliases), Expr: cloneMap(in.Columns.Expressions)}
	}
	for _, value := range in.Joins {
		if value == nil {
			return nil, invalid("%s.joins[%d] is nil", path, len(out.Joins))
		}
		query, err := queryFromProto(value.Query, fmt.Sprintf("%s.joins[%d].query", path, len(out.Joins)))
		if err != nil {
			return nil, err
		}
		out.Joins = append(out.Joins, &ir.Join{Rel: value.Relation, Kind: value.Kind, Query: query})
	}
	for _, value := range in.Relations {
		if value == nil {
			return nil, invalid("%s.relations[%d] is nil", path, len(out.Relations))
		}
		query, err := queryFromProto(value.Query, fmt.Sprintf("%s.relations[%d].query", path, len(out.Relations)))
		if err != nil {
			return nil, err
		}
		out.Relations = append(out.Relations, &ir.Relation{Rel: value.Relation, Query: query})
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
	if in.Keyset != nil {
		values := make([]int, len(in.Keyset.Values))
		for index, value := range in.Keyset.Values {
			values[index] = int(value)
		}
		out.Keyset = &ir.Keyset{Direction: in.Keyset.Direction, Values: values}
	}
	return out, nil
}

func queryToProto(in *ir.Query, path string) (*compilerv1.QueryNode, error) {
	if in == nil {
		return nil, invalid("%s is nil", path)
	}
	out := &compilerv1.QueryNode{Entity: in.Entity, GroupBy: append([]string(nil), in.GroupBy...), Distinct: in.Distinct, ForceIndex: in.ForceIdx, Lock: in.Lock, KeyBy: in.KeyBy, Flatten: in.Flatten, DropChildKey: in.DropChildKey, NoCascadeDelete: in.NoCascadeDelete}
	var err error
	if out.LimitPerParent, err = uint32Value(in.LimitPerParent, path+".limit_per_parent"); err != nil {
		return nil, err
	}
	if in.ScopeP != nil {
		value, err := uint32Value(*in.ScopeP, path+".scope_parameter")
		if err != nil {
			return nil, err
		}
		out.ScopeParameter = &value
	}
	if in.Columns != nil {
		modes := map[string]compilerv1.Projection_Mode{"": compilerv1.Projection_MODE_DEFAULT, "all": compilerv1.Projection_MODE_ALL, "none": compilerv1.Projection_MODE_NONE}
		mode, ok := modes[in.Columns.Mode]
		if !ok {
			return nil, invalid("%s.columns.mode %q", path, in.Columns.Mode)
		}
		out.Columns = &compilerv1.Projection{Mode: mode, Add: append([]string(nil), in.Columns.Add...), Remove: append([]string(nil), in.Columns.Remove...), Aliases: cloneMap(in.Columns.As), Expressions: cloneMap(in.Columns.Expr)}
	}
	if out.On, err = groupToProto(in.On, path+".on"); err != nil {
		return nil, err
	}
	if out.Where, err = groupToProto(in.Where, path+".where"); err != nil {
		return nil, err
	}
	if out.Having, err = groupToProto(in.Having, path+".having"); err != nil {
		return nil, err
	}
	for index, value := range in.Joins {
		query, err := queryToProto(value.Query, fmt.Sprintf("%s.joins[%d].query", path, index))
		if err != nil {
			return nil, err
		}
		out.Joins = append(out.Joins, &compilerv1.Join{Relation: value.Rel, Kind: value.Kind, Query: query})
	}
	for index, value := range in.Relations {
		query, err := queryToProto(value.Query, fmt.Sprintf("%s.relations[%d].query", path, index))
		if err != nil {
			return nil, err
		}
		out.Relations = append(out.Relations, &compilerv1.Relation{Relation: value.Rel, Query: query})
	}
	for _, value := range in.Order {
		out.Order = append(out.Order, &compilerv1.Order{Column: value.Column, Expression: value.Expr, Descending: value.Desc})
	}
	for _, value := range in.GroupByExpr {
		out.GroupByExpression = append(out.GroupByExpression, &compilerv1.GroupExpression{Expression: value.Expr, Alias: value.As})
	}
	if in.Limit != nil {
		offset, err := uint32Value(in.Limit.Offset, path+".limit.offset")
		if err != nil {
			return nil, err
		}
		count, err := uint32Value(in.Limit.Count, path+".limit.count")
		if err != nil {
			return nil, err
		}
		out.Limit = &compilerv1.Limit{Offset: offset, Count: count}
	}
	if in.IfParent != nil {
		parameter, err := uint32Value(in.IfParent.P, path+".if_parent.parameter")
		if err != nil {
			return nil, err
		}
		out.IfParent = &compilerv1.IfParent{Column: in.IfParent.Column, Parameter: parameter}
	}
	if in.Keyset != nil {
		values := make([]uint32, len(in.Keyset.Values))
		for index, value := range in.Keyset.Values {
			converted, err := uint32Value(value, fmt.Sprintf("%s.keyset.values[%d]", path, index))
			if err != nil {
				return nil, err
			}
			values[index] = converted
		}
		out.Keyset = &compilerv1.Keyset{Direction: in.Keyset.Direction, Values: values}
	}
	return out, nil
}

func groupFromProto(in *compilerv1.Group) *ir.Group {
	if in == nil {
		return nil
	}
	out := &ir.Group{Conn: in.Connector, Items: make([]ir.Item, 0, len(in.Items))}
	for _, value := range in.Items {
		item := ir.Item{Group: groupFromProto(value.GetGroup())}
		if p := value.GetPredicate(); p != nil {
			item.Pred = &ir.Pred{Conn: p.Connector, Column: p.Column, Op: p.Operator, Ps: uintsToInts(p.Parameters), Expr: p.Expression, Match: append([]string(nil), p.MatchColumns...)}
			if p.Parameter != nil {
				v := int(*p.Parameter)
				item.Pred.P = &v
			}
			if p.Reference != nil {
				item.Pred.Ref = &ir.ColRef{Path: p.Reference.Path, Column: p.Reference.Column}
			}
		}
		if navigation := value.GetNavigation(); navigation != nil {
			item.Nav = &ir.Nav{Conn: navigation.Connector, Rel: navigation.Relation, Group: groupFromProto(navigation.Group), Mode: navigation.Mode, CountOp: navigation.CountOperator}
			if navigation.CountParameter != nil {
				value := int(*navigation.CountParameter)
				item.Nav.P = &value
			}
		}
		out.Items = append(out.Items, item)
	}
	return out
}

func groupToProto(in *ir.Group, path string) (*compilerv1.Group, error) {
	if in == nil {
		return nil, nil
	}
	out := &compilerv1.Group{Connector: in.Conn, Items: make([]*compilerv1.Item, 0, len(in.Items))}
	for index, value := range in.Items {
		itemPath := fmt.Sprintf("%s.items[%d]", path, index)
		count := 0
		if value.Pred != nil {
			count++
			predicate := &compilerv1.Predicate{Connector: value.Pred.Conn, Column: value.Pred.Column, Operator: value.Pred.Op, Expression: value.Pred.Expr, MatchColumns: append([]string(nil), value.Pred.Match...)}
			if value.Pred.P != nil {
				parameter, err := uint32Value(*value.Pred.P, itemPath+".predicate.parameter")
				if err != nil {
					return nil, err
				}
				predicate.Parameter = &parameter
			}
			parameters, err := intsToUints(value.Pred.Ps, itemPath+".predicate.parameters")
			if err != nil {
				return nil, err
			}
			predicate.Parameters = parameters
			if value.Pred.Ref != nil {
				predicate.Reference = &compilerv1.ColumnReference{Path: value.Pred.Ref.Path, Column: value.Pred.Ref.Column}
			}
			out.Items = append(out.Items, &compilerv1.Item{Value: &compilerv1.Item_Predicate{Predicate: predicate}})
		}
		if value.Group != nil {
			count++
			group, err := groupToProto(value.Group, itemPath+".group")
			if err != nil {
				return nil, err
			}
			out.Items = append(out.Items, &compilerv1.Item{Value: &compilerv1.Item_Group{Group: group}})
		}
		if value.Nav != nil {
			count++
			group, err := groupToProto(value.Nav.Group, itemPath+".navigation.group")
			if err != nil {
				return nil, err
			}
			navigation := &compilerv1.Navigation{Connector: value.Nav.Conn, Relation: value.Nav.Rel, Group: group, Mode: value.Nav.Mode, CountOperator: value.Nav.CountOp}
			if value.Nav.P != nil {
				value := uint32(*value.Nav.P)
				navigation.CountParameter = &value
			}
			out.Items = append(out.Items, &compilerv1.Item{Value: &compilerv1.Item_Navigation{Navigation: navigation}})
		}
		if count != 1 {
			return nil, invalid("%s must contain exactly one value", itemPath)
		}
	}
	return out, nil
}

func assignmentsFromProto(values []*compilerv1.Assignment, path string) ([]ir.Assign, error) {
	out := make([]ir.Assign, 0, len(values))
	for index, value := range values {
		if value == nil {
			return nil, invalid("%s[%d] is nil", path, index)
		}
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
	return out, nil
}

func assignmentsToProto(values []ir.Assign, path string) ([]*compilerv1.Assignment, error) {
	out := make([]*compilerv1.Assignment, 0, len(values))
	for index, value := range values {
		itemPath := fmt.Sprintf("%s[%d]", path, index)
		item := &compilerv1.Assignment{Column: value.Column, SetNull: value.Null, Expression: value.Expr}
		var err error
		if item.ExpressionParameters, err = intsToUints(value.Ps, itemPath+".expression_parameters"); err != nil {
			return nil, err
		}
		for _, optional := range []struct {
			name   string
			input  *int
			target **uint32
		}{{"parameter", value.P, &item.Parameter}, {"plus_parameter", value.PlusP, &item.PlusParameter}, {"minus_parameter", value.MinusP, &item.MinusParameter}} {
			if optional.input != nil {
				converted, err := uint32Value(*optional.input, itemPath+"."+optional.name)
				if err != nil {
					return nil, err
				}
				*optional.target = &converted
			}
		}
		out = append(out, item)
	}
	return out, nil
}

// PlanToProto converts an engine plan to its typed wire representation.
func PlanToProto(in *planmodel.Plan) *compilerv1.Plan {
	out := &compilerv1.Plan{SchemaHash: in.SchemaHash, Kind: KindToProto(in.Kind)}
	for i := range in.Steps {
		out.Steps = append(out.Steps, stepToProto(&in.Steps[i]))
	}
	return out
}

// PlanFromProto converts a typed wire plan to the executor plan structure.
func PlanFromProto(in *compilerv1.Plan) (*planmodel.Plan, error) {
	if in == nil {
		return nil, invalid("compiler returned a nil plan")
	}
	kind := KindFromProto(in.Kind)
	if kind == "" {
		return nil, invalid("compiler returned unknown query kind %d", in.Kind)
	}
	out := &planmodel.Plan{SchemaHash: in.SchemaHash, Kind: kind, Steps: make([]planmodel.Step, 0, len(in.Steps))}
	for index, value := range in.Steps {
		if value == nil {
			return nil, invalid("plan.steps[%d] is nil", index)
		}
		out.Steps = append(out.Steps, stepFromProto(value))
	}
	return out, nil
}

func stepToProto(in *planmodel.Step) *compilerv1.PlanStep {
	out := &compilerv1.PlanStep{Id: uint32(in.ID), Role: in.Role, Sql: in.SQL, Lock: in.Lock, Assemble: assembleToProto(in.Assemble)}
	for _, value := range in.BindSlots {
		out.Binds = append(out.Binds, &compilerv1.BindSlot{Source: value.From, Parameter: uint32(value.Param), Transform: value.Transform, Name: value.Name, Step: uint32(value.Step), Column: value.Column, HostStyles: append([]string(nil), value.HostStyles...), ColumnType: value.ColType})
	}
	if in.Parent != nil {
		out.Parent = &compilerv1.ParentReference{Step: uint32(in.Parent.Step), Keys: keyRefsToProto(in.Parent.Keys)}
		if in.Parent.IfParent != nil {
			out.Parent.IfParent = &compilerv1.ParentCondition{Column: in.Parent.IfParent.Column, Index: uint32(in.Parent.IfParent.Index), Parameter: uint32(in.Parent.IfParent.Param)}
		}
	}
	return out
}

func stepFromProto(in *compilerv1.PlanStep) planmodel.Step {
	out := planmodel.Step{ID: int(in.Id), Role: in.Role, SQL: in.Sql, Lock: in.Lock, BindSlots: make([]planmodel.BindSlot, 0, len(in.Binds)), Assemble: assembleFromProto(in.Assemble)}
	for _, value := range in.Binds {
		out.BindSlots = append(out.BindSlots, planmodel.BindSlot{From: value.Source, Param: int(value.Parameter), Transform: value.Transform, Name: value.Name, Step: int(value.Step), Column: value.Column, HostStyles: append([]string(nil), value.HostStyles...), ColType: value.ColumnType})
	}
	if in.Parent != nil {
		out.Parent = &planmodel.ParentRef{Step: int(in.Parent.Step), Keys: keyRefsFromProto(in.Parent.Keys)}
		if in.Parent.IfParent != nil {
			out.Parent.IfParent = &planmodel.IfParent{Column: in.Parent.IfParent.Column, Index: int(in.Parent.IfParent.Index), Param: int(in.Parent.IfParent.Parameter)}
		}
	}
	return out
}

func assembleToProto(in *planmodel.Assemble) *compilerv1.Assemble {
	if in == nil {
		return nil
	}
	out := &compilerv1.Assemble{Entity: in.Entity, Alias: in.Alias, Key: keyRefsToProto(in.Key)}
	for _, value := range in.Columns {
		out.Columns = append(out.Columns, &compilerv1.OutputColumn{Index: uint32(value.Index), Name: value.Name, Column: value.Column, Type: value.Type, Styles: append([]string(nil), value.Styles...), Hidden: value.Hidden})
	}
	for _, value := range in.Children {
		out.Children = append(out.Children, &compilerv1.Child{Relation: value.Rel, Kind: value.Kind, Step: uint32(value.Step), ParentKeys: keyRefsToProto(value.ParentKeys), ChildKeys: keyRefsToProto(value.ChildKeys), Key: keyRefsToProto(value.Key), Flatten: value.Flatten, Cascade: value.Cascade, Assemble: assembleToProto(value.Assemble)})
	}
	return out
}

func assembleFromProto(in *compilerv1.Assemble) *planmodel.Assemble {
	if in == nil {
		return nil
	}
	out := &planmodel.Assemble{Entity: in.Entity, Alias: in.Alias, Columns: make([]planmodel.OutCol, 0, len(in.Columns)), Key: keyRefsFromProto(in.Key)}
	for _, value := range in.Columns {
		out.Columns = append(out.Columns, planmodel.OutCol{Index: int(value.Index), Name: value.Name, Column: value.Column, Type: value.Type, Styles: append([]string(nil), value.Styles...), Hidden: value.Hidden})
	}
	for _, value := range in.Children {
		out.Children = append(out.Children, &planmodel.Child{Rel: value.Relation, Kind: value.Kind, Step: int(value.Step), ParentKeys: keyRefsFromProto(value.ParentKeys), ChildKeys: keyRefsFromProto(value.ChildKeys), Key: keyRefsFromProto(value.Key), Flatten: value.Flatten, Cascade: value.Cascade, Assemble: assembleFromProto(value.Assemble)})
	}
	return out
}

func keyRefsToProto(in []planmodel.KeyRef) []*compilerv1.KeyReference {
	out := make([]*compilerv1.KeyReference, len(in))
	for i, value := range in {
		out[i] = &compilerv1.KeyReference{Column: value.Column, Index: uint32(value.Index)}
	}
	return out
}

func keyRefsFromProto(in []*compilerv1.KeyReference) []planmodel.KeyRef {
	out := make([]planmodel.KeyRef, 0, len(in))
	for _, value := range in {
		if value != nil {
			out = append(out, planmodel.KeyRef{Column: value.Column, Index: int(value.Index)})
		}
	}
	return out
}

// KindFromProto returns the engine query kind for a wire enum value.
func KindFromProto(value compilerv1.QueryKind) string {
	return map[compilerv1.QueryKind]string{compilerv1.QueryKind_QUERY_KIND_ONE: "one", compilerv1.QueryKind_QUERY_KIND_ALL: "all", compilerv1.QueryKind_QUERY_KIND_COUNT: "count", compilerv1.QueryKind_QUERY_KIND_GROUP_COUNT: "group_count", compilerv1.QueryKind_QUERY_KIND_COUNT_DISTINCT: "count_distinct", compilerv1.QueryKind_QUERY_KIND_SUM: "sum", compilerv1.QueryKind_QUERY_KIND_AVG: "avg", compilerv1.QueryKind_QUERY_KIND_MIN: "min", compilerv1.QueryKind_QUERY_KIND_MAX: "max", compilerv1.QueryKind_QUERY_KIND_PAGINATE: "paginate", compilerv1.QueryKind_QUERY_KIND_INSERT: "insert", compilerv1.QueryKind_QUERY_KIND_UPDATE: "update", compilerv1.QueryKind_QUERY_KIND_DELETE: "delete", compilerv1.QueryKind_QUERY_KIND_RAW: "raw"}[value]
}

// KindToProto returns the wire enum value for an engine query kind.
func KindToProto(value string) compilerv1.QueryKind {
	for key, candidate := range map[compilerv1.QueryKind]string{compilerv1.QueryKind_QUERY_KIND_ONE: "one", compilerv1.QueryKind_QUERY_KIND_ALL: "all", compilerv1.QueryKind_QUERY_KIND_COUNT: "count", compilerv1.QueryKind_QUERY_KIND_GROUP_COUNT: "group_count", compilerv1.QueryKind_QUERY_KIND_COUNT_DISTINCT: "count_distinct", compilerv1.QueryKind_QUERY_KIND_SUM: "sum", compilerv1.QueryKind_QUERY_KIND_AVG: "avg", compilerv1.QueryKind_QUERY_KIND_MIN: "min", compilerv1.QueryKind_QUERY_KIND_MAX: "max", compilerv1.QueryKind_QUERY_KIND_PAGINATE: "paginate", compilerv1.QueryKind_QUERY_KIND_INSERT: "insert", compilerv1.QueryKind_QUERY_KIND_UPDATE: "update", compilerv1.QueryKind_QUERY_KIND_DELETE: "delete", compilerv1.QueryKind_QUERY_KIND_RAW: "raw"} {
		if candidate == value {
			return key
		}
	}
	return compilerv1.QueryKind_QUERY_KIND_UNSPECIFIED
}

func uint32Value(value int, path string) (uint32, error) {
	if value < 0 || uint64(value) > math.MaxUint32 {
		return 0, invalid("%s %d is outside uint32", path, value)
	}
	return uint32(value), nil
}

func intsToUints(values []int, path string) ([]uint32, error) {
	out := make([]uint32, len(values))
	for index, value := range values {
		converted, err := uint32Value(value, fmt.Sprintf("%s[%d]", path, index))
		if err != nil {
			return nil, err
		}
		out[index] = converted
	}
	return out, nil
}

func uintsToInts(values []uint32) []int {
	out := make([]int, len(values))
	for index, value := range values {
		out[index] = int(value)
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

func invalid(format string, values ...any) error {
	return &ir.Error{Code: "IR_INVALID", Msg: fmt.Sprintf(format, values...)}
}
