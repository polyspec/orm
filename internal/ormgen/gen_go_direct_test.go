package ormgen

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestGoGeneratorEmitsFixedDefaultScanner(t *testing.T) {
	diagram, err := schema.Parse("erDiagram\n  item {\n    bigint id PK\n    varchar(191) name\n    text detail \"lazy\"\n    datetime created_at\n  }\n")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := genGo(manifest, dir); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "item.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, required := range []string{
		"func acceptsItemDirect(a *plan.Assemble) bool",
		"if len(a.Columns) != 3",
		"func scanItemDirect(s *orm.DirectScanner)",
		"&r.Id",
		"&r.Name",
		"&rawCreatedAt",
		"orm.QueryDirect(ctx, ex, q.q.Req, acceptsItemDirect, scanItemDirect)",
		"func (q *ItemQuery) GetOrNil() (*ItemRow, error)",
		"if row == nil {",
		"return nil, orm.ErrNoRows",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("generated Go source does not contain %q", required)
		}
	}
	if strings.Contains(source[strings.Index(source, "func acceptsItemDirect"):strings.Index(source, "// scanItem maps")], `c.Name != "detail"`) {
		t.Fatal("lazy column detail is present in the default direct scanner")
	}
}

func TestGoGeneratorEmitsEqualityForBinaryPrimaryKey(t *testing.T) {
	diagram, err := schema.Parse("erDiagram\n  installation_limit {\n    varbinary(32) record_key PK\n    datetime(6) started_at\n  }\n")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := genGo(manifest, dir); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "installation_limit.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, required := range []string{
		"RecordKeyEq(v []byte)",
		"func (q *InstallationLimitQuery) GetByRecordKey(v []byte)",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("generated Go source does not contain %q", required)
		}
	}
}
