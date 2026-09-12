package orm

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
	_ "modernc.org/sqlite"
)

type cachePlanCompiler struct{ calls *int }

func (c cachePlanCompiler) Compile(_ context.Context, r *ir.Request) (*plan.Plan, error) {
	*c.calls = *c.calls + 1
	return &plan.Plan{SchemaHash: r.SchemaHash, Kind: r.Kind, Steps: []plan.Step{{Role: "main", SQL: r.Kind}}}, nil
}

func TestPlanCacheEvictsOldestAndCloseRejectsUse(t *testing.T) {
	sqlDB, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	eng, err := engine.LoadJSON(mustSchemaJSON(t), "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	db := &DB{SQL: sqlDB, Eng: eng, compiler: cachePlanCompiler{calls: &calls}, cfg: Config{PlanCacheSize: 2}, plans: map[uint64]*cached{}, stmts: map[string]*sql.Stmt{}}
	requests := []*Req{NewReq(eng, "all", "battle"), NewReq(eng, "count", "battle"), NewReq(eng, "one", "battle")}
	for _, request := range requests {
		if _, err := db.Plan(context.Background(), request); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Plan(context.Background(), requests[0]); err != nil {
		t.Fatal(err)
	}
	if calls != 4 {
		t.Fatalf("compiler calls=%d, want 4 after oldest eviction", calls)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Plan(context.Background(), requests[1]); err == nil || !strings.Contains(err.Error(), "database is closed") {
		t.Fatalf("plan after close error=%v", err)
	}
}

func mustSchemaJSON(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("../../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func (c cachePlanCompiler) Metadata(context.Context) (*compilerv1.GetMetadataResponse, error) {
	return &compilerv1.GetMetadataResponse{SchemaHash: "unused", Dialect: "sqlite", IrVersion: ir.Version}, nil
}

func TestStatementCacheEvictsOldestAndCloseIsIdempotent(t *testing.T) {
	sqlDB, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db := &DB{SQL: sqlDB, cfg: Config{StatementCacheSize: 2}, stmts: map[string]*sql.Stmt{}}
	ctx := context.Background()
	for _, query := range []string{"SELECT 1", "SELECT 2", "SELECT 3"} {
		if _, err := db.stmt(ctx, query); err != nil {
			t.Fatalf("prepare %q: %v", query, err)
		}
	}
	if got := len(db.stmts); got != 2 {
		t.Fatalf("statement cache size=%d, want 2", got)
	}
	if _, ok := db.stmts["SELECT 1"]; ok {
		t.Fatal("oldest statement was not evicted")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db.planMu.RLock()
	if len(db.plans) != 0 || len(db.planOrder) != 0 {
		db.planMu.RUnlock()
		t.Fatal("plan cache was not cleared on close")
	}
	db.planMu.RUnlock()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.stmt(ctx, "SELECT 4"); err == nil {
		t.Fatal("prepare after close succeeded")
	}
}

func TestPlanCacheConcurrentAccess(t *testing.T) {
	sqlDB, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	eng, err := engine.LoadJSON(mustSchemaJSON(t), "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	var callsMu sync.Mutex
	counting := cachePlanCompilerFunc(func(ctx context.Context, r *ir.Request) (*plan.Plan, error) {
		callsMu.Lock()
		calls++
		callsMu.Unlock()
		return &plan.Plan{SchemaHash: r.SchemaHash, Kind: r.Kind, Steps: []plan.Step{{Role: "main", SQL: r.Kind}}}, nil
	})
	db := &DB{SQL: sqlDB, Eng: eng, compiler: counting, cfg: Config{PlanCacheSize: 4}, plans: map[uint64]*cached{}, stmts: map[string]*sql.Stmt{}}
	request := NewReq(eng, "all", "battle")
	const workers = 32
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			compiled, err := db.Plan(context.Background(), request)
			if err == nil && (compiled == nil || compiled.Kind != "all") {
				err = fmt.Errorf("unexpected compiled plan: %#v", compiled)
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	db.planMu.RLock()
	cacheSize := len(db.plans)
	db.planMu.RUnlock()
	if cacheSize != 1 {
		t.Fatalf("concurrent plan cache size=%d, want 1", cacheSize)
	}
}

type cachePlanCompilerFunc func(context.Context, *ir.Request) (*plan.Plan, error)

func (f cachePlanCompilerFunc) Compile(ctx context.Context, r *ir.Request) (*plan.Plan, error) {
	return f(ctx, r)
}

func (cachePlanCompilerFunc) Metadata(context.Context) (*compilerv1.GetMetadataResponse, error) {
	return &compilerv1.GetMetadataResponse{SchemaHash: "unused", Dialect: "sqlite", IrVersion: ir.Version}, nil
}
