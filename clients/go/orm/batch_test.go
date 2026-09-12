package orm

import (
	"context"
	"strings"
	"testing"

	"database/sql"
	"path/filepath"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
	_ "modernc.org/sqlite"
)

type batchCompiler struct{}

func (batchCompiler) Metadata(context.Context) (*compilerv1.GetMetadataResponse, error) {
	return &compilerv1.GetMetadataResponse{SchemaHash: "batch", Dialect: "sqlite", IrVersion: ir.Version}, nil
}

func (batchCompiler) Compile(_ context.Context, r *ir.Request) (*plan.Plan, error) {
	return &plan.Plan{SchemaHash: r.SchemaHash, Kind: r.Kind, Steps: []plan.Step{{
		Role: "main",
		SQL:  "INSERT INTO batch_test (id, name) VALUES (?, ?)",
		BindSlots: []plan.BindSlot{
			{From: "param", Param: 0},
			{From: "param", Param: 1},
		},
	}}}, nil
}

func TestBatchWriteValidatesKindAndEmptyInput(t *testing.T) {
	ctx := context.Background()
	if got, err := BatchWrite(ctx, nil, nil, "merge", BatchOptions{}); err == nil || !strings.Contains(err.Error(), `batch kind "merge" is not supported`) || got != (BatchResult{}) {
		t.Fatalf("invalid batch kind: result=%+v err=%v", got, err)
	}
	got, err := BatchWrite(ctx, nil, nil, "insert", BatchOptions{ChunkSize: 1})
	if err != nil || got != (BatchResult{}) {
		t.Fatalf("empty batch: result=%+v err=%v", got, err)
	}
}

func TestBatchWriteUsesOneTransactionAndRollsBackOnFailure(t *testing.T) {
	sqlDB, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "batch.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if _, err := sqlDB.Exec(`CREATE TABLE batch_test (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`); err != nil {
		t.Fatal(err)
	}
	db := &DB{SQL: sqlDB, compiler: batchCompiler{}, cfg: Config{PlanCacheSize: 8, StatementCacheSize: 8}, plans: map[uint64]*cached{}, stmts: map[string]*sql.Stmt{}}
	request := func(id int64, name string) *Req {
		r := &Req{IR: ir.Request{IRVersion: ir.Version, SchemaHash: "batch", Kind: "insert", Query: ir.Query{Entity: "batch_test"}}, Params: []any{id, name}}
		return r
	}
	result, err := BatchWrite(context.Background(), db, []*Req{request(1, "one"), request(2, "two")}, "insert", BatchOptions{ChunkSize: 1})
	if err != nil || result != (BatchResult{Attempted: 2, Affected: 2, Inserted: 2}) {
		t.Fatalf("successful batch: result=%+v err=%v", result, err)
	}
	result, err = BatchWrite(context.Background(), db, []*Req{request(3, "three"), request(1, "duplicate")}, "insert", BatchOptions{ChunkSize: 1})
	if err == nil || result.Attempted != 2 {
		t.Fatalf("failed batch: result=%+v err=%v", result, err)
	}
	var count int
	if err := sqlDB.QueryRow("SELECT COUNT(*) FROM batch_test WHERE id = 3").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("failed batch committed partial row: count=%d", count)
	}
}
