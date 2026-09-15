package main

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestDDLUsesExternalForeignKey(t *testing.T) {
	d, err := schema.Parse("erDiagram\n  item {\n    uuid id PK\n  }\n  %% orm:table entity=item name=example.items\n  %% orm:foreign entity=item columns=id references=core.instance(instance_uuid) name=item_instance\n")
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
	if !strings.Contains(ddl, `REFERENCES "core"."instance" ("instance_uuid")`) {
		t.Fatalf("DDL does not contain external foreign key:\n%s", ddl)
	}
}
