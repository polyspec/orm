package ormgen

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

func TestSQLiteDiffRebuildsTableAndPreservesRows(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "rebuild.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	base := sqliteRebuildManifest(t, false)
	target := sqliteRebuildManifest(t, true)
	ddl, err := renderCreateDDL(base, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, "sqlite", ddl); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO "rebuild_owner" ("id") VALUES (1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO "rebuild_item" ("id","owner_id","code","legacy") VALUES (7,1,'alpha','keep')`); err != nil {
		t.Fatal(err)
	}
	plan, err := renderDiff(base, target, "sqlite", true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan, `CREATE TABLE "__orm_rebuild_rebuild_item"`) || !strings.Contains(plan, `INSERT INTO "__orm_rebuild_rebuild_item"`) {
		t.Fatalf("rebuild operations missing:\n%s", plan)
	}
	if err := executeMigration(ctx, db, "sqlite", plan); err != nil {
		t.Fatalf("apply rebuild: %v\n%s", err, plan)
	}
	var code, status string
	if err := db.QueryRowContext(ctx, `SELECT "code","status" FROM "rebuild_item" WHERE "id"=7`).Scan(&code, &status); err != nil || code != "alpha" || status != "ready" {
		t.Fatalf("row code=%q status=%q err=%v", code, status, err)
	}
	var legacyCount, indexCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('rebuild_item') WHERE name='legacy'`).Scan(&legacyCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pragma_index_list('rebuild_item') WHERE name='rebuild_item_code_idx'`).Scan(&indexCount); err != nil {
		t.Fatal(err)
	}
	if legacyCount != 0 || indexCount != 1 {
		t.Fatalf("legacy columns=%d code indexes=%d", legacyCount, indexCount)
	}
	var action string
	if err := db.QueryRowContext(ctx, `SELECT on_delete FROM pragma_foreign_key_list('rebuild_item') WHERE "table"='rebuild_owner'`).Scan(&action); err != nil || action != "CASCADE" {
		t.Fatalf("delete action=%q err=%v", action, err)
	}
	live, err := liveManifest(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	repeat, err := renderDiff(live, target, "sqlite", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(repeat, "-- no changes") {
		t.Fatalf("rebuild repeat is not a no-op:\n%s", repeat)
	}
	rollback, err := renderDiff(target, base, "sqlite", true)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, "sqlite", rollback); err != nil {
		t.Fatalf("rollback rebuild: %v\n%s", err, rollback)
	}
	var legacy sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT "code","legacy" FROM "rebuild_item" WHERE "id"=7`).Scan(&code, &legacy); err != nil || code != "alpha" || legacy.Valid {
		t.Fatalf("rollback code=%q legacy=%v err=%v", code, legacy, err)
	}
}

func TestSQLiteDiffRejectsUnfillableRequiredColumn(t *testing.T) {
	base := testManifest(&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true})
	target := testManifest(
		&schema.Col{Name: "id", Type: "i64", Raw: "bigint", PK: true},
		&schema.Col{Name: "required_value", Type: "string", Raw: "varchar(20)", Len: 20},
	)
	if _, err := renderDiff(base, target, "sqlite", false); err == nil || !strings.Contains(err.Error(), "required_value") || !strings.Contains(err.Error(), "default") {
		t.Fatalf("expected required-column preflight error, got %v", err)
	}
}

func TestSQLiteRebuildRejectsDependentTriggerBeforeChanges(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "trigger.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	base, target := sqliteRebuildManifest(t, false), sqliteRebuildManifest(t, true)
	ddl, err := renderCreateDDL(base, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, "sqlite", ddl); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TRIGGER rebuild_item_audit AFTER INSERT ON rebuild_item BEGIN SELECT 1; END`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE VIEW rebuild_item_view AS SELECT id FROM rebuild_item`); err != nil {
		t.Fatal(err)
	}
	plan, err := renderDiff(base, target, "sqlite", true)
	if err != nil {
		t.Fatal(err)
	}
	structured := testMigrationPlan(base, target, "sqlite", plan)
	err = executeMigration(ctx, db, "sqlite", planSQL(structured.Operations))
	if err == nil || !strings.Contains(err.Error(), "SQLITE_REBUILD_UNSAFE") || !strings.Contains(err.Error(), "trigger:rebuild_item_audit") || !strings.Contains(err.Error(), "view:rebuild_item_view") {
		t.Fatalf("expected trigger preflight error, got %v", err)
	}
	var tableCount, triggerCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='rebuild_item'`).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='rebuild_item_audit'`).Scan(&triggerCount); err != nil {
		t.Fatal(err)
	}
	if tableCount != 1 || triggerCount != 1 {
		t.Fatalf("table=%d trigger=%d", tableCount, triggerCount)
	}
}

func TestSQLiteRebuildFailureRestoresOriginalTable(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "failure.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	base, target := sqliteRebuildManifest(t, false), sqliteRebuildManifest(t, true)
	ddl, err := renderCreateDDL(base, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, "sqlite", ddl); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO rebuild_owner (id) VALUES (1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO rebuild_item (id,owner_id,code,legacy) VALUES (7,1,NULL,'original')`); err != nil {
		t.Fatal(err)
	}
	plan, err := renderDiff(base, target, "sqlite", true)
	if err != nil {
		t.Fatal(err)
	}
	err = executeMigration(ctx, db, "sqlite", plan)
	if err == nil || !strings.Contains(err.Error(), "operation=") || !strings.Contains(strings.ToLower(err.Error()), "not null") {
		t.Fatalf("expected detailed copy failure, got %v", err)
	}
	var legacy string
	if err := db.QueryRowContext(ctx, `SELECT legacy FROM rebuild_item WHERE id=7`).Scan(&legacy); err != nil || legacy != "original" {
		t.Fatalf("original row legacy=%q err=%v", legacy, err)
	}
	var tempCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='__orm_rebuild_rebuild_item'`).Scan(&tempCount); err != nil || tempCount != 0 {
		t.Fatalf("temporary tables=%d err=%v", tempCount, err)
	}
}

func sqliteRebuildManifest(t *testing.T, target bool) *schema.Manifest {
	t.Helper()
	source := `erDiagram
  rebuild_owner {
    bigint id PK
  }
  rebuild_item {
    bigint id PK
    bigint owner_id FK
    varchar(20) code "?"
    varchar(20) legacy "?"
  }
  rebuild_owner ||--o{ rebuild_item : owner_id
  %% index rebuild_item (owner_id) owner_idx
`
	if target {
		source = `erDiagram
  rebuild_owner {
    bigint id PK
  }
  rebuild_item {
    bigint id PK
    bigint owner_id FK
    varchar(40) code
    varchar(20) status "='ready'"
  }
  rebuild_owner ||--o{ rebuild_item : owner_id cascade
  %% unique rebuild_item (owner_id, code)
  %% index rebuild_item (code) code_idx
`
	}
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
