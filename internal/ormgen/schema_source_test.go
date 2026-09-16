package ormgen

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestSchemaSourcesPreserveManifest(t *testing.T) {
	src := "erDiagram\n  account {\n    bigint id PK\n    bigint tenant_id\n    varchar(32) secret \"aes hex\"\n    int aes_key_version \"=1\"\n  }\n  %% scope account tenant_id\n  %% table_comment account \"accounts\"\n  %% column_comment account secret \"encrypted\"\n"
	d, err := schema.Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	want, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	mmdPath := filepath.Join(dir, "schema.mmd")
	jsonPath := filepath.Join(dir, "schema.json")
	if err := os.WriteFile(mmdPath, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := want.MarshalIndent()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(jsonPath, b, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{mmdPath, jsonPath} {
		got, err := loadSchemaSource(path, "sqlite")
		if err != nil || got.SchemaHash != want.SchemaHash {
			t.Fatalf("source %s hash=%v err=%v", path, schemaHash(got), err)
		}
	}
	for _, driver := range []string{"mysql", "postgres", "sqlite"} {
		ddl, err := renderDDL(want, driver)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, "schema."+driver+".sql")
		if err := os.WriteFile(path, []byte(ddl), 0o644); err != nil {
			t.Fatal(err)
		}
		got, err := loadSchemaSource(path, driver)
		if err != nil || got.SchemaHash != want.SchemaHash || got.Entities["account"].Scope != "tenant_id" {
			t.Fatalf("sql source %s hash=%v scope=%q err=%v", driver, schemaHash(got), gotScope(got, "account"), err)
		}
	}
}

func TestSchemaSourceReadsLiveSQLiteAndRejectsLossySQL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE item (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	got, err := loadSchemaSource("db:"+path, "sqlite")
	if err != nil || got.Entities["item"] == nil {
		t.Fatalf("live source: %#v %v", got, err)
	}
	sqlPath := filepath.Join(t.TempDir(), "external.sql")
	if err := os.WriteFile(sqlPath, []byte("CREATE TABLE item (id integer);\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSchemaSource(sqlPath, "sqlite"); err == nil || !strings.Contains(err.Error(), "MIGRATION_SOURCE_LOSS") {
		t.Fatalf("external SQL loss error=%v", err)
	}
}

func TestSchemaSourceConversionMatrix(t *testing.T) {
	src := "erDiagram\n  item {\n    bigint id PK\n    varchar(32) name\n  }\n"
	diagram, err := schema.Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	want, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	mmdPath := filepath.Join(dir, "item.mmd")
	jsonPath := filepath.Join(dir, "item.json")
	sqlPath := filepath.Join(dir, "item.sql")
	livePath := filepath.Join(dir, "source.sqlite")
	if err := os.WriteFile(mmdPath, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	jsonBody, _ := want.MarshalIndent()
	if err := os.WriteFile(jsonPath, jsonBody, 0o644); err != nil {
		t.Fatal(err)
	}
	ddl, err := renderDDL(want, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sqlPath, []byte(ddl), 0o644); err != nil {
		t.Fatal(err)
	}
	liveDB, err := sql.Open("sqlite", livePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(t.Context(), liveDB, "sqlite", ddl); err != nil {
		t.Fatal(err)
	}
	liveDB.Close()

	for _, source := range []string{mmdPath, jsonPath, sqlPath, "db:" + livePath} {
		t.Run(filepath.Base(strings.TrimPrefix(source, "db:")), func(t *testing.T) {
			target, err := loadSchemaSource(source, "sqlite")
			if err != nil {
				t.Fatal(err)
			}
			diff, err := renderDiff(emptyManifest(), target, "sqlite", false)
			if err != nil {
				t.Fatal(err)
			}
			operations := splitSQL(diff)
			if len(operations) == 0 || checksumText(diff) == "" {
				t.Fatalf("source did not produce a migration plan: %s", source)
			}
			dest, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "target.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer dest.Close()
			if err := executeMigration(t.Context(), dest, "sqlite", diff); err != nil {
				t.Fatal(err)
			}
			actual, err := liveManifest(dest, "sqlite")
			if err != nil {
				t.Fatal(err)
			}
			if !schemaMatches(target, actual, "sqlite") {
				t.Fatalf("source %s did not produce its target schema: %v", source, diffManifests(target, actual))
			}
		})
	}
}

func schemaHash(m *schema.Manifest) string {
	if m == nil {
		return ""
	}
	return m.SchemaHash
}

func gotScope(m *schema.Manifest, entity string) string {
	if m == nil || m.Entities[entity] == nil {
		return ""
	}
	return m.Entities[entity].Scope
}
