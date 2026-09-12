package main

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func testManifest(columns ...*schema.Col) *schema.Manifest {
	e := &schema.Entity{Name: "thing", Table: "thing", PK: []string{"id"}, Columns: columns}
	return &schema.Manifest{SchemaHash: "test", Order: []string{"thing"}, Entities: map[string]*schema.Entity{"thing": e}}
}

func TestRenderDiffAddColumnIsSafe(t *testing.T) {
	old := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true})
	now := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true}, &schema.Col{Name: "name", Type: "string", Raw: "varchar(20)"})
	sql, err := renderDiff(old, now, "mysql", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sql, "ALTER TABLE `thing` ADD COLUMN `name` varchar(20) NOT NULL;") {
		t.Fatalf("unexpected migration: %s", sql)
	}
}

func TestRenderDiffRejectsDestructiveChange(t *testing.T) {
	old := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true}, &schema.Col{Name: "name", Type: "string", Raw: "varchar(20)"})
	now := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true})
	if _, err := renderDiff(old, now, "mysql", false); err == nil || !strings.Contains(err.Error(), "--allow-destructive") {
		t.Fatalf("expected destructive-change error, got %v", err)
	}
	sql, err := renderDiff(old, now, "mysql", true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sql, "DROP COLUMN `name`") {
		t.Fatalf("unexpected migration: %s", sql)
	}
}

func TestRenderDiffIsDeterministic(t *testing.T) {
	old := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true})
	now := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true}, &schema.Col{Name: "z", Type: "string", Raw: "text"}, &schema.Col{Name: "a", Type: "string", Raw: "text"})
	a, err := renderDiff(old, now, "postgres", false)
	if err != nil {
		t.Fatal(err)
	}
	b, err := renderDiff(old, now, "postgres", false)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("migration output is not deterministic")
	}
}
