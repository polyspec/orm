package ormgen

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestDDLUsesNativePostgresUUID(t *testing.T) {
	d, err := schema.Parse("erDiagram\n  item {\n    uuid id PK\n  }\n")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	ddl, err := renderDDL(m, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, `"id" uuid NOT NULL`) {
		t.Fatalf("DDL does not preserve native uuid type:\n%s", ddl)
	}
}

func TestMySQLUUIDIsChar36(t *testing.T) {
	d, err := schema.Parse("erDiagram\n  item {\n    uuid id PK\n    uuid ref \"?\"\n  }\n")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	ddl, err := renderDDL(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, "`id` char(36) NOT NULL") || !strings.Contains(ddl, "`ref` char(36)") || strings.Contains(ddl, " uuid") {
		t.Fatalf("MySQL DDL does not store uuid as char(36):\n%s", ddl)
	}
	live, err := schema.Parse("erDiagram\n  item {\n    char(36) id PK\n    char(36) ref \"?\"\n  }\n")
	if err != nil {
		t.Fatal(err)
	}
	liveManifest, err := schema.Build(live)
	if err != nil {
		t.Fatal(err)
	}
	diff, err := renderDiff(liveManifest, m, "mysql", false)
	if err != nil || !strings.Contains(diff, "-- no changes") {
		t.Fatalf("a live char(36) column differs from a declared uuid column: %v\n%s", err, diff)
	}
}
