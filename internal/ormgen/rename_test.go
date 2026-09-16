package ormgen

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

func TestSQLiteRenamePreservesData(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "rename.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	assertRenamePreservesData(t, context.Background(), db, "sqlite")
}

func assertRenamePreservesData(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	base := renameTestManifest(t, `erDiagram
  rename_owner {
    bigint id PK
  }
  rename_account {
    bigint id PK
    bigint owner_id FK
    varchar(40) name
  }
  rename_owner ||--o{ rename_account : owner_id
  %% index rename_account (owner_id) owner_idx
`)
	target := renameTestManifest(t, `erDiagram
  rename_owner {
    bigint id PK
  }
  rename_customer {
    bigint id PK
    bigint owner_id FK
    varchar(40) display_name
  }
  rename_owner ||--o{ rename_customer : owner_id
  %% index rename_customer (owner_id) owner_new_idx
  %% rename_table rename_customer rename_account
  %% rename_column rename_customer display_name name
`)
	create, err := renderCreateDDL(base, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, create); err != nil {
		t.Fatal(err)
	}
	q := func(s string) string { return `"` + s + `"` }
	placeholder := "$1"
	if driver == "mysql" {
		q = func(s string) string { return "`" + s + "`" }
		placeholder = "?"
	} else if driver == "sqlite" {
		placeholder = "?"
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO "+q("rename_owner")+" ("+q("id")+") VALUES (3)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO "+q("rename_account")+" ("+q("id")+", "+q("owner_id")+", "+q("name")+") VALUES (7, 3, "+placeholder+")", "alpha"); err != nil {
		t.Fatal(err)
	}
	forward, err := renderDiff(base, target, driver, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, forward); err != nil {
		t.Fatalf("forward rename: %v\n%s", err, forward)
	}
	var value string
	if err := db.QueryRowContext(ctx, "SELECT "+q("display_name")+" FROM "+q("rename_customer")+" WHERE "+q("id")+"=7").Scan(&value); err != nil || value != "alpha" {
		t.Fatalf("renamed value=%q err=%v", value, err)
	}
	rollback, err := renderDiff(target, base, driver, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, rollback); err != nil {
		t.Fatalf("rollback rename: %v\n%s", err, rollback)
	}
	if err := db.QueryRowContext(ctx, "SELECT "+q("name")+" FROM "+q("rename_account")+" WHERE "+q("id")+"=7").Scan(&value); err != nil || value != "alpha" {
		t.Fatalf("rollback value=%q err=%v", value, err)
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE "+q("rename_account")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "DROP TABLE "+q("rename_owner")); err != nil {
		t.Fatal(err)
	}
}

func renameTestManifest(t *testing.T, source string) *schema.Manifest {
	t.Helper()
	diagram, err := schema.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	return manifest
}
