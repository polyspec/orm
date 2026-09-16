package ormgen

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestDDLUsesImmutableTrigger(t *testing.T) {
	d, err := schema.Parse("erDiagram\n  revision {\n    uuid id PK\n  }\n  %% orm:immutable entity=revision\n")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	postgres, err := renderDDL(m, "postgres")
	if err != nil || !strings.Contains(postgres, "CREATE TRIGGER") || !strings.Contains(postgres, "BEFORE UPDATE OR DELETE OR TRUNCATE") {
		t.Fatalf("postgres immutable DDL = %v\n%s", err, postgres)
	}
	sqlite, err := renderDDL(m, "sqlite")
	if err != nil || !strings.Contains(sqlite, "revision_immutable_update") || !strings.Contains(sqlite, "revision_immutable_delete") {
		t.Fatalf("sqlite immutable DDL = %v\n%s", err, sqlite)
	}
}
