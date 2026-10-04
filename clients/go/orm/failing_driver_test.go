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

// errStatementRejected는 failingDriver가 고른 statement에 돌려주는 오류다.
var errStatementRejected = errors.New("statement rejected by the test driver")

// errRollbackRejected는 failingDriver가 rollback을 끝낸 뒤 돌려주는 오류다.
var errRollbackRejected = errors.New("rollback rejected by the test driver")

// injectedFailure는 failingDriver가 실패시킬 statement와 rollback이다. 실제
// server는 이 statement와 rollback을 거부하지 않으므로 실패를 이렇게 만든다.
type injectedFailure struct {
	statement func(query string) bool
	rollback  bool
}

var injected atomic.Pointer[injectedFailure]

// inject는 test가 끝날 때까지 failingDriver의 실패를 정한다.
func inject(t *testing.T, f injectedFailure) {
	t.Helper()
	injected.Store(&f)
	t.Cleanup(func() { injected.Store(nil) })
}

func statementRejected(query string) bool {
	f := injected.Load()
	return f != nil && f.statement != nil && f.statement(query)
}

// failingDriver는 실제 driver를 감싸고 inject가 고른 statement와 rollback을
// 실패시킨다.
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
	// client가 실행하는 ROLLBACK은 실제로 끝낸 뒤 inject된 rollback 실패를 돌려준다.
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
	return c.Conn.Prepare(query)
}

func (c failingConn) CheckNamedValue(v *driver.NamedValue) error {
	if n, ok := c.Conn.(driver.NamedValueChecker); ok {
		return n.CheckNamedValue(v)
	}
	return driver.ErrSkip
}

var registerFailingDrivers sync.Once

// useFailingDriver는 test가 끝날 때까지 client driver name을 failingDriver로
// 연다.
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
