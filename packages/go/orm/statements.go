package orm

import (
	"context"
	"database/sql"
	"time"
)

// runner sends a statement that is not a model statement and publishes its event. q is the connection,
// a transaction connection, or the pool; tx is the statement's transaction number (0 outside a transaction).
type runner struct {
	d  *DB
	q  querier
	tx int64
	// machinery is the runner for transaction machinery statements. This statement
	// does not consume the statement fault (docs/spec/protocol.md 3.2).
	machinery bool
}

// exec runs one statement.
func (r runner) exec(ctx context.Context, kind string, tables []string, sqlText string, args ...any) (sql.Result, error) {
	start := time.Now()
	if err := r.fault(kind); err != nil {
		return nil, r.d.statementDone(kind, tables, r.tx, sqlText, args, start, err)
	}
	res, err := r.q.ExecContext(ctx, sqlText, args...)
	return res, r.d.statementDone(kind, tables, r.tx, sqlText, args, start, mapDriverErr(err))
}

// scan runs a statement that returns one row and reads that row into dest.
func (r runner) scan(ctx context.Context, kind string, tables []string, sqlText string, args []any, dest ...any) error {
	start := time.Now()
	if err := r.fault(kind); err != nil {
		return r.d.statementDone(kind, tables, r.tx, sqlText, args, start, err)
	}
	err := mapDriverErr(r.q.QueryRowContext(ctx, sqlText, args...).Scan(dest...))
	return r.d.statementDone(kind, tables, r.tx, sqlText, args, start, err)
}

// observed is the connection that publishes the events of the catalog queries and schema statements
// that dbspec sends. The event of a catalog query is published
// as QueryEnded after dbspec has read all of its rows. tables determines the tables the statement refers to.
type observed struct {
	r      runner
	kind   string
	tables func(sqlText string) []string
	start  time.Time
}

func (o *observed) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	o.start = time.Now()
	if err := o.r.fault(o.kind); err != nil {
		return nil, o.r.d.statementDone(o.kind, o.tables(query), o.r.tx, query, args, o.start, err)
	}
	rows, err := o.r.q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, o.r.d.statementDone(o.kind, o.tables(query), o.r.tx, query, args, o.start, mapDriverErr(err))
	}
	return rows, nil
}

// QueryEnded publishes that event when the catalog query has read all of its rows or failed while reading them.
func (o *observed) QueryEnded(query string, err error) error {
	return o.r.d.statementDone(o.kind, o.tables(query), o.r.tx, query, nil, o.start, mapDriverErr(err))
}

func (o *observed) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return o.r.exec(ctx, o.kind, o.tables(query), query, args...)
}

func (o *observed) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	panic("orm: observed connections do not read single rows")
}

// noTables is the table list of statements that refer to no table.
func noTables(string) []string { return nil }

// rows runs a statement that returns rows, calls each on each row, and after reading all of the rows
// or failing, publishes the event. An error from each is not a statement error.
func (r runner) rows(ctx context.Context, kind string, tables []string, sqlText string, args []any, each func(scan func(dest ...any) error) error) error {
	start := time.Now()
	if err := r.fault(kind); err != nil {
		return r.d.statementDone(kind, tables, r.tx, sqlText, args, start, err)
	}
	rs, err := r.q.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return r.d.statementDone(kind, tables, r.tx, sqlText, args, start, mapDriverErr(err))
	}
	var eachErr error
	for rs.Next() {
		if eachErr = each(rs.Scan); eachErr != nil {
			break
		}
	}
	err = rs.Err()
	if closeErr := rs.Close(); err == nil {
		err = closeErr
	}
	if err := r.d.statementDone(kind, tables, r.tx, sqlText, args, start, mapDriverErr(err)); err != nil {
		return err
	}
	return eachErr
}
