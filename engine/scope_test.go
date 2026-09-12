package engine

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/schema"
)

func scopeEngine(t *testing.T, driver string) *Engine {
	t.Helper()
	d, err := schema.Parse("erDiagram\n  tenant_item {\n    bigint id PK\n    bigint tenant_id\n    varchar(32) value\n  }\n  plain {\n    bigint id PK\n  }\n  %% scope tenant_item tenant_id\n")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	e, err := New(m, driver)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func scopeRelationEngine(t *testing.T) *Engine {
	t.Helper()
	d, err := schema.Parse("erDiagram\n  tenant_parent {\n    bigint id PK\n    bigint tenant_id\n  }\n  tenant_child {\n    bigint id PK\n    bigint parent_id FK\n    bigint tenant_id\n  }\n  tenant_parent ||--o{ tenant_child : parent_id\n  %% scope tenant_parent tenant_id\n  %% scope tenant_child tenant_id\n")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	e, err := New(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func compileScope(t *testing.T, e *Engine, request ir.Request) (*plan.Plan, error) {
	t.Helper()
	request.IRVersion = ir.Version
	request.SchemaHash = e.M.SchemaHash
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	out, err := e.Compile(body)
	if err != nil {
		return nil, err
	}
	var result plan.Plan
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatal(err)
	}
	return &result, nil
}

func TestScopeIsOutsideOrGroupAndAppliesToWrites(t *testing.T) {
	for _, driver := range []string{"mysql", "postgres", "sqlite"} {
		t.Run(driver, func(t *testing.T) {
			e := scopeEngine(t, driver)
			scope := 0
			p1, p2 := 1, 2
			where := &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "value", Op: "eq", P: &p1}}, {Pred: &ir.Pred{Conn: "or", Column: "value", Op: "eq", P: &p2}}}}
			selectPlan, err := compileScope(t, e, ir.Request{Kind: "all", Query: ir.Query{Entity: "tenant_item", ScopeP: &scope, Where: where}, NParams: 3})
			if err != nil {
				t.Fatal(err)
			}
			sql := selectPlan.Steps[0].SQL
			if !strings.Contains(sql, "tenant_id") || !strings.Contains(sql, " AND (") || !strings.Contains(sql, " OR ") {
				t.Fatalf("scope precedence: %s", sql)
			}

			id, value := 1, 2
			insertPlan, err := compileScope(t, e, ir.Request{Kind: "insert", Query: ir.Query{Entity: "tenant_item", ScopeP: &scope}, Set: []ir.Assign{{Column: "id", P: &id}, {Column: "value", P: &value}}, NParams: 3})
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(insertPlan.Steps[0].SQL, "tenant_id") || len(insertPlan.Steps[0].BindSlots) != 3 {
				t.Fatalf("scoped insert: %+v", insertPlan.Steps[0])
			}

			for _, kind := range []string{"update", "delete"} {
				r := ir.Request{Kind: kind, Query: ir.Query{Entity: "tenant_item", ScopeP: &scope, Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "eq", P: &id}}}}}, NParams: 3}
				if kind == "update" {
					r.Set = []ir.Assign{{Column: "value", P: &value}}
				}
				p, err := compileScope(t, e, r)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(p.Steps[0].SQL, "tenant_id") || !strings.Contains(p.Steps[0].SQL, " AND ") {
					t.Fatalf("scoped %s: %s", kind, p.Steps[0].SQL)
				}
			}
		})
	}
}

func TestScopeRejectsInvalidUse(t *testing.T) {
	e := scopeEngine(t, "mysql")
	scope, other := 0, 1
	cases := []ir.Request{
		{Kind: "all", Query: ir.Query{Entity: "plain", ScopeP: &scope}, NParams: 1},
		{Kind: "raw", Query: ir.Query{Entity: "tenant_item", ScopeP: &scope}, Raw: &ir.Raw{SQL: "SELECT * FROM {table}"}, NParams: 1},
		{Kind: "insert", Query: ir.Query{Entity: "tenant_item", ScopeP: &scope}, Set: []ir.Assign{{Column: "tenant_id", P: &other}}, NParams: 2},
		{Kind: "update", Query: ir.Query{Entity: "tenant_item", ScopeP: &scope, Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "id", Op: "eq", P: &other}}}}}, Set: []ir.Assign{{Column: "tenant_id", P: &scope}}, NParams: 2},
	}
	for i, request := range cases {
		if _, err := compileScope(t, e, request); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

func TestJoinAndRelationApplyChildScope(t *testing.T) {
	e := scopeRelationEngine(t)
	rootScope, childScope := 0, 1
	joinPlan, err := compileScope(t, e, ir.Request{
		Kind:    "all",
		Query:   ir.Query{Entity: "tenant_child", ScopeP: &rootScope, Joins: []*ir.Join{{Rel: "parent", Kind: "left", Query: &ir.Query{Entity: "tenant_parent", ScopeP: &childScope}}}},
		NParams: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	joinSQL := joinPlan.Steps[0].SQL
	if !strings.Contains(joinSQL, "LEFT JOIN") || !strings.Contains(joinSQL, "ON `a`.`parent_id` = `parent`.`id` AND `parent`.`tenant_id` = ?") {
		t.Fatalf("join scope must be in ON: %s", joinSQL)
	}

	relationPlan, err := compileScope(t, e, ir.Request{
		Kind:    "all",
		Query:   ir.Query{Entity: "tenant_parent", ScopeP: &rootScope, Relations: []*ir.Relation{{Rel: "tenant_childs", Query: &ir.Query{Entity: "tenant_child", ScopeP: &childScope}}}},
		NParams: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(relationPlan.Steps) != 2 || !strings.Contains(relationPlan.Steps[1].SQL, "`a`.`tenant_id` = ?") || !strings.Contains(relationPlan.Steps[1].SQL, "`a`.`parent_id` IN (?)") {
		t.Fatalf("relation scope: %+v", relationPlan.Steps)
	}
}
