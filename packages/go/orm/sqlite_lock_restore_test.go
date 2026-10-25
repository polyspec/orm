package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/polyspec/orm/packages/go/engine/ir"
)

var sqliteLockRestoreDriverID atomic.Uint64

type sqliteLockRestorePlan struct {
	primary error
	setZero error
	restore error
	calls   []string
}

type sqliteLockRestoreDriver struct{ plan *sqliteLockRestorePlan }
type sqliteLockRestoreConn struct{ plan *sqliteLockRestorePlan }

func (d sqliteLockRestoreDriver) Open(string) (driver.Conn, error) {
	return &sqliteLockRestoreConn{plan: d.plan}, nil
}

func (c *sqliteLockRestoreConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("the fake row-lock driver does not prepare statements")
}
func (c *sqliteLockRestoreConn) Close() error { return nil }
func (c *sqliteLockRestoreConn) Begin() (driver.Tx, error) {
	return nil, errors.New("the fake row-lock driver has no transactions")
}

func (c *sqliteLockRestoreConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.plan.calls = append(c.plan.calls, query)
	switch {
	case query == "PRAGMA busy_timeout=0":
		return driver.RowsAffected(0), c.plan.setZero
	case strings.HasPrefix(query, "PRAGMA busy_timeout="):
		return driver.RowsAffected(0), c.plan.restore
	case strings.HasPrefix(query, `INSERT INTO "orm__row_lock"`):
		return driver.RowsAffected(0), c.plan.primary
	default:
		return driver.RowsAffected(0), nil
	}
}

func (c *sqliteLockRestoreConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.plan.calls = append(c.plan.calls, query)
	if query != "PRAGMA busy_timeout" {
		return nil, fmt.Errorf("unexpected row-lock query %q", query)
	}
	return &sqliteLockRestoreRows{}, nil
}

type sqliteLockRestoreRows struct{ sent bool }

func (*sqliteLockRestoreRows) Columns() []string { return []string{"busy_timeout"} }
func (*sqliteLockRestoreRows) Close() error      { return nil }
func (r *sqliteLockRestoreRows) Next(row []driver.Value) error {
	if r.sent {
		return io.EOF
	}
	r.sent = true
	row[0] = int64(275)
	return nil
}

func sqliteLockRestoreDB(t *testing.T, plan *sqliteLockRestorePlan) (*DB, *txConn) {
	t.Helper()
	name := fmt.Sprintf("orm_sqlite_lock_restore_%d", sqliteLockRestoreDriverID.Add(1))
	sql.Register(name, sqliteLockRestoreDriver{plan: plan})
	pool, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := pool.Conn(context.Background())
	if err != nil {
		if closeErr := pool.Close(); closeErr != nil {
			t.Errorf("pool.Close() error = %v", closeErr)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if closeErr := conn.Close(); closeErr != nil {
			t.Errorf("conn.Close() error = %v", closeErr)
		}
		if closeErr := pool.Close(); closeErr != nil {
			t.Errorf("pool.Close() error = %v", closeErr)
		}
	})
	db := &DB{sql: pool, m: &dbMutable{}, driver: "sqlite"}
	db.m.sqliteRowLockReady.Store(true)
	return db, &txConn{db: db, conn: conn}
}

// Requirements: INT-49.
func TestAcquireSQLiteRowLockRestorationOutcomes(t *testing.T) {
	primaryCause := errors.New("database is locked")
	restoreCause := errors.New("restore rejected")
	for _, tc := range []struct {
		name         string
		primary      bool
		restore      bool
		wantCode     string
		wantIdentity bool
	}{
		{name: "primary succeeds and restore succeeds"},
		{name: "primary succeeds and restore fails", restore: true, wantCode: CodeDriver, wantIdentity: true},
		{name: "primary fails and restore succeeds", primary: true, wantCode: CodeLockNotAvailable},
		{name: "primary fails and restore fails", primary: true, restore: true, wantCode: CodeLockNotAvailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			plan := &sqliteLockRestorePlan{}
			if tc.primary {
				plan.primary = &ir.Error{Code: CodeDriver, Msg: primaryCause.Error(), Cause: primaryCause}
			}
			if tc.restore {
				plan.restore = &ir.Error{Code: CodeDriver, Msg: restoreCause.Error(), Cause: restoreCause}
			}
			db, tx := sqliteLockRestoreDB(t, plan)
			err := acquireSQLiteRowLock(context.Background(), tx, "update_nowait")
			if tc.wantCode == "" {
				if err != nil {
					t.Fatalf("acquireSQLiteRowLock() error = %v, want nil", err)
				}
			} else {
				var got *ir.Error
				if !errors.As(err, &got) || got.Code != tc.wantCode {
					t.Fatalf("acquireSQLiteRowLock() error = %v, want code %s", err, tc.wantCode)
				}
				if tc.primary && !errors.Is(got, primaryCause) {
					t.Errorf("primary cause is not reachable: %v", err)
				}
				if tc.restore && !errors.Is(err, restoreCause) {
					t.Errorf("restore cause is not reachable: %v", err)
				}
				if tc.wantIdentity && !errors.Is(err, plan.restore) {
					t.Errorf("restore-only failure changed identity: got %T %v", err, err)
				}
			}
			if got := strings.Count(strings.Join(plan.calls, "\n"), "PRAGMA busy_timeout="); got != 2 {
				t.Errorf("timeout zero/restore calls = %d, want both calls: %v", got, plan.calls)
			}
			_ = db
		})
	}
}

// Requirements: INT-49.
func TestAcquireSQLiteRowLockRestoresAfterNowaitSetupFailure(t *testing.T) {
	busyCause := errors.New("SQLite busy while setting timeout")
	setFailure := &ir.Error{Code: CodeCanceled, Msg: "setting timeout failed", Cause: busyCause}
	restoreCause := errors.New("restore rejected")
	plan := &sqliteLockRestorePlan{
		setZero: setFailure,
		restore: &ir.Error{Code: CodeDriver, Msg: restoreCause.Error(), Cause: restoreCause},
	}
	_, tx := sqliteLockRestoreDB(t, plan)
	err := acquireSQLiteRowLock(context.Background(), tx, "update_nowait")
	var got *ir.Error
	if !errors.As(err, &got) || got.Code != CodeCanceled {
		t.Fatalf("acquireSQLiteRowLock() error = %v, want primary CANCELED", err)
	}
	if !errors.Is(err, busyCause) {
		t.Errorf("setting failure cause is not reachable: %v", err)
	}
	if !errors.Is(err, restoreCause) {
		t.Errorf("restore cause is not reachable: %v", err)
	}
	if !strings.Contains(strings.Join(plan.calls, "\n"), "PRAGMA busy_timeout=275") {
		t.Errorf("restore was not attempted after setting NOWAIT failed: %v", plan.calls)
	}
}
