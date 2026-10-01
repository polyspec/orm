package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/go-sql-driver/mysql"
	"github.com/polyspec/orm/engine/runtimemodel"
)

// errResetRejected는 resetFailingDriver가 local 값 reset에 돌려주는 오류다.
var errResetRejected = errors.New("reset rejected by the test driver")

// resetFailingDriver는 MySQL driver를 감싸고 `SET @`orm.…` = NULL`만 실패시킨다.
// 실제 server는 이 statement를 거부하지 않으므로 reset 실패를 이렇게 만든다.
type resetFailingDriver struct{}

func (resetFailingDriver) Open(name string) (driver.Conn, error) {
	c, err := mysql.MySQLDriver{}.Open(name)
	if err != nil {
		return nil, err
	}
	return resetFailingConn{c}, nil
}

type resetFailingConn struct{ driver.Conn }

func (c resetFailingConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if strings.HasPrefix(query, "SET @`orm.") && strings.HasSuffix(query, "= NULL") {
		return nil, errResetRejected
	}
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
}

func (c resetFailingConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
}

func (c resetFailingConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	return c.Conn.(driver.ConnBeginTx).BeginTx(ctx, opts)
}

func (c resetFailingConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	return c.Conn.(driver.ConnPrepareContext).PrepareContext(ctx, query)
}

func (c resetFailingConn) Ping(ctx context.Context) error { return c.Conn.(driver.Pinger).Ping(ctx) }

func (c resetFailingConn) CheckNamedValue(v *driver.NamedValue) error {
	return c.Conn.(driver.NamedValueChecker).CheckNamedValue(v)
}

var registerResetFailingDriver sync.Once

// TestTransactionReportsFailedLocalReset는 transaction 끝의 MySQL local 값
// reset이 실패하면 commit과 rollback이 그 오류를 돌려주는지 확인한다. MySQL
// user variable은 COMMIT과 ROLLBACK 뒤에도 남으므로
// (mysql.context.user_variable_session_scope) 실패를 숨기면 pool connection에
// 값이 남는다.
func TestTransactionReportsFailedLocalReset(t *testing.T) {
	dsn := os.Getenv("ORM_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN is required; database tests never skip")
	}
	registerResetFailingDriver.Do(func() { sql.Register("orm-reset-failing", resetFailingDriver{}) })
	RegisterDriver("mysql", "orm-reset-failing", mapMySQLErr)
	defer RegisterDriver("mysql", "mysql", mapMySQLErr)
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "schema", "bench.dbspec"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := Connect(dsn, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	err = db.Transaction(func() error { return db.Utils().SetLocal("ormtest.actor", "tester") })
	if !errors.Is(err, errResetRejected) {
		t.Fatalf("commit: want the reset error, got %v", err)
	}
	failure := errors.New("callback failed")
	err = db.Transaction(func() error {
		if err := db.Utils().SetLocal("ormtest.actor", "tester"); err != nil {
			return err
		}
		return failure
	})
	if ErrorCode(err) != CodeConfig || !strings.Contains(err.Error(), failure.Error()) || !strings.Contains(err.Error(), errResetRejected.Error()) {
		t.Fatalf("rollback: want CONFIG with the callback and the reset error, got %v", err)
	}
}
