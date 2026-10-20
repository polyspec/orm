package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/go-sql-driver/mysql"
	sqlite "modernc.org/sqlite"
)

// errStatementRejected is the error that failingDriver returns for the statement it chose.
var errStatementRejected = errors.New("statement rejected by the test driver")

// errRollbackRejected is the error that failingDriver returns after it finishes the rollback.
var errRollbackRejected = errors.New("rollback rejected by the test driver")

// injectedFailure is the statement and rollback that failingDriver makes fail. The real
// server does not reject this statement and rollback, so the failure is produced this way.
type injectedFailure struct {
	statement func(query string) bool
	rollback  bool
}

var injected atomic.Pointer[injectedFailure]

// inject sets which failures failingDriver produces until the test ends.
func inject(t *testing.T, f injectedFailure) {
	t.Helper()
	injected.Store(&f)
	t.Cleanup(func() { injected.Store(nil) })
}

func statementRejected(query string) bool {
	f := injected.Load()
	return f != nil && f.statement != nil && f.statement(query)
}

// failingDriver wraps a real driver, and the statement and rollback that inject chose
// are made to fail.
type failingDriver struct{ base driver.Driver }

func (d failingDriver) Open(name string) (driver.Conn, error) {
	c, err := d.base.Open(name)
	if err != nil {
		return nil, err
	}
	return failingConn{c}, nil
}

type failingConn struct{ driver.Conn }

func (c failingConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if statementRejected(query) {
		return nil, errStatementRejected
	}
	e, ok := c.Conn.(driver.ExecerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	// The ROLLBACK the client runs actually completes, and then returns the injected rollback failure.
	res, err := e.ExecContext(ctx, query, args)
	if err == nil && query == "ROLLBACK" {
		if f := injected.Load(); f != nil && f.rollback {
			return nil, errRollbackRejected
		}
	}
	return res, err
}

func (c failingConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if statementRejected(query) {
		return nil, errStatementRejected
	}
	q, ok := c.Conn.(driver.QueryerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	return q.QueryContext(ctx, query, args)
}

func (c failingConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if statementRejected(query) {
		return nil, errStatementRejected
	}
	if p, ok := c.Conn.(driver.ConnPrepareContext); ok {
		return p.PrepareContext(ctx, query)
	}
	return c.Prepare(query)
}

func (c failingConn) CheckNamedValue(v *driver.NamedValue) error {
	if n, ok := c.Conn.(driver.NamedValueChecker); ok {
		return n.CheckNamedValue(v)
	}
	return driver.ErrSkip
}

var registerFailingDrivers sync.Once

// useFailingDriver makes the client driver name failingDriver until the test ends
// and opens it.
func useFailingDriver(t *testing.T, name string) {
	t.Helper()
	registerFailingDrivers.Do(func() {
		sql.Register("orm-failing-mysql", failingDriver{mysql.MySQLDriver{}})
		sql.Register("orm-failing-sqlite", failingDriver{&sqlite.Driver{}})
	})
	driverMu.Lock()
	previousDriver, hadDriver := sqlDrivers[name]
	previousMapper := errMappers[name]
	driverMu.Unlock()
	mapper := previousMapper
	if mapper == nil {
		mapper = func(err error) error { return err }
	}
	RegisterDriver(name, "orm-failing-"+name, mapper)
	t.Cleanup(func() {
		driverMu.Lock()
		defer driverMu.Unlock()
		if hadDriver {
			sqlDrivers[name], errMappers[name] = previousDriver, previousMapper
			return
		}
		delete(sqlDrivers, name)
		delete(errMappers, name)
	})
}
