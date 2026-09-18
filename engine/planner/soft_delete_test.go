package planner

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/dialect"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
)

func softDeleteManifest(t *testing.T) *schema.Manifest {
	t.Helper()
	d, err := schema.Parse("erDiagram\n account {\n bigint id PK\n datetime deleted_at \"?\"\n }\n %% soft_delete account deleted_at\n")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSoftDeleteFiltersReads(t *testing.T) {
	p := &Planner{M: softDeleteManifest(t), D: dialect.SQLite{}}
	plan, err := p.Compile(&ir.Request{Kind: "all", Query: ir.Query{Entity: "account"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan.Steps[0].SQL, `"a"."deleted_at" IS NULL`) {
		t.Fatalf("read plan omitted soft-delete predicate: %s", plan.Steps[0].SQL)
	}
}

func TestSoftDeleteConvertsDeleteToTimestampedUpdate(t *testing.T) {
	p := &Planner{M: softDeleteManifest(t), D: dialect.SQLite{}}
	param := 0
	plan, err := p.Compile(&ir.Request{
		Kind:    "delete",
		Query:   ir.Query{Entity: "account", Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "eq", P: &param}}}}},
		NParams: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	sql := plan.Steps[0].SQL
	if !strings.HasPrefix(sql, `UPDATE "account" SET "deleted_at" = ?`) || !strings.Contains(sql, `"account"."deleted_at" IS NULL`) {
		t.Fatalf("delete plan did not use guarded soft-delete update: %s", sql)
	}
	if len(plan.Steps[0].BindSlots) != 2 || plan.Steps[0].BindSlots[0].From != "now" || plan.Steps[0].BindSlots[1].From != "param" {
		t.Fatalf("delete plan bind slots differ: %#v", plan.Steps[0].BindSlots)
	}
}
