package orm

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestInstallAuditSQLiteCapturesChanges(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE "core__operation" (seq INTEGER PRIMARY KEY, operation_uuid TEXT NOT NULL UNIQUE)`,
		`CREATE TABLE "core__operation_change" (operation_seq INTEGER NOT NULL, site_id TEXT, table_name TEXT NOT NULL, entity_key TEXT NOT NULL, change_operation TEXT NOT NULL, old_value TEXT NOT NULL, new_value TEXT NOT NULL)`,
		`CREATE TABLE "core__account" (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, secret TEXT, value TEXT)`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	ex := &Tx{d: &DB{driver: "sqlite"}, tx: tx}
	spec := AuditSpec{
		Table:                    "core.account",
		Mode:                     AuditChanges,
		SiteColumn:               "site_id",
		RedactedPaths:            [][]string{{"secret"}},
		OperationTable:           "core.operation",
		OperationSeqColumn:       "seq",
		OperationUUIDColumn:      "operation_uuid",
		OperationContextKey:      "platform.operation_id",
		ChangeTable:              "core.operation_change",
		ChangeOperationSeqColumn: "operation_seq",
		ChangeOperationColumn:    "change_operation",
		ChangeSiteColumn:         "site_id",
		ChangeTableColumn:        "table_name",
		ChangeEntityKeyColumn:    "entity_key",
		ChangeOldValueColumn:     "old_value",
		ChangeNewValueColumn:     "new_value",
	}
	if err := ex.InstallAudit(ctx, spec); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO "core__operation"(seq, operation_uuid) VALUES (7, 'op-7')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO "core__account"(id, site_id, secret, value) VALUES ('a-1', 'site-1', 'hidden', 'one')`); err == nil {
		t.Fatal("audit mutation without operation context was accepted")
	}
	if err := ex.SetLocal(ctx, "platform.operation_id", "op-7"); err != nil {
		t.Fatal(err)
	}
	value, err := ex.Local(ctx, "platform.operation_id")
	if err != nil || value != "op-7" {
		t.Fatalf("Local() = %q, %v; want op-7", value, err)
	}
	if _, err := ex.Local(ctx, "missing"); !IsNoRows(err) {
		t.Fatalf("Local(missing) error = %v; want NO_ROWS", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO "core__account"(id, site_id, secret, value) VALUES ('a-1', 'site-1', 'hidden', 'one')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE "core__account" SET secret='changed', value='two' WHERE id='a-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM "core__account" WHERE id='a-1'`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM "core__operation_change"`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("operation_change rows = %d, want 3", count)
	}
	var records string
	if err := tx.QueryRowContext(ctx, `SELECT group_concat(table_name || old_value || new_value, '|') FROM "core__operation_change"`).Scan(&records); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(records, "hidden") || strings.Contains(records, "changed") || !strings.Contains(records, `"redacted":1`) || !strings.Contains(records, "core.account") {
		t.Fatalf("qualified SQLite audit did not redact or preserve logical table name: %s", records)
	}
	if err := ex.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM orm_audit_context`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("audit context rows after commit = %d, want 0", count)
	}
}

func TestSQLiteRedactionLeavesMissingPathUnchanged(t *testing.T) {
	newValue, oldValue := sqliteRedactExpr("new_value", "old_value", [][]string{{"details", "private"}})
	if !strings.Contains(newValue, "CASE WHEN json_type(new_value,'$.\"details\".\"private\"') IS NOT NULL") {
		t.Fatalf("new-value redaction does not guard missing paths: %s", newValue)
	}
	if !strings.Contains(oldValue, "CASE WHEN json_type(old_value,'$.\"details\".\"private\"') IS NOT NULL") {
		t.Fatalf("old-value redaction does not guard missing paths: %s", oldValue)
	}
	if strings.Contains(newValue, "'present',0") || strings.Contains(oldValue, "'present',0") {
		t.Fatal("missing redaction paths must not produce a synthetic present=false marker")
	}
}

func TestInstallImmutableSQLiteRejectsRowMutations(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, `CREATE TABLE "core__record" (seq INTEGER PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	ex := &Tx{d: &DB{driver: "sqlite"}, tx: tx}
	if err := ex.InstallImmutable(ctx, "core.record"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO "core__record"(seq, value) VALUES (1, 'one')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE "core__record" SET value='two' WHERE seq=1`); err == nil {
		t.Fatal("immutable update was accepted")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM "core__record" WHERE seq=1`); err == nil {
		t.Fatal("immutable delete was accepted")
	}
	if err := ex.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
}
