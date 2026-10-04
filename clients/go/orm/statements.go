package orm

import (
	"context"
	"database/sql"
	"time"
)

// runner는 model이 아닌 statement를 보내고 그 event를 publish한다. q는 연결,
// transaction 연결, pool 중 하나이고 tx는 statement의 transaction 번호다(밖이면 0).
type runner struct {
	d  *DB
	q  querier
	tx int64
}

// exec는 statement 하나를 실행한다.
func (r runner) exec(ctx context.Context, kind string, tables []string, sqlText string, args ...any) (sql.Result, error) {
	start := time.Now()
	res, err := r.q.ExecContext(ctx, sqlText, args...)
	return res, r.d.statementDone(kind, tables, r.tx, sqlText, args, start, mapDriverErr(err))
}

// scan은 한 row를 돌려주는 statement를 실행하고 그 row를 dest에 읽는다.
func (r runner) scan(ctx context.Context, kind string, tables []string, sqlText string, args []any, dest ...any) error {
	start := time.Now()
	err := mapDriverErr(r.q.QueryRowContext(ctx, sqlText, args...).Scan(dest...))
	return r.d.statementDone(kind, tables, r.tx, sqlText, args, start, err)
}

// observed는 dbspec이 보내는 catalog query와 schema statement의 event를
// publish하는 연결이다. catalog query의 event는 dbspec이 그 행을 모두 읽은 뒤
// QueryEnded로 publish한다. tables는 statement가 가리키는 table을 정한다.
type observed struct {
	r      runner
	kind   string
	tables func(sqlText string) []string
	start  time.Time
}

func (o *observed) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	o.start = time.Now()
	rows, err := o.r.q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, o.r.d.statementDone(o.kind, o.tables(query), o.r.tx, query, args, o.start, mapDriverErr(err))
	}
	return rows, nil
}

// QueryEnded는 catalog query의 행을 모두 읽었거나 읽다 실패했을 때 그 event를 publish한다.
func (o *observed) QueryEnded(query string, err error) error {
	return o.r.d.statementDone(o.kind, o.tables(query), o.r.tx, query, nil, o.start, mapDriverErr(err))
}

func (o *observed) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return o.r.exec(ctx, o.kind, o.tables(query), query, args...)
}

func (o *observed) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	panic("orm: observed connections do not read single rows")
}

// noTables는 table을 가리키지 않는 statement의 table 목록이다.
func noTables(string) []string { return nil }

// rows는 행을 돌려주는 statement를 실행하고 각 행에 each를 부른 뒤, 행을 모두
// 읽었거나 실패했을 때 event를 publish한다. each의 오류는 statement의 오류가 아니다.
func (r runner) rows(ctx context.Context, kind string, tables []string, sqlText string, args []any, each func(scan func(dest ...any) error) error) error {
	start := time.Now()
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
