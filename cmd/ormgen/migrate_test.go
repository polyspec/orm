package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

func TestSQLiteMigrationIsIdempotentAndDetectsDrift(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "schema.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	b, err := os.ReadFile("../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	want, err := schema.Load(b)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureMigrationTable(ctx, db, "sqlite"); err != nil {
		t.Fatal(err)
	}
	live, err := liveManifest(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	ddl, err := renderCreateDDL(want, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if got := countSQLStatements(ddl); got == 0 {
		t.Fatal("initial migration has no operations")
	}
	if err := executeMigration(ctx, db, ddl); err != nil {
		t.Fatal(err)
	}
	live, err = liveManifest(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if !schemaMatches(want, live, "sqlite") {
		t.Fatalf("initial state does not match: want %s got %s", want.SchemaHash, live.SchemaHash)
	}
	if err := insertMigration(ctx, db, "sqlite", migrationRecord{MigrationID: "initial", Name: "initial", ToHash: want.SchemaHash, Status: "applied"}); err != nil {
		t.Fatal(err)
	}
	rec, ok, err := appliedMigration(ctx, db, "sqlite", "initial")
	if err != nil || !ok || rec.Status != "applied" {
		t.Fatalf("history = %#v, %v, %v", rec, ok, err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE "battle" ADD COLUMN "external_drift" TEXT`); err != nil {
		t.Fatal(err)
	}
	live, err = liveManifest(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if schemaMatches(want, live, "sqlite") {
		t.Fatal("external schema change was not detected")
	}
}

func TestMigrationLogUsesTimestampAndDetectsRecordMismatch(t *testing.T) {
	dir := t.TempDir()
	started := time.Date(2026, 9, 12, 13, 30, 0, 123456789, time.UTC)
	record := migrationRecord{MigrationID: "20260912-initial", Name: "initial", FromHash: "from", ToHash: "to", Checksum: "plan", Status: "applied", Operations: 3}
	log := migrationLogFromRecord(record, "sqlite", started, started.Add(time.Second))
	if err := writeMigrationLog(dir, log); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !strings.Contains(entries[0].Name(), "20260912T133000.123456789Z__20260912-initial.json") {
		t.Fatalf("unexpected log filename: %#v", entries)
	}
	if err := verifyMigrationLog(dir, record, "sqlite"); err != nil {
		t.Fatal(err)
	}
	record.Checksum = "different"
	if err := verifyMigrationLog(dir, record, "sqlite"); err == nil || !strings.Contains(err.Error(), "MIGRATION_LOG_CONFLICT") {
		t.Fatalf("expected log conflict, got %v", err)
	}
}

func TestCommentDDLAndDiff(t *testing.T) {
	oldText := "erDiagram\n  account {\n    bigint seq PK\n    varchar(64) email\n  }\n  %% table_comment account \"old table\"\n  %% column_comment account email \"old email\"\n"
	newText := strings.ReplaceAll(strings.ReplaceAll(oldText, "old table", "new table"), "old email", "new email")
	oldD, err := schema.Parse(oldText)
	if err != nil {
		t.Fatal(err)
	}
	newD, err := schema.Parse(newText)
	if err != nil {
		t.Fatal(err)
	}
	oldM, err := schema.Build(oldD)
	if err != nil {
		t.Fatal(err)
	}
	newM, err := schema.Build(newD)
	if err != nil {
		t.Fatal(err)
	}
	sqlText, err := renderDiff(oldM, newM, "sqlite", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sqlText, "orm_schema_comments") || !strings.Contains(sqlText, "new table") || !strings.Contains(sqlText, "new email") {
		t.Fatalf("comment diff = %s", sqlText)
	}
	ddl, err := renderCreateDDL(newM, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, "CREATE TABLE IF NOT EXISTS orm_schema_comments") || !strings.Contains(ddl, "new email") {
		t.Fatalf("comment ddl = %s", ddl)
	}
}

func TestSplitSQLPreservesQuotedSemicolons(t *testing.T) {
	got := splitSQL("INSERT INTO x VALUES ('a;b'); -- comment ;\nDO $$ BEGIN PERFORM 'c;d'; END $$; SELECT `e;f`; /* ; */ SELECT 1;")
	if len(got) != 4 {
		t.Fatalf("statements = %#v", got)
	}
	if !strings.Contains(got[0], "a;b") || !strings.Contains(got[1], "c;d") || !strings.Contains(got[2], "e;f") {
		t.Fatalf("quoted content lost: %#v", got)
	}
}
