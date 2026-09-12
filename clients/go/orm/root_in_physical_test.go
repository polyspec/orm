package orm

import (
	"context"
	"database/sql"
	"testing"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
	_ "modernc.org/sqlite"
)

func TestScalarSplitsLargeRootINAgainstSQLite(t *testing.T) {
	sqlDB, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if _, err := sqlDB.Exec(`CREATE TABLE root_in_test (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 1000; i++ {
		if _, err := sqlDB.Exec(`INSERT INTO root_in_test (id) VALUES (?)`, i); err != nil {
			t.Fatal(err)
		}
	}
	r := &Req{IR: ir.Request{IRVersion: ir.Version, SchemaHash: "root-in", Kind: "count", Query: ir.Query{Entity: "root_in_test"}}, Params: make([]any, 1000)}
	where := &ir.Group{}
	r.IR.Query.Where = where
	for i := range r.Params {
		r.Params[i] = int64(i + 1)
	}
	ps := make([]int, len(r.Params))
	for i := range ps {
		ps[i] = i
	}
	where.Items = []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "in", Ps: ps}}}
	db := &DB{SQL: sqlDB, compiler: rootINPlanCompiler{}, driver: "sqlite", cfg: Config{PlanCacheSize: 16, StatementCacheSize: 16}, plans: map[uint64]*cached{}, stmts: map[string]*sql.Stmt{}}
	got, err := Scalar(context.Background(), db, r)
	if err != nil {
		t.Fatalf("large root IN: %v", err)
	}
	if got != int64(1000) {
		t.Fatalf("count=%v, want 1000", got)
	}
}

type rootINPlanCompiler struct{}

func (rootINPlanCompiler) Metadata(context.Context) (*compilerv1.GetMetadataResponse, error) {
	return &compilerv1.GetMetadataResponse{SchemaHash: "root-in", Dialect: "sqlite", IrVersion: ir.Version}, nil
}

func (rootINPlanCompiler) Compile(_ context.Context, r *ir.Request) (*plan.Plan, error) {
	params := r.Query.Where.Items[0].Pred.Ps
	count := len(params)
	slots := make([]plan.BindSlot, count)
	for i := range slots {
		slots[i] = plan.BindSlot{From: "param", Param: params[i]}
	}
	placeholders := ""
	for i := 0; i < count; i++ {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}
	return &plan.Plan{SchemaHash: r.SchemaHash, Kind: r.Kind, Steps: []plan.Step{{Role: "main", SQL: "SELECT COUNT(*) FROM root_in_test WHERE id IN (" + placeholders + ")", BindSlots: slots}}}, nil
}
