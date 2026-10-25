package dbspec

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"reflect"
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
	state      *sqliteLockPragmas
	unexpected *[]string
}

func (c *sqliteLockConnector) Connect(context.Context) (driver.Conn, error) {
	return &sqliteLockConn{code: c.code, statements: c.statements, state: c.state, unexpected: c.unexpected}, nil
}
func (*sqliteLockConnector) Driver() driver.Driver { return sqliteLockDriver{} }

type sqliteLockDriver struct{}

func (sqliteLockDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("sqlite lock test driver must use its connector")
}

type sqliteLockConn struct {
	code       int
	statements *[]string
	state      *sqliteLockPragmas
	unexpected *[]string
}

type sqliteLockPragmas struct {
	foreignKeys int64
	legacy      int64
	busyTimeout int64
	lockingMode string
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
	switch query {
	case "PRAGMA foreign_keys = 1":
		c.state.foreignKeys = 1
	case "PRAGMA foreign_keys = 0":
		c.state.foreignKeys = 0
	case "PRAGMA legacy_alter_table = 1":
		c.state.legacy = 1
	case "PRAGMA legacy_alter_table = 0":
		c.state.legacy = 0
	case "PRAGMA busy_timeout = 1300":
		c.state.busyTimeout = 1300
	case "PRAGMA busy_timeout = 5000":
		c.state.busyTimeout = 5000
	case "PRAGMA locking_mode = normal":
		c.state.lockingMode = "normal"
	case "PRAGMA locking_mode = EXCLUSIVE":
		c.state.lockingMode = "exclusive"
	default:
		*c.unexpected = append(*c.unexpected, query)
	}
	return driver.RowsAffected(1), nil
}

func (c *sqliteLockConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	*c.statements = append(*c.statements, "QUERY "+query)
	var value driver.Value
	switch query {
	case "PRAGMA foreign_keys":
		value = c.state.foreignKeys
	case "PRAGMA legacy_alter_table":
		value = c.state.legacy
	case "PRAGMA busy_timeout":
		value = c.state.busyTimeout
	case "PRAGMA locking_mode":
		value = c.state.lockingMode
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

// Requirements: PLN-89, PLN-90.
func TestSqliteSessionClassifiesBeginErrorAndRestoresState(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, test := range []struct {
		code       int
		wantLocked bool
	}{{5, true}, {6, true}, {261, true}, {517, true}, {773, true}, {262, true}, {518, true}, {10, false}, {8, false}, {14, false}, {23, false}, {1, false}} {
		statements := []string{}
		state := sqliteLockPragmas{foreignKeys: 1, legacy: 1, busyTimeout: 1300, lockingMode: "normal"}
		initial := state
		unexpected := []string{}
		db := sql.OpenDB(&sqliteLockConnector{
			code: test.code, statements: &statements, state: &state, unexpected: &unexpected,
		})
		conn := testSQLConn(t, db)
		cause := sqliteResultError(test.code)
		applier := &applier{ctx: context.Background(), c: conn, r: renderer{d: DialectSQLite}}
		callbackCalled := false
		got := applier.sqliteSession(func() error { callbackCalled = true; return nil })
		if callbackCalled {
			t.Errorf("BEGIN EXCLUSIVE result %d called the plan callback", test.code)
		}
		if state != initial {
			t.Errorf("BEGIN EXCLUSIVE result %d left PRAGMAs %+v, want %+v", test.code, state, initial)
		}
		if len(unexpected) != 0 {
			t.Errorf("BEGIN EXCLUSIVE result %d ran unexpected statements: %v", test.code, unexpected)
		}
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
		wantStatements := []string{
			"QUERY PRAGMA foreign_keys",
			"QUERY PRAGMA legacy_alter_table",
			"QUERY PRAGMA busy_timeout",
			"QUERY PRAGMA locking_mode",
			"PRAGMA busy_timeout = 5000",
			"PRAGMA locking_mode = EXCLUSIVE",
			"BEGIN EXCLUSIVE",
			"PRAGMA foreign_keys = 1",
			"PRAGMA legacy_alter_table = 1",
			"PRAGMA locking_mode = normal",
			"QUERY SELECT COUNT(*) FROM sqlite_master",
			"PRAGMA busy_timeout = 1300",
		}
		if !reflect.DeepEqual(statements, wantStatements) {
			t.Errorf("BEGIN EXCLUSIVE result %d statements = %v, want %v", test.code, statements, wantStatements)
		}
	}
}
