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

func TestPostgresFulltextColumnsParsesGeneratedIndexDefinition(t *testing.T) {
	definition := `CREATE INDEX item_ft_name_body ON public.item USING gin (to_tsvector('simple'::regconfig, (((COALESCE(name, ''::character varying))::text || ' '::text) || COALESCE(body, ''::text))))`
	got, err := postgresFulltextColumns(definition)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"name", "body"}
	if len(got) != len(want) {
		t.Fatalf("columns=%v want=%v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("columns=%v want=%v", got, want)
		}
	}
}

func TestPostgresFulltextColumnsRejectsUnknownExpression(t *testing.T) {
	if _, err := postgresFulltextColumns(`CREATE INDEX custom ON item USING gin (jsonb_path_ops(data))`); err == nil {
		t.Fatal("expected unsupported expression error")
	}
}

func TestPostgresLogicalIndexNameRemovesGeneratedTablePrefix(t *testing.T) {
	if got := postgresLogicalIndexName("migration_item", "migration_item_new_code_idx", false); got != "new_code_idx" {
		t.Fatalf("logical index name=%q", got)
	}
	if got := postgresLogicalIndexName("migration_item", "uq_migration_item_code", true); got != "uq_migration_item_code" {
		t.Fatalf("unique constraint name=%q", got)
	}
}
