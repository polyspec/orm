package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

func TestScopePhysicalSQLite(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "scope.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	assertPhysicalScope(t, context.Background(), db, "sqlite")
}

func assertPhysicalScope(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	src := "erDiagram\n  tenant_probe {\n    bigint id PK\n    bigint tenant_id\n    varchar(32) value\n  }\n  %% scope tenant_probe tenant_id\n"
	diagram, err := schema.Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	ddl, err := renderCreateDDL(manifest, driver)
	if err != nil {
		t.Fatal(err)
	}
	q := func(name string) string {
		if driver == "mysql" {
			return "`" + name + "`"
		}
		return `"` + name + `"`
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS "+q("tenant_probe")); err != nil {
		t.Fatal(err)
	}
	defer db.ExecContext(context.Background(), "DROP TABLE IF EXISTS "+q("tenant_probe"))
	if err := executeMigration(ctx, db, driver, ddl); err != nil {
		t.Fatal(err)
	}
	compiler, err := engine.New(manifest, driver)
	if err != nil {
		t.Fatal(err)
	}

	for _, row := range []struct {
		id, tenant int
		value      string
	}{{1, 10, "owned"}, {2, 20, "other"}} {
		params := []any{row.id, row.value, row.tenant}
		scopeP, idP, valueP := 2, 0, 1
		req := ir.Request{Kind: "insert", Query: ir.Query{Entity: "tenant_probe", ScopeP: &scopeP}, Set: []ir.Assign{{Column: "id", P: &idP}, {Column: "value", P: &valueP}}, NParams: len(params)}
		p := compilePhysicalRequest(t, compiler, req)
		if _, err := db.ExecContext(ctx, p.Steps[0].SQL, physicalArgs(t, p.Steps[0], params)...); err != nil {
			t.Fatalf("%s scoped insert tenant=%d: %v; sql=%s", driver, row.tenant, err, p.Steps[0].SQL)
		}
	}

	scopeP, valueP, idP := 0, 1, 2
	params := []any{10, "owned", 2}
	where := &ir.Group{Items: []ir.Item{
		{Pred: &ir.Pred{Column: "value", Op: "eq", P: &valueP}},
		{Pred: &ir.Pred{Conn: "or", Column: "id", Op: "eq", P: &idP}},
	}}
	selectPlan := compilePhysicalRequest(t, compiler, ir.Request{Kind: "all", Query: ir.Query{Entity: "tenant_probe", ScopeP: &scopeP, Where: where}, NParams: len(params)})
	rows, err := db.QueryContext(ctx, selectPlan.Steps[0].SQL, physicalArgs(t, selectPlan.Steps[0], params)...)
	if err != nil {
		t.Fatalf("%s scoped select: %v; sql=%s", driver, err, selectPlan.Steps[0].SQL)
	}
	defer rows.Close()
	var selected []int
	for rows.Next() {
		var id, tenant int
		var value string
		if err := rows.Scan(&id, &tenant, &value); err != nil {
			t.Fatal(err)
		}
		if tenant != 10 {
			t.Fatalf("%s selected tenant %d through tenant 10 scope", driver, tenant)
		}
		selected = append(selected, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(selected) != 1 || selected[0] != 1 {
		t.Fatalf("%s scoped OR selected ids=%v", driver, selected)
	}

	writeIDP, setP := 1, 2
	updatePlan := compilePhysicalRequest(t, compiler, ir.Request{
		Kind: "update", Query: ir.Query{Entity: "tenant_probe", ScopeP: &scopeP, Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "eq", P: &writeIDP}}}}},
		Set: []ir.Assign{{Column: "value", P: &setP}}, NParams: 3,
	})
	updateParams := []any{10, 2, "changed"}
	result, err := db.ExecContext(ctx, updatePlan.Steps[0].SQL, physicalArgs(t, updatePlan.Steps[0], updateParams)...)
	if err != nil {
		t.Fatalf("%s scoped update: %v", driver, err)
	}
	if affected, _ := result.RowsAffected(); affected != 0 {
		t.Fatalf("%s scoped update changed %d rows in another tenant", driver, affected)
	}

	deletePlan := compilePhysicalRequest(t, compiler, ir.Request{Kind: "delete", Query: ir.Query{Entity: "tenant_probe", ScopeP: &scopeP, Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "eq", P: &writeIDP}}}}}, NParams: 2})
	result, err = db.ExecContext(ctx, deletePlan.Steps[0].SQL, physicalArgs(t, deletePlan.Steps[0], []any{10, 2})...)
	if err != nil {
		t.Fatalf("%s scoped delete: %v", driver, err)
	}
	if affected, _ := result.RowsAffected(); affected != 0 {
		t.Fatalf("%s scoped delete removed %d rows in another tenant", driver, affected)
	}
	var remaining, unchanged int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*), SUM(CASE WHEN "+q("value")+" = 'other' THEN 1 ELSE 0 END) FROM "+q("tenant_probe")).Scan(&remaining, &unchanged); err != nil {
		t.Fatal(err)
	}
	if remaining != 2 || unchanged != 1 {
		t.Fatalf("%s final rows=%d unchanged=%d", driver, remaining, unchanged)
	}
}

func compilePhysicalRequest(t *testing.T, compiler *engine.Engine, req ir.Request) *plan.Plan {
	t.Helper()
	req.IRVersion = ir.Version
	req.SchemaHash = compiler.M.SchemaHash
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	result, err := compiler.Compile(body)
	if err != nil {
		t.Fatal(err)
	}
	var p plan.Plan
	if err := json.Unmarshal(result, &p); err != nil {
		t.Fatal(err)
	}
	return &p
}

func physicalArgs(t *testing.T, step plan.Step, params []any) []any {
	t.Helper()
	args := make([]any, 0, len(step.BindSlots))
	for _, slot := range step.BindSlots {
		if slot.From != "param" || slot.Transform != "" || slot.Param < 0 || slot.Param >= len(params) {
			t.Fatalf("unsupported test bind: %#v", slot)
		}
		args = append(args, params[slot.Param])
	}
	return args
}
