package main

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestRenderMermaidUsesImportedForeignKeyTargetAndDeleteAction(t *testing.T) {
	tables := []impTable{
		{Name: "owner", Columns: []impColumn{{Name: "id", Type: "bigint", Key: "PRI", Default: "\x00"}}},
		{
			Name: "item",
			Columns: []impColumn{
				{Name: "id", Type: "bigint", Key: "PRI", Default: "\x00"},
				{Name: "owner_id", Type: "bigint", Default: "\x00"},
			},
			ForeignKeys: []impForeignKey{{
				Name: "fk_item_owner_id", Columns: []string{"owner_id"},
				Target: "owner", TargetColumns: []string{"id"}, OnDelete: "cascade",
			}},
		},
	}

	source := renderMermaid(tables, nil)
	if !strings.Contains(source, ": owner_id cascade") {
		t.Fatalf("foreign key metadata missing from import:\n%s", source)
	}
	diagram, err := schema.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	column := manifest.Entities["item"].Column("owner_id")
	if column.Ref == nil || column.Ref.Entity != "owner" || column.Ref.Column != "id" {
		t.Fatalf("foreign key target not restored: %#v", column.Ref)
	}
	if relation := manifest.Entities["item"].Relations["owner"]; relation == nil || relation.OnDelete != "cascade" {
		t.Fatalf("foreign key action not restored: %#v", relation)
	}
}
