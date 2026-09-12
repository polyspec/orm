package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"

	"connectrpc.com/connect"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	planmodel "github.com/polyspec/orm/engine/plan"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
	compilerbridge "github.com/polyspec/orm/proto/orm/compiler/v1/bridge"
	"github.com/polyspec/orm/proto/orm/compiler/v1/compilerv1connect"
)

func uint32Pointer(value uint32) *uint32 { return &value }

func intPointer(value int) *int { return &value }

func TestRequestFromProtoPreservesEveryField(t *testing.T) {
	input := &compilerv1.CompileRequest{
		IrVersion: 1, SchemaHash: "schema", Kind: compilerv1.QueryKind_QUERY_KIND_UPDATE, ParameterCount: 12, Aggregate: "score", Debug: true,
		Root: &compilerv1.QueryNode{
			Entity: "battle", ScopeParameter: uint32Pointer(0),
			Columns: &compilerv1.Projection{Mode: compilerv1.Projection_MODE_NONE, Add: []string{"seq"}, Remove: []string{"deleted"}, Aliases: map[string]string{"id": "seq"}, Expressions: map[string]string{"total": "COUNT(*)"}},
			On:      &compilerv1.Group{Connector: "and", Items: []*compilerv1.Item{{Value: &compilerv1.Item_Predicate{Predicate: &compilerv1.Predicate{Connector: "or", Column: "service_seq", Operator: "eq_col", Reference: &compilerv1.ColumnReference{Path: "service", Column: "seq"}}}}}},
			Where: &compilerv1.Group{Items: []*compilerv1.Item{
				{Value: &compilerv1.Item_Predicate{Predicate: &compilerv1.Predicate{Column: "seq", Operator: "between", Parameter: uint32Pointer(1), Parameters: []uint32{2, 3}, Expression: "`seq` > ?", MatchColumns: []string{"title"}}}},
				{Value: &compilerv1.Item_Group{Group: &compilerv1.Group{Connector: "and", Items: []*compilerv1.Item{}}}},
				{Value: &compilerv1.Item_Navigation{Navigation: &compilerv1.Navigation{Connector: "or", Relation: "user", Group: &compilerv1.Group{Items: []*compilerv1.Item{}}}}},
			}},
			Having:    &compilerv1.Group{Items: []*compilerv1.Item{}},
			Joins:     []*compilerv1.Join{{Relation: "service", Kind: "left", Query: &compilerv1.QueryNode{Entity: "service"}}},
			Relations: []*compilerv1.Relation{{Relation: "user", Query: &compilerv1.QueryNode{Entity: "user"}}},
			Order:     []*compilerv1.Order{{Column: "seq", Expression: "LOWER(`title`)", Descending: true}},
			GroupBy:   []string{"service_seq"}, GroupByExpression: []*compilerv1.GroupExpression{{Expression: "DATE(`created_at`)", Alias: "day"}},
			Limit: &compilerv1.Limit{Offset: 4, Count: 5}, Distinct: true, ForceIndex: "idx_service", KeyBy: "seq", Flatten: true, LimitPerParent: 6,
			IfParent: &compilerv1.IfParent{Column: "is_display", Parameter: 7}, DropChildKey: true, NoCascadeDelete: true,
		},
		Set: []*compilerv1.Assignment{
			{Column: "title", Parameter: uint32Pointer(8)},
			{Column: "closed_at", SetNull: true},
			{Column: "score", Expression: "? + ?", ExpressionParameters: []uint32{9, 10}},
			{Column: "score", PlusParameter: uint32Pointer(10)},
			{Column: "score", MinusParameter: uint32Pointer(11)},
		},
		OnDuplicate: []*compilerv1.Assignment{{Column: "title", Parameter: uint32Pointer(8)}},
		Optimistic:  &compilerv1.Optimistic{Column: "version", Parameter: 9},
		Raw:         &compilerv1.Raw{Sql: "SELECT ?", Parameters: []uint32{10}},
	}

	want := &ir.Request{
		IRVersion: 1, SchemaHash: "schema", Kind: "update", NParams: 12, Agg: "score", Debug: true,
		Query: ir.Query{
			Entity: "battle", ScopeP: intPointer(0),
			Columns: &ir.Columns{Mode: "none", Add: []string{"seq"}, Remove: []string{"deleted"}, As: map[string]string{"id": "seq"}, Expr: map[string]string{"total": "COUNT(*)"}},
			On:      &ir.Group{Conn: "and", Items: []ir.Item{{Pred: &ir.Pred{Conn: "or", Column: "service_seq", Op: "eq_col", Ref: &ir.ColRef{Path: "service", Column: "seq"}}}}},
			Where: &ir.Group{Items: []ir.Item{
				{Pred: &ir.Pred{Column: "seq", Op: "between", P: intPointer(1), Ps: []int{2, 3}, Expr: "`seq` > ?", Match: []string{"title"}}},
				{Group: &ir.Group{Conn: "and", Items: []ir.Item{}}},
				{Nav: &ir.Nav{Conn: "or", Rel: "user", Group: &ir.Group{Items: []ir.Item{}}}},
			}},
			Having:    &ir.Group{Items: []ir.Item{}},
			Joins:     []*ir.Join{{Rel: "service", Kind: "left", Query: &ir.Query{Entity: "service"}}},
			Relations: []*ir.Relation{{Rel: "user", Query: &ir.Query{Entity: "user"}}},
			Order:     []ir.Order{{Column: "seq", Expr: "LOWER(`title`)", Desc: true}},
			GroupBy:   []string{"service_seq"}, GroupByExpr: []ir.GroupExpr{{Expr: "DATE(`created_at`)", As: "day"}},
			Limit: &ir.Limit{Offset: 4, Count: 5}, Distinct: true, ForceIdx: "idx_service", KeyBy: "seq", Flatten: true, LimitPerParent: 6,
			IfParent: &ir.IfParent{Column: "is_display", P: 7}, DropChildKey: true, NoCascadeDelete: true,
		},
		Set: []ir.Assign{
			{Column: "title", P: intPointer(8)},
			{Column: "closed_at", Null: true},
			{Column: "score", Expr: "? + ?", Ps: []int{9, 10}},
			{Column: "score", PlusP: intPointer(10)},
			{Column: "score", MinusP: intPointer(11)},
		},
		OnDuplicate: []ir.Assign{{Column: "title", P: intPointer(8)}},
		Optimistic:  &ir.Optimist{Column: "version", P: 9}, Raw: &ir.Raw{SQL: "SELECT ?", Ps: []int{10}},
	}

	converted, err := compilerbridge.RequestFromProto(input)
	if err != nil {
		t.Fatal(err)
	}
	gotJSON, err := json.Marshal(converted)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("request conversion mismatch\n got: %s\nwant: %s", gotJSON, wantJSON)
	}
	wire, err := compilerbridge.RequestToProto(want)
	if err != nil {
		t.Fatal(err)
	}
	roundTripped, err := compilerbridge.RequestFromProto(wire)
	if err != nil {
		t.Fatal(err)
	}
	roundTripJSON, err := json.Marshal(roundTripped)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(roundTripJSON, wantJSON) {
		t.Fatalf("request round trip mismatch\n got: %s\nwant: %s", roundTripJSON, wantJSON)
	}
}

func TestPlanToProtoPreservesEveryField(t *testing.T) {
	input := &planmodel.Plan{SchemaHash: "schema", Kind: "paginate", Steps: []planmodel.Step{{
		ID: 2, Role: "relation", SQL: "SELECT ?", BindSlots: []planmodel.BindSlot{{From: "param", Param: 3, Transform: "like_contains", Name: "aes", Step: 1, Column: "title", HostStyles: []string{"aes", "hex"}, ColType: "datetime"}},
		Parent: &planmodel.ParentRef{Step: 1, Keys: []planmodel.KeyRef{{Column: "service_seq", Index: 4}}, IfParent: &planmodel.IfParent{Column: "is_display", Index: 5, Param: 6}},
		Assemble: &planmodel.Assemble{Entity: "battle", Alias: "b", Columns: []planmodel.OutCol{{Index: 0, Name: "id", Column: "seq", Type: "i64", Styles: []string{"hex"}, Hidden: true}}, Children: []*planmodel.Child{{
			Rel: "user", Kind: "join", Step: 3, ParentKeys: []planmodel.KeyRef{{Column: "user_seq", Index: 1}}, ChildKeys: []planmodel.KeyRef{{Column: "seq", Index: 2}}, Key: []planmodel.KeyRef{{Column: "seq", Index: 3}}, Flatten: true, Cascade: true,
			Assemble: &planmodel.Assemble{Entity: "user", Alias: "u", Columns: []planmodel.OutCol{}},
		}}},
	}}}

	got := compilerbridge.PlanToProto(input)
	if got.SchemaHash != "schema" || got.Kind != compilerv1.QueryKind_QUERY_KIND_PAGINATE || len(got.Steps) != 1 {
		t.Fatalf("plan header=%#v", got)
	}
	step := got.Steps[0]
	if step.Id != 2 || step.Role != "relation" || step.Sql != "SELECT ?" || len(step.Binds) != 1 || step.Parent == nil || step.Assemble == nil {
		t.Fatalf("step=%#v", step)
	}
	bind := step.Binds[0]
	if bind.Source != "param" || bind.Parameter != 3 || bind.Transform != "like_contains" || bind.Name != "aes" || bind.Step != 1 || bind.Column != "title" || !reflect.DeepEqual(bind.HostStyles, []string{"aes", "hex"}) || bind.ColumnType != "datetime" {
		t.Fatalf("bind=%#v", bind)
	}
	if step.Parent.Step != 1 || len(step.Parent.Keys) != 1 || step.Parent.Keys[0].Column != "service_seq" || step.Parent.Keys[0].Index != 4 || step.Parent.IfParent == nil || step.Parent.IfParent.Column != "is_display" || step.Parent.IfParent.Index != 5 || step.Parent.IfParent.Parameter != 6 {
		t.Fatalf("parent=%#v", step.Parent)
	}
	column := step.Assemble.Columns[0]
	if column.Index != 0 || column.Name != "id" || column.Column != "seq" || column.Type != "i64" || !reflect.DeepEqual(column.Styles, []string{"hex"}) || !column.Hidden {
		t.Fatalf("column=%#v", column)
	}
	child := step.Assemble.Children[0]
	if child.Relation != "user" || child.Kind != "join" || child.Step != 3 || len(child.ParentKeys) != 1 || child.ParentKeys[0].Column != "user_seq" || child.ParentKeys[0].Index != 1 || len(child.ChildKeys) != 1 || child.ChildKeys[0].Column != "seq" || child.ChildKeys[0].Index != 2 || len(child.Key) != 1 || child.Key[0].Column != "seq" || child.Key[0].Index != 3 || !child.Flatten || !child.Cascade || child.Assemble == nil || child.Assemble.Entity != "user" || child.Assemble.Alias != "u" || len(child.Assemble.Columns) != 0 {
		t.Fatalf("child=%#v", child)
	}
	roundTrip, err := compilerbridge.PlanFromProto(got)
	if err != nil {
		t.Fatal(err)
	}
	inputJSON, _ := json.Marshal(input)
	roundTripJSON, _ := json.Marshal(roundTrip)
	if !bytes.Equal(roundTripJSON, inputJSON) {
		t.Fatalf("plan round trip mismatch\n got: %s\nwant: %s", roundTripJSON, inputJSON)
	}
}

func TestCompilerConnectPreservesCompleteRequestAndPlan(t *testing.T) {
	schemaJSON, err := os.ReadFile("../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	compiler, err := engine.LoadJSON(schemaJSON, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	path, handler := compilerv1connect.NewCompilerServiceHandler(&compilerServer{engine: compiler})
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	defer server.Close()
	client := compilerv1connect.NewCompilerServiceClient(server.Client(), server.URL)

	scope := uint32(0)
	parameter := uint32(1)
	response, err := client.Compile(context.Background(), connect.NewRequest(&compilerv1.CompileRequest{
		IrVersion:      1,
		SchemaHash:     compiler.M.SchemaHash,
		Kind:           compilerv1.QueryKind_QUERY_KIND_ALL,
		ParameterCount: 2,
		Root: &compilerv1.QueryNode{
			Entity:         "battle",
			ScopeParameter: &scope,
			Where:          &compilerv1.Group{Items: []*compilerv1.Item{{Value: &compilerv1.Item_Predicate{Predicate: &compilerv1.Predicate{Column: "service_seq", Operator: "eq", Parameter: &parameter}}}}},
			Order:          []*compilerv1.Order{{Column: "seq", Descending: true}},
			Limit:          &compilerv1.Limit{Offset: 0, Count: 20},
		},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if response.Msg.GetError() != nil {
		t.Fatalf("compile error: %#v", response.Msg.GetError())
	}
	if response.Msg.GetPlan() == nil || response.Msg.GetPlan().SchemaHash != compiler.M.SchemaHash || response.Msg.GetPlan().Kind != compilerv1.QueryKind_QUERY_KIND_ALL || len(response.Msg.GetPlan().Steps) != 1 {
		t.Fatalf("plan=%#v", response.Msg.GetPlan())
	}
	step := response.Msg.GetPlan().Steps[0]
	if step.Assemble == nil || len(step.Assemble.Columns) == 0 || len(step.Binds) < 4 {
		t.Fatalf("incomplete plan=%#v", step)
	}
	if step.Binds[len(step.Binds)-2].Parameter != scope || step.Binds[len(step.Binds)-1].Parameter != parameter {
		t.Fatalf("scope and predicate bind order=%#v", step.Binds)
	}

	metadata, err := client.GetMetadata(context.Background(), connect.NewRequest(&compilerv1.GetMetadataRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Msg.SchemaHash != compiler.M.SchemaHash || metadata.Msg.Dialect != "mysql" || metadata.Msg.IrVersion != 1 {
		t.Fatalf("metadata=%#v", metadata.Msg)
	}
}

func TestCompilerConnectReturnsTypedCompileError(t *testing.T) {
	schemaJSON, err := os.ReadFile("../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	compiler, err := engine.LoadJSON(schemaJSON, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	path, handler := compilerv1connect.NewCompilerServiceHandler(&compilerServer{engine: compiler})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path[:len(path)] == path {
			handler.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	client := compilerv1connect.NewCompilerServiceClient(server.Client(), server.URL)
	response, err := client.Compile(context.Background(), connect.NewRequest(&compilerv1.CompileRequest{IrVersion: 1, SchemaHash: compiler.M.SchemaHash, Kind: compilerv1.QueryKind_QUERY_KIND_ALL, Root: &compilerv1.QueryNode{Entity: "missing"}}))
	if err != nil {
		t.Fatal(err)
	}
	if response.Msg.GetError() == nil || response.Msg.GetError().Code != "ENTITY_UNKNOWN" || response.Msg.GetPlan() != nil {
		t.Fatalf("response=%#v", response.Msg)
	}
}
