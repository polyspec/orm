package engine

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func compositeEngine(t *testing.T, dialect string) *Engine {
	t.Helper()
	diagram, err := schema.Parse(`erDiagram
  account {
    bigint tenant_id PK
    bigint id PK
    varchar(20) name
  }
  membership {
    bigint tenant_id PK, FK "-> account.tenant_id"
    bigint account_id PK, FK "-> account.id"
    bigint user_id
  }
  account ||--o{ membership : "(tenant_id, account_id) (account / memberships) cascade"
`)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	engine, err := New(manifest, dialect)
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func TestCompositeRelationPlanUsesEveryKeyComponent(t *testing.T) {
	e := compositeEngine(t, "mysql")
	plan := compile(t, e, `"kind":"all","entity":"account","relations":[{"rel":"memberships","query":{"entity":"membership","limit_per_parent":2}}]`)
	if len(plan.Steps) != 2 {
		t.Fatalf("steps = %d", len(plan.Steps))
	}
	relation := plan.Steps[1]
	want := "(`a`.`tenant_id`, `a`.`account_id`) IN ((?))"
	if !strings.Contains(relation.SQL, want) {
		t.Fatalf("relation SQL missing %s: %s", want, relation.SQL)
	}
	if !strings.Contains(relation.SQL, "PARTITION BY `a`.`tenant_id`, `a`.`account_id`") {
		t.Fatalf("relation partition omits a key: %s", relation.SQL)
	}
	if relation.Parent == nil || len(relation.Parent.Keys) != 2 || relation.Parent.Keys[0].Column != "tenant_id" || relation.Parent.Keys[1].Column != "id" {
		t.Fatalf("parent keys differ: %#v", relation.Parent)
	}
	child := plan.Steps[0].Assemble.Children[0]
	if len(child.ParentKeys) != 2 || len(child.ChildKeys) != 2 || len(child.Key) != 2 {
		t.Fatalf("child key structures differ: %#v", child)
	}

	join := compile(t, e, `"kind":"all","entity":"membership","joins":[{"rel":"account","kind":"inner","query":{"entity":"account"}}]`)
	if !strings.Contains(join.Steps[0].SQL, "`a`.`tenant_id` = `account`.`tenant_id` AND `a`.`account_id` = `account`.`id`") {
		t.Fatalf("join SQL omits a key: %s", join.Steps[0].SQL)
	}
}
