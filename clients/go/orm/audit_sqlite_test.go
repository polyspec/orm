package orm

import (
	"context"
	"database/sql"
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
		`CREATE TABLE operation (seq INTEGER PRIMARY KEY, operation_uuid TEXT NOT NULL UNIQUE)`,
		`CREATE TABLE operation_change (operation_seq INTEGER NOT NULL, site_id TEXT, table_name TEXT NOT NULL, entity_key TEXT NOT NULL, change_operation TEXT NOT NULL, old_value TEXT NOT NULL, new_value TEXT NOT NULL)`,
		`CREATE TABLE account (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, secret TEXT, value TEXT)`,
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
	if _, err := tx.ExecContext(ctx, `INSERT INTO operation(seq, operation_uuid) VALUES (7, 'op-7')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO account(id, site_id, secret, value) VALUES ('a-1', 'site-1', 'hidden', 'one')`); err == nil {
		t.Fatal("audit mutation without operation context was accepted")
	}
	if err := ex.SetLocal(ctx, "platform.operation_id", "op-7"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO account(id, site_id, secret, value) VALUES ('a-1', 'site-1', 'hidden', 'one')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE account SET secret='changed', value='two' WHERE id='a-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM account WHERE id='a-1'`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM operation_change`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("operation_change rows = %d, want 3", count)
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

func TestInstallImmutableSQLiteRejectsRowMutations(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, `CREATE TABLE record (seq INTEGER PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
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
	if _, err := tx.ExecContext(ctx, `INSERT INTO record(seq, value) VALUES (1, 'one')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE record SET value='two' WHERE seq=1`); err == nil {
		t.Fatal("immutable update was accepted")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM record WHERE seq=1`); err == nil {
		t.Fatal("immutable delete was accepted")
	}
	if err := ex.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
}
