package ormgen

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

func TestSQLiteImportReadsNamedAndUnnamedChecksFromPhysicalDDL(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "import.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE probe (
		id INTEGER PRIMARY KEY,
		quantity INTEGER NOT NULL,
		label TEXT,
		CONSTRAINT positive_quantity CHECK (quantity >= 0),
		CHECK (length(label) <= 20)
	)`)
	if err != nil {
		t.Fatal(err)
	}
	tables, err := readTablesSQLite(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) != 1 || len(tables[0].Checks) != 2 {
		t.Fatalf("tables=%#v", tables)
	}
	if tables[0].Checks[0] != (impCheck{Name: "positive_quantity", Expr: "quantity >= 0"}) {
		t.Fatalf("named check=%#v", tables[0].Checks[0])
	}
	if tables[0].Checks[1].Name != "check_probe_2" || tables[0].Checks[1].Expr != "length(label) <= 20" {
		t.Fatalf("unnamed check=%#v", tables[0].Checks[1])
	}
	source := renderMermaid(tables, nil)
	if !strings.Contains(source, "%% check probe positive_quantity : quantity >= 0") || !strings.Contains(source, "%% check probe check_probe_2 : length(label) <= 20") {
		t.Fatalf("check directives missing:\n%s", source)
	}
	diagram, err := schema.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := schema.Build(diagram); err != nil {
		t.Fatal(err)
	}
}

func TestSQLiteChecksRejectMalformedDefinition(t *testing.T) {
	if _, err := sqliteChecks("probe", "CREATE TABLE probe (value INTEGER CHECK (value > 0"); err == nil || !strings.Contains(err.Error(), "unbalanced") {
		t.Fatalf("error=%v", err)
	}
}

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

func TestRenderMermaidPreservesCompositeForeignKeyOrderAndAction(t *testing.T) {
	tables := []impTable{
		{Name: "account", Columns: []impColumn{{Name: "tenant_id", Type: "bigint", Key: "PRI", Default: "\x00"}, {Name: "id", Type: "bigint", Key: "PRI", Default: "\x00"}}},
		{Name: "membership", Columns: []impColumn{{Name: "tenant_id", Type: "bigint", Key: "PRI", Default: "\x00"}, {Name: "account_id", Type: "bigint", Key: "PRI", Default: "\x00"}}, ForeignKeys: []impForeignKey{{
			Name: "fk_membership_account", Columns: []string{"tenant_id", "account_id"}, Target: "account", TargetColumns: []string{"tenant_id", "id"}, OnDelete: "cascade",
		}}},
	}

	source := renderMermaid(tables, nil)
	if !strings.Contains(source, `: (tenant_id, account_id) (`) || !strings.Contains(source, `) cascade`) {
		t.Fatalf("composite foreign key syntax missing from import:\n%s", source)
	}
	diagram, err := schema.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	var relation *schema.Rel
	for _, candidate := range manifest.Entities["membership"].Relations {
		if candidate.Target == "account" {
			relation = candidate
			break
		}
	}
	if relation == nil || relation.OnDelete != "cascade" || len(relation.Keys) != 2 || relation.Keys[0] != (schema.RelKey{Local: "tenant_id", Target: "tenant_id"}) || relation.Keys[1] != (schema.RelKey{Local: "account_id", Target: "id"}) {
		t.Fatalf("composite relation differs: %#v\n%s", relation, source)
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
