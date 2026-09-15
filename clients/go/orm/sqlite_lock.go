package orm

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/polyspec/orm/engine/ir"
)

const sqliteRowLockDDL = `CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))`

// acquireSQLiteRowLock implements the common row-lock request at the ORM
// boundary. SQLite has no row-lock clause, so one transaction-scoped lock row
// serializes ORM lock requests. The lock is deliberately database-backed: an
// in-process mutex would not protect independent application processes.
func acquireSQLiteRowLock(ctx context.Context, ex Exec, mode string) error {
	if mode == "" || ex == nil || ex.db().driver != "sqlite" {
		return nil
	}
	tx, ok := ex.(*Tx)
	if !ok || tx == nil || tx.tx == nil {
		return &ir.Error{Code: CodeConfig, Msg: "SQLite row locks require an ORM transaction"}
	}
	var previousBusyTimeout int
	if strings.HasSuffix(mode, "_nowait") {
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
	if err := ensureSQLiteRowLock(ctx, tx.d); err != nil {
		return err
	}
	for {
		if _, err := tx.tx.ExecContext(ctx, `INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "id"=excluded."id"`); err != nil {
			if mapped := mapDriverErr(err); !sqliteLockRetryable(err, mapped) || strings.HasSuffix(mode, "_nowait") {
				return mapped
			}
			if err := waitForSQLiteLock(ctx); err != nil {
				return err
			}
			continue
		}
		return nil
	}
}

func ensureSQLiteRowLock(ctx context.Context, d *DB) error {
	if d.sqliteRowLockReady.Load() {
		return nil
	}
	d.sqliteRowLockMu.Lock()
	defer d.sqliteRowLockMu.Unlock()
	if d.sqliteRowLockReady.Load() {
		return nil
	}
	for {
		_, err := d.SQL.ExecContext(ctx, sqliteRowLockDDL)
		if err == nil {
			d.sqliteRowLockReady.Store(true)
			return nil
		}
		mapped := mapDriverErr(err)
		if !sqliteLockRetryable(err, mapped) {
			return mapped
		}
		if err := waitForSQLiteLock(ctx); err != nil {
			return err
		}
	}
}

func sqliteLockRetryable(original, mapped error) bool {
	if IsDeadlock(mapped) {
		return true
	}
	message := strings.ToLower(original.Error())
	return strings.Contains(message, "sqlite_busy") || strings.Contains(message, "database is locked")
}

func waitForSQLiteLock(ctx context.Context) error {
	timer := time.NewTimer(5 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
