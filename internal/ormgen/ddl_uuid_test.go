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
