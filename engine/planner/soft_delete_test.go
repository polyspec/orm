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
}

func TestRelationExistenceUsesCorrelatedSubquery(t *testing.T) {
	d, err := schema.Parse(`erDiagram
 account {
 bigint id PK
 }
 item {
 bigint id PK
 bigint account_id FK
 varchar(16) state
 }
 account ||--o{ item : "account_id (account / items)"
`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	p := &Planner{M: m, D: dialect.SQLite{}}
	param := 0
	req := &ir.Request{IRVersion: ir.Version, SchemaHash: m.SchemaHash, Kind: "all", Query: ir.Query{
		Entity: "account",
		Where:  &ir.Group{Items: []ir.Item{{Nav: &ir.Nav{Rel: "items", Mode: "exists", Group: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "state", Op: "eq", P: &param}}}}}}}},
	}, NParams: 1}
	if err := ir.Validate(m, req); err != nil {
		t.Fatalf("existence predicate was rejected by IR validation: %v", err)
	}
	plan, err := p.Compile(req)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan.Steps[0].SQL, `EXISTS (SELECT 1 FROM "item" AS "exists__items" WHERE "exists__items"."account_id" = "a"."id" AND ("exists__items"."state" = ?))`) {
		t.Fatalf("existence predicate SQL differs: %s", plan.Steps[0].SQL)
	}
}

func TestRelationCountUsesCorrelatedSubquery(t *testing.T) {
	d, err := schema.Parse(`erDiagram
 account {
 bigint id PK
 }
 item {
 bigint id PK
 bigint account_id FK
 }
 account ||--o{ item : "account_id (account / items)"
`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	param := 0
	req := &ir.Request{IRVersion: ir.Version, SchemaHash: m.SchemaHash, Kind: "all", NParams: 1, Query: ir.Query{Entity: "account", Where: &ir.Group{Items: []ir.Item{{Nav: &ir.Nav{Rel: "items", Mode: "count", CountOp: "gte", P: &param, Group: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "gt", P: &param}}}}}}}}}}
	if err := ir.Validate(m, req); err != nil {
		t.Fatalf("count predicate was rejected by IR validation: %v", err)
	}
	plan, err := (&Planner{M: m, D: dialect.SQLite{}}).Compile(req)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan.Steps[0].SQL, `SELECT COUNT(*) FROM "item" AS "exists__items"`) || !strings.Contains(plan.Steps[0].SQL, `>= ?`) {
		t.Fatalf("count predicate SQL differs: %s", plan.Steps[0].SQL)
	}
}
