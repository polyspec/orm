package orm

import (
	"context"
	"fmt"
	"strings"

	"github.com/polyspec/orm/engine/ir"
)

const sqliteRowLockDDL = `CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))`

// acquireSQLiteRowLock implements the common row-lock request at the ORM
// boundary. SQLite has no row-lock clause, so one transaction-scoped lock row
// serializes ORM lock requests. The lock is deliberately database-backed: an
// in-process mutex would not protect independent application processes. The
// write statement waits for the lock up to the connection's busy_timeout; a
// NOWAIT request sets the wait to zero.
func acquireSQLiteRowLock(ctx context.Context, ex executor, mode string) error {
	if mode == "" || ex.base().driver != "sqlite" {
		return nil
	}
	tx := ex.transaction()
	if tx == nil {
		return &ir.Error{Code: CodeConfig, Msg: "row locks require a transaction"}
	}
	nowait := strings.HasSuffix(mode, "_nowait")
	if nowait {
		var previousBusyTimeout int
		if err := tx.tx.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&previousBusyTimeout); err != nil {
			return mapDriverErr(err)
		}
		if _, err := tx.tx.ExecContext(ctx, "PRAGMA busy_timeout=0"); err != nil {
			return mapDriverErr(err)
		}
		defer func() {
			_, _ = tx.tx.ExecContext(context.Background(), fmt.Sprintf("PRAGMA busy_timeout=%d", previousBusyTimeout))
		}()
	}
	if err := ensureSQLiteRowLock(ctx, tx.db); err != nil {
		return err
	}
	if _, err := tx.tx.ExecContext(ctx, `INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "id"=excluded."id"`); err != nil {
		mapped := mapDriverErr(err)
		if nowait && sqliteBusy(err) {
			return &ir.Error{Code: CodeLockNotAvailable, Msg: mapped.Error()}
		}
		return mapped
	}
	return nil
}

func ensureSQLiteRowLock(ctx context.Context, d *DB) error {
	if d.m.sqliteRowLockReady.Load() {
		return nil
	}
	d.m.sqliteRowLockMu.Lock()
	defer d.m.sqliteRowLockMu.Unlock()
	if d.m.sqliteRowLockReady.Load() {
		return nil
	}
	if _, err := d.sql.ExecContext(ctx, sqliteRowLockDDL); err != nil {
		return mapDriverErr(err)
	}
	d.m.sqliteRowLockReady.Store(true)
	return nil
}

// sqliteBusy reports a SQLITE_BUSY driver error: another connection held the
// lock when the wait ended.
func sqliteBusy(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "sqlite_busy") || strings.Contains(message, "database is locked")
}
