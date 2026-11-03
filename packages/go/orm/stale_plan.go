package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
)

// stalePlan reports an error that a named statement from before a schema change can raise: the result type changed (0A000), a
// parameter keeps its old type against the new column (42883, 42804), or a value is read as that old type (22P02, 22003, 22007,
// 22008). A statement outside a transaction that fails has changed nothing, so it can run again, and a statement that fails for
// another reason fails the same way the second time (CFG-28).
func stalePlan(err error) bool {
	var state interface{ SQLState() string }
	if !errors.As(err, &state) {
		return false
	}
	switch state.SQLState() {
	case "0A000":
		return strings.Contains(err.Error(), "cached plan must not change result type")
	case "42883", "42804", "22P02", "22003", "22007", "22008":
		return true
	}
	return false
}

// stalePlanSession is the one transaction in which a statement that failed with stalePlan runs again. The transaction holds one
// server connection through PgBouncer, and DEALLOCATE ALL makes the server parse the statement after the change on it.
type stalePlanSession struct {
	conn *sql.Conn
}

// openStalePlanSession opens the session on a connection of the pool. The connection is discarded at the end, since the
// statements database/sql prepared on it no longer exist on the server.
func (d *DB) openStalePlanSession(ctx context.Context) (*stalePlanSession, error) {
	conn, err := d.sql.Conn(ctx)
	if err != nil {
		return nil, err
	}
	s := &stalePlanSession{conn: conn}
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		return nil, s.discard(err)
	}
	err = conn.Raw(func(driverConn any) error {
		driverMu.RLock()
		deallocate := deallocators[d.driver]
		driverMu.RUnlock()
		return deallocate(ctx, driverConn)
	})
	if err != nil {
		return nil, s.discard(err)
	}
	return s, nil
}

// finish commits when err is nil, discards the connection and returns err joined with what failed on the way. A failed
// connection closes with its transaction, so only a success needs the COMMIT.
func (s *stalePlanSession) finish(ctx context.Context, err error) error {
	if err == nil {
		_, err = s.conn.ExecContext(ctx, "COMMIT")
	}
	return s.discard(err)
}

func (s *stalePlanSession) discard(err error) error {
	// database/sql closes a connection whose Raw callback reports driver.ErrBadConn, and Raw returns that error: it is the
	// expected result, so only any other error is joined.
	if rawErr := s.conn.Raw(func(any) error { return driver.ErrBadConn }); rawErr != nil && !errors.Is(rawErr, driver.ErrBadConn) {
		return errors.Join(err, rawErr)
	}
	return err
}

// execAgain runs a statement that failed with err once more when err is stalePlan and ex is outside a transaction. Inside a
// transaction the server has aborted it, so err reaches the caller (CFG-28).
func (d *DB) execAgain(ctx context.Context, ex executor, sqlText string, args []any, result sql.Result, err error) (sql.Result, error) {
	if !stalePlan(err) || ex.transaction() != nil {
		return result, err
	}
	s, err := d.openStalePlanSession(ctx)
	if err != nil {
		return nil, err
	}
	result, err = s.conn.ExecContext(ctx, sqlText, args...)
	return result, s.finish(ctx, err)
}

// scanAgain is execAgain for a statement that reads one row into dest.
func (d *DB) scanAgain(ctx context.Context, ex executor, sqlText string, args []any, err error, dest ...any) error {
	if !stalePlan(err) || ex.transaction() != nil {
		return err
	}
	s, err := d.openStalePlanSession(ctx)
	if err != nil {
		return err
	}
	return s.finish(ctx, s.conn.QueryRowContext(ctx, sqlText, args...).Scan(dest...))
}

// queryAgain is execAgain for a statement that returns rows. The returned end closes the rows and the session, so the caller
// reads the rows before calling it; end is nil when the statement did not run again.
func (d *DB) queryAgain(ctx context.Context, ex executor, sqlText string, args []any, rows *sql.Rows, err error) (*sql.Rows, func(error) error, error) {
	if !stalePlan(err) || ex.transaction() != nil {
		return rows, nil, err
	}
	s, err := d.openStalePlanSession(ctx)
	if err != nil {
		return nil, nil, err
	}
	rows, err = s.conn.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, nil, s.finish(ctx, err)
	}
	return rows, func(readErr error) error {
		return s.finish(ctx, errors.Join(readErr, rows.Close()))
	}, nil
}
