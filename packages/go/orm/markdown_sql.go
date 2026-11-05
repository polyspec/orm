package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/polyspec/orm/packages/go/engine/ir"
)

// A flowmark server runs a statement of SQL in SQLite's dialect on the corpus (DIA-185): the statement message and its
// answer below. Every SQL surface of a connection, a catalog connection included, reads and writes
// through the database/sql driver over it, so what a connection states in SQL it states as a SQLite connection does.

// mdStatement is the statement control message.
type mdStatement struct {
	Op     string            `json:"op"`
	SQL    string            `json:"sql"`
	Params []json.RawMessage `json:"params"`
}

// mdStatementAnswer is its answer.
type mdStatementAnswer struct {
	Columns []struct {
		Name string `json:"name"`
		Type string `json:"type"`
	} `json:"columns"`
	Rows         [][]json.RawMessage `json:"rows"`
	Affected     int64               `json:"affected"`
	LastInsertID int64               `json:"last_insert_id"`
	// More says that the server holds the rows that go on, which fetch answers and close ends.
	More bool `json:"more"`
}

// statement runs one statement in the session.
func (s *mdSession) statement(ctx context.Context, text string, args []any) (*mdStatementAnswer, error) {
	params := make([]json.RawMessage, len(args))
	for i, a := range args {
		raw, err := statementParam(a)
		if err != nil {
			return nil, err
		}
		params[i] = raw
	}
	raw, err := s.call(ctx, mdStatement{Op: "statement", SQL: text, Params: params})
	if err != nil {
		return nil, err
	}
	var a mdStatementAnswer
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("the answer of a statement: %v", err), Cause: err}
	}
	return &a, nil
}

// statementParam is the wire form of a bound value (PRT-67): a JSON value, the wire datetime for a time, and the form that
// an answer writes for a value that JSON cannot hold: {"bytes": base64} for bytes, {"text": base64} for a text that is not
// UTF-8 and {"float": "+Inf"} or {"float": "-Inf"} for an infinity.
func statementParam(v any) (json.RawMessage, error) {
	var out any = v
	switch t := v.(type) {
	case []byte:
		out = map[string]string{"bytes": base64.StdEncoding.EncodeToString(t)}
	case time.Time:
		out = t.UTC().Format("2006-01-02 15:04:05.000000")
	case string:
		if !utf8.ValidString(t) {
			out = map[string]string{"text": base64.StdEncoding.EncodeToString([]byte(t))}
		}
	case float64:
		if math.IsInf(t, 1) {
			out = map[string]string{"float": "+Inf"}
		} else if math.IsInf(t, -1) {
			out = map[string]string{"float": "-Inf"}
		}
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return nil, configErr("a statement parameter of %T: %v", v, err)
	}
	return raw, nil
}

// statementCell reads one cell of an answer: int64, float64, string, nil or []byte, as a SQLite connection scans them.
func statementCell(raw json.RawMessage) (any, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	switch t := v.(type) {
	case float64:
		var n int64
		if json.Unmarshal(raw, &n) == nil {
			return n, nil
		}
		return t, nil
	case map[string]any:
		if text, ok := t["float"].(string); ok {
			return strconv.ParseFloat(text, 64)
		}
		if text, ok := t["text"].(string); ok {
			data, err := base64.StdEncoding.DecodeString(text)
			return string(data), err
		}
		text, _ := t["bytes"].(string)
		return base64.StdEncoding.DecodeString(text)
	}
	return v, nil
}

// statementTime reads the text of a DATE, DATETIME or TIMESTAMP column as a time, as the driver of a SQLite connection
// does; a text that is no time stays a text.
func statementTime(declared string, v any) any {
	text, ok := v.(string)
	if !ok {
		return v
	}
	switch strings.ToUpper(declared) {
	case "DATE", "DATETIME", "TIMESTAMP":
		for _, layout := range []string{"2006-01-02 15:04:05.999999999", time.RFC3339Nano, "2006-01-02"} {
			if at, err := time.Parse(layout, text); err == nil {
				return at
			}
		}
	}
	return v
}

// mdConnector opens flowmark sessions as database/sql connections.
type mdConnector struct{ dsn markdownDSN }

func (c mdConnector) Connect(ctx context.Context) (driver.Conn, error) {
	s, err := dialMarkdown(ctx, c.dsn)
	if err != nil {
		return nil, err
	}
	for _, pragma := range c.dsn.pragmas {
		name, value, _ := strings.Cut(strings.TrimSuffix(pragma, ")"), "(")
		if _, err := s.statement(ctx, "PRAGMA "+name+" = "+value, nil); err != nil {
			s.close()
			return nil, err
		}
	}
	return &mdConn{s: s}, nil
}

func (c mdConnector) Driver() driver.Driver { return mdDriver{} }

// mdOneSession is the session of a markdown transaction as the one connection of a database/sql pool: the statements of
// the transaction run on it, and its end is the transaction's.
type mdOneSession struct{ s *mdSession }

func (o mdOneSession) Connect(context.Context) (driver.Conn, error) {
	return &mdConn{s: o.s, shared: true}, nil
}

func (o mdOneSession) Driver() driver.Driver { return mdDriver{} }

type mdDriver struct{}

// Open opens one session of the markdown DSN, as sql.Open("markdown", dsn) asks.
func (mdDriver) Open(name string) (driver.Conn, error) {
	u, err := url.Parse(name)
	if err != nil {
		return nil, configErr("the markdown DSN: %v", err)
	}
	dsn, err := parseMarkdownDSN(u, u.Query())
	if err != nil {
		return nil, err
	}
	return mdConnector{dsn}.Connect(context.Background())
}

func init() { sql.Register("markdown", mdDriver{}) }

// mdConn is one session as a database/sql connection.
type mdConn struct {
	s *mdSession
	// shared is a session that its transaction ends, not this connection.
	shared bool
}

func (c *mdConn) Prepare(text string) (driver.Stmt, error) { return &mdStmt{c: c, text: text}, nil }

func (c *mdConn) Close() error {
	if c.shared {
		return nil
	}
	c.s.close()
	return c.s.closeErr
}

func (c *mdConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *mdConn) BeginTx(ctx context.Context, o driver.TxOptions) (driver.Tx, error) {
	// A transaction is SQLite's: the statement BEGIN, ended by COMMIT or ROLLBACK, as SQLite's driver sends them.
	if _, err := c.s.statement(ctx, "BEGIN", nil); err != nil {
		return nil, err
	}
	return mdTx{c}, nil
}

func (c *mdConn) IsValid() bool { return !c.s.broken }

func (c *mdConn) ExecContext(ctx context.Context, text string, args []driver.NamedValue) (driver.Result, error) {
	return c.exec(ctx, text, namedValues(args))
}

// exec runs a statement whose rows are not read.
func (c *mdConn) exec(ctx context.Context, text string, args []any) (driver.Result, error) {
	a, err := c.s.statement(ctx, text, args)
	if err != nil {
		return nil, err
	}
	return mdResult{a}, nil
}

func (c *mdConn) QueryContext(ctx context.Context, text string, args []driver.NamedValue) (driver.Rows, error) {
	a, err := c.s.statement(ctx, text, namedValues(args))
	if err != nil {
		return nil, err
	}
	return &mdRows{a: a, s: c.s, ctx: ctx}, nil
}

func namedValues(args []driver.NamedValue) []any {
	out := make([]any, len(args))
	for i, a := range args {
		out[i] = a.Value
	}
	return out
}

type mdTx struct{ c *mdConn }

func (t mdTx) Commit() error {
	_, err := t.c.s.statement(context.Background(), "COMMIT", nil)
	return err
}

func (t mdTx) Rollback() error {
	_, err := t.c.s.statement(context.Background(), "ROLLBACK", nil)
	return err
}

type mdResult struct{ a *mdStatementAnswer }

func (r mdResult) LastInsertId() (int64, error) { return r.a.LastInsertID, nil }
func (r mdResult) RowsAffected() (int64, error) { return r.a.Affected, nil }

// mdStmt is a prepared statement: a statement message runs its text each time.
type mdStmt struct {
	c    *mdConn
	text string
}

func (s *mdStmt) Close() error  { return nil }
func (s *mdStmt) NumInput() int { return -1 }

func (s *mdStmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.c.exec(context.Background(), s.text, plainValues(args))
}

func (s *mdStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.c.exec(ctx, s.text, namedValues(args))
}

func (s *mdStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.c.QueryContext(ctx, s.text, args)
}

func (s *mdStmt) Query(args []driver.Value) (driver.Rows, error) {
	a, err := s.c.s.statement(context.Background(), s.text, plainValues(args))
	if err != nil {
		return nil, err
	}
	return &mdRows{a: a, s: s.c.s, ctx: context.Background()}, nil
}

func plainValues(args []driver.Value) []any {
	out := make([]any, len(args))
	for i, a := range args {
		out[i] = a
	}
	return out
}

// mdRows reads the rows of an answer.
type mdRows struct {
	a    *mdStatementAnswer
	next int
	// s and ctx fetch the rows that go on, which the server holds until they end.
	s   *mdSession
	ctx context.Context
}

func (r *mdRows) Columns() []string {
	out := make([]string, len(r.a.Columns))
	for i, c := range r.a.Columns {
		out[i] = c.Name
	}
	return out
}

func (r *mdRows) ColumnTypeDatabaseTypeName(i int) string { return r.a.Columns[i].Type }

// Close ends the rows the server still holds.
func (r *mdRows) Close() error {
	if !r.a.More {
		return nil
	}
	r.a.More = false
	_, err := r.s.call(r.ctx, map[string]string{"op": "close"})
	return err
}

func (r *mdRows) Next(dest []driver.Value) error {
	for r.next == len(r.a.Rows) {
		if !r.a.More {
			return io.EOF
		}
		raw, err := r.s.call(r.ctx, map[string]string{"op": "fetch"})
		if err != nil {
			r.a.More = false
			return err
		}
		var batch mdStatementAnswer
		if err := json.Unmarshal(raw, &batch); err != nil {
			r.a.More = false
			return &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("the answer of a fetch: %v", err), Cause: err}
		}
		r.a.Rows, r.a.More, r.next = batch.Rows, batch.More, 0
	}
	for i, raw := range r.a.Rows[r.next] {
		v, err := statementCell(raw)
		if err != nil {
			return err
		}
		dest[i] = statementTime(r.a.Columns[i].Type, v)
	}
	r.next++
	return nil
}

// markdownStatementPool is the database/sql pool of the statements a connection runs outside a transaction.
func markdownStatementPool(dsn markdownDSN) *sql.DB { return sql.OpenDB(mdConnector{dsn}) }
