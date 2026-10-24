package dbspec

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

type sqliteResultError int

func (e sqliteResultError) Error() string { return fmt.Sprintf("sqlite result %d", int(e)) }
func (e sqliteResultError) Code() int     { return int(e) }

func TestSqliteLockResult(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	tests := []struct {
		code int
		want bool
	}{
		{5, true}, {6, true}, {261, true}, {517, true}, {773, true}, {262, true}, {518, true},
		{10, false}, {8, false}, {14, false}, {23, false}, {1, false},
	}
	for _, test := range tests {
		err := fmt.Errorf("wrapped: %w", sqliteResultError(test.code))
		if got := sqliteLockResult(err); got != test.want {
			t.Errorf("sqliteLockResult(%d) = %t, want %t", test.code, got, test.want)
		}
	}
	if sqliteLockResult(fmt.Errorf("not a SQLite result")) {
		t.Fatal("an untyped error was classified as a SQLite lock")
	}
}

type sqliteLockConnector struct {
	code       int
	statements *[]string
}

func (c *sqliteLockConnector) Connect(context.Context) (driver.Conn, error) {
	return &sqliteLockConn{code: c.code, statements: c.statements}, nil
}
func (*sqliteLockConnector) Driver() driver.Driver { return sqliteLockDriver{} }

type sqliteLockDriver struct{}

func (sqliteLockDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("sqlite lock test driver must use its connector")
}

type sqliteLockConn struct {
	code       int
	statements *[]string
}

func (*sqliteLockConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepared statements are not used by sqlite lock tests")
}
func (*sqliteLockConn) Close() error { return nil }
func (*sqliteLockConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not used")
}

func (c *sqliteLockConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	*c.statements = append(*c.statements, query)
	if query == "BEGIN EXCLUSIVE" {
		return nil, sqliteResultError(c.code)
	}
	return driver.RowsAffected(1), nil
}

func (c *sqliteLockConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	*c.statements = append(*c.statements, "QUERY "+query)
	var value driver.Value
	switch query {
	case "PRAGMA foreign_keys":
		value = int64(1)
	case "PRAGMA legacy_alter_table":
		value = int64(0)
	case "PRAGMA busy_timeout":
		value = int64(5000)
	case "PRAGMA locking_mode":
		value = "normal"
	case "SELECT COUNT(*) FROM sqlite_master":
		value = int64(0)
	default:
		return nil, fmt.Errorf("unexpected query %q", query)
	}
	return &sqliteLockRows{value: value}, nil
}

type sqliteLockRows struct {
	value driver.Value
	done  bool
}

func (*sqliteLockRows) Columns() []string { return []string{"value"} }
func (*sqliteLockRows) Close() error      { return nil }
func (r *sqliteLockRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = r.value
	return nil
}

func TestSqliteSessionClassifiesBeginErrorAndRestoresState(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, test := range []struct {
		code       int
		wantLocked bool
	}{{5, true}, {10, false}} {
		statements := []string{}
		db := sql.OpenDB(&sqliteLockConnector{code: test.code, statements: &statements})
		t.Cleanup(func() { testcase.Close(t, db) })
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { testcase.Close(t, conn) })
		cause := sqliteResultError(test.code)
		applier := &applier{ctx: context.Background(), c: conn, r: renderer{d: DialectSQLite}}
		got := applier.sqliteSession(func() error { return nil })
		if test.wantLocked {
			var applyErr *ApplyError
			if !errors.As(got, &applyErr) || applyErr.Code != "locked" || !errors.Is(got, cause) {
				t.Errorf("BEGIN EXCLUSIVE result %d = %v, want locked with original cause", test.code, got)
			}
		} else {
			var applyErr *ApplyError
			if !errors.Is(got, cause) || errors.As(got, &applyErr) {
				t.Errorf("BEGIN EXCLUSIVE result %d = %v, want original driver error", test.code, got)
			}
		}
		for _, want := range []string{
			"PRAGMA foreign_keys = 1",
			"PRAGMA legacy_alter_table = 0",
			"PRAGMA locking_mode = normal",
			"QUERY SELECT COUNT(*) FROM sqlite_master",
			"PRAGMA busy_timeout = 5000",
		} {
			found := false
			for _, statement := range statements {
				if statement == want {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("BEGIN EXCLUSIVE result %d did not restore %q; statements: %v", test.code, want, statements)
			}
		}
	}
}
