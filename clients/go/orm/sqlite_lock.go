package orm

import (
	"context"
	"fmt"
	"strings"

	"github.com/polyspec/orm/engine/ir"
)

// rowLockTables는 row lock statement가 가리키는 table이다.
var rowLockTables = []string{"orm__row_lock"}

const sqliteRowLockDDL = `CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))`

// acquireSQLiteRowLock implements the common row-lock request at the ORM
// boundary. SQLite has no row-lock clause, so one transaction-scoped lock row
// serializes ORM lock requests. The lock is deliberately database-backed: an
// in-process mutex would not protect separate processes. The
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
		if err := tx.run().scan(ctx, KindUtility, nil, "PRAGMA busy_timeout", nil, &previousBusyTimeout); err != nil {
			return err
		}
		if _, err := tx.run().exec(ctx, KindUtility, nil, "PRAGMA busy_timeout=0"); err != nil {
			return err
		}
		defer func() {
			_, _ = tx.run().exec(context.Background(), KindUtility, nil, fmt.Sprintf("PRAGMA busy_timeout=%d", previousBusyTimeout))
		}()
	}
	if err := ensureSQLiteRowLock(ctx, tx.db); err != nil {
		return err
	}
	if _, err := tx.run().exec(ctx, KindUtility, rowLockTables, `INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "id"=excluded."id"`); err != nil {
		if nowait && sqliteBusy(err) {
			return &ir.Error{Code: CodeLockNotAvailable, Msg: err.Error()}
		}
		return err
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
	if _, err := (runner{d: d, q: d.sql}).exec(ctx, KindUtility, rowLockTables, sqliteRowLockDDL); err != nil {
		return err
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
