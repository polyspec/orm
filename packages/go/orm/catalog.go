package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/packages/go/engine/ir"
)

// Budgets of the catalog connection (docs/spec/interfaces.md, "Qualified native Rust table metadata" to "Qualified Rust
// table pages"). A result over its budget is refused, never truncated.
const (
	catalogMetadataRows  = 2048
	catalogMetadataBytes = 4 << 20
	catalogPageBytes     = 8 << 20
	catalogSnapshotBytes = 8 << 20
	catalogDefaultRows   = 100000
	catalogDefaultBytes  = 64 << 20
)

// Error codes of the catalog connection that the Rust reference names; QUERY_READ_ONLY is the code that tests check.
const (
	catalogCodeReadOnly               = "QUERY_READ_ONLY"
	catalogCodeValue                  = "CATALOG_VALUE"
	catalogCodeParam                  = "CATALOG_PARAM"
	catalogCodeMetadata               = "TABLE_METADATA_INVALID"
	catalogCodeTableRef               = "TABLE_REFERENCE_INVALID"
	catalogCodePageChanged            = "TABLE_PAGE_METADATA_CHANGED"
	catalogCodeRowConflict            = "ROW_CONFLICT"
	catalogCodeRowSchema              = "ROW_SCHEMA_CHANGED"
	catalogCodeRowWrite               = "ROW_WRITE_MISMATCH"
	catalogCodeRowSnapshot            = "ROW_SNAPSHOT_INVALID"
	catalogCodeRowAmbiguous           = "ROW_IDENTITY_AMBIGUOUS"
	catalogCodeRowUnsupport           = "ROW_MUTATION_UNSUPPORTED"
	catalogCodeInsertIdentityRequired = "ROW_INSERT_IDENTITY_REQUIRED"
	catalogCodeInsertUnsupported      = "ROW_INSERT_UNSUPPORTED"
	catalogCodeCommitReject           = "ROW_COMMIT_REJECTED"
	catalogCodeCommitUnknown          = "ROW_COMMIT_INDETERMINATE"
)

// CatalogConnection is a native catalog connection to a MySQL, PostgreSQL or SQLite database selected by its DSN. It
// reads table metadata and bounded table pages, runs validated read-only queries and changes rows with explicit commands.
// Its descriptors and pages do not authorize a row change; each change checks its original row inside its own transaction.
type CatalogConnection struct {
	db      *DB
	dialect string
	closed  atomic.Bool
	// reopenUntil is when, in Unix nanoseconds, a refused connect stops being a socket of this catalog still on the server (CFG-35).
	reopenUntil atomic.Int64
}

// ConnectCatalog opens the catalog connection of a mysql, postgres, sqlite or markdown DSN. A SQLite
// DSN must name an existing regular file, and the connection never creates one.
func ConnectCatalog(dsn string) (*CatalogConnection, error) {
	parsed, err := parseDSN(dsn, 0)
	if err != nil {
		return nil, err
	}
	switch parsed.driver {
	case "markdown":
		// A flowmark server runs SQL in SQLite's dialect on the corpus, so the catalog of a corpus is a SQLite catalog (DIA-185).
		db, err := open(context.Background(), parsed, Config{})
		if err != nil {
			return nil, err
		}
		return &CatalogConnection{db: db, dialect: "sqlite"}, nil
	case "sqlite":
		u, err := url.Parse(dsn)
		if err != nil {
			return nil, configErr("CATALOG_SQLITE_FILE: %v", err)
		}
		// Lstat does not follow a symbolic link: a link is not a regular file.
		info, err := os.Lstat(u.Path)
		if err != nil {
			return nil, configErr("CATALOG_SQLITE_FILE: %v", err)
		}
		if !info.Mode().IsRegular() {
			return nil, configErr("CATALOG_SQLITE_FILE: expected an existing regular file")
		}
		// mode=rw keeps the driver from creating a missing file.
		parsed.native += "&mode=rw"
	case "mysql", "postgres":
		native, err := catalogNativeDSN(parsed)
		if err != nil {
			return nil, configErr("%v", err)
		}
		parsed.native = native
	}
	db, err := open(context.Background(), parsed, Config{})
	if err != nil {
		return nil, err
	}
	return &CatalogConnection{db: db, dialect: parsed.driver}, nil
}

// catalogNativeDSN is the driver DSN of a MySQL or PostgreSQL catalog connection. The catalog fixes the character set of
// its connection when it connects, so the encoding is no setting of a read (INT-185): utf8mb4 on MySQL, which
// go-sql-driver/mysql sets with SET NAMES on each new connection, and the UTF8 client_encoding on PostgreSQL, which pgx
// sends as a startup parameter. The MySQL driver does not parse a date or datetime into a time.Time either: it would move
// a date that is no calendar date, such as 2024-02-30, to another day, and the catalog checks the text that the server
// sends (INT-174).
//
// On PostgreSQL the catalog also reads each value of a fixed-length built-in type in its binary form, which no setting
// changes: pgx's database/sql driver asks for that form when it describes a statement, and parses the text form of a date
// or a timestamp, which follows DateStyle, so a query that sets DateStyle (set_config) would fail that parse. A query mode
// that does not describe (simple_protocol, exec) becomes describe_exec, which uses no named statement either; the session
// is one transaction, which holds its server connection through a transaction pooler (CFG-28).
func catalogNativeDSN(parsed parsedDSN) (string, error) {
	if parsed.driver == "postgres" {
		u, err := url.Parse(parsed.native)
		if err != nil {
			return "", err
		}
		q := u.Query()
		q.Set("client_encoding", "UTF8")
		if mode := q.Get("default_query_exec_mode"); mode == "simple_protocol" || mode == "exec" {
			q.Set("default_query_exec_mode", "describe_exec")
		}
		// PostgreSQL reads the option string literally, so a space stays percent-encoded, as parseDSN writes it.
		u.RawQuery = strings.ReplaceAll(q.Encode(), "+", "%20")
		return u.String(), nil
	}
	cfg, err := mysql.ParseDSN(parsed.native)
	if err != nil {
		return "", err
	}
	cfg.ParseTime = false
	if err := cfg.Apply(mysql.Charset("utf8mb4", "utf8mb4_general_ci")); err != nil {
		return "", err
	}
	return cfg.FormatDSN(), nil
}

// Dialect is the database of the connection: mysql, postgres or sqlite.
func (c *CatalogConnection) Dialect() string { return c.dialect }

// Close releases the connection pool.
// Close releases the connection pool. An operation after Close fails with CATALOG_CLOSED and sends no statement.
func (c *CatalogConnection) Close() error {
	c.closed.Store(true)
	return c.db.Close()
}

// ensureOpen fails with CATALOG_CLOSED once Close has run.
func (c *CatalogConnection) ensureOpen() error {
	if c.closed.Load() {
		return catalogErr(CodeCatalogClosed, "the catalog connection is closed")
	}
	return nil
}

// catalogSession is one pooled connection inside one transaction. The connection is discarded when the session ends without
// an acknowledged COMMIT, so a session setting such as the SQLite query_only pragma never returns to the pool.
type catalogSession struct {
	catalog *CatalogConnection
	// stopped is set when a budget stopped a read: the cancel of the read closed the socket on MySQL and PostgreSQL.
	stopped bool
	ctx     context.Context
	conn    *sql.Conn
	dialect string
	// rollbacks learns that SQLite rolled the transaction back by itself; it is nil on MySQL and PostgreSQL.
	rollbacks *rollbackWatch
}

// begin opens a session with a read-only transaction or a writable one. A SQLite read-only session sets query_only first.
func (c *CatalogConnection) begin(ctx context.Context, readOnly bool) (*catalogSession, error) {
	if err := c.ensureOpen(); err != nil {
		return nil, err
	}
	conn, err := c.db.sql.Conn(ctx)
	// A socket that this catalog closed holds its place in max_user_connections until the server ends that thread. The server
	// announces that to no one, so this is a timer: the reopen is tried again within the 2 s of CFG-35 from the close (within
	// 40 ms measured). A connect that follows no close of this catalog fails at once.
	for catalogConnectionsFull(err) && time.Now().UnixNano() < c.reopenUntil.Load() {
		time.Sleep(10 * time.Millisecond)
		conn, err = c.db.sql.Conn(ctx)
	}
	if err != nil {
		return nil, mapDriverErrContext(err, ctx)
	}
	s := &catalogSession{catalog: c, ctx: ctx, conn: conn, dialect: c.dialect}
	if readOnly && c.dialect == "sqlite" {
		if _, err := conn.ExecContext(ctx, "PRAGMA query_only=ON"); err != nil {
			return nil, s.discard(mapDriverErrContext(err, ctx))
		}
	}
	if readOnly && c.dialect == "mysql" {
		// At REPEATABLE READ the information schema answers from the snapshot of the transaction, so a descriptor read after
		// the rows could not differ from the one read before them (INT-121).
		if _, err := conn.ExecContext(ctx, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"); err != nil {
			return nil, s.discard(mapDriverErrContext(err, ctx))
		}
	}
	if _, err := conn.ExecContext(ctx, catalogBegin(c.dialect, readOnly)); err != nil {
		return nil, s.discard(mapDriverErrContext(err, ctx))
	}
	if c.dialect == "postgres" {
		// A catalog session runs after schema changes by design, and through PgBouncer a Parse of a text that the server connection
		// already holds never reaches the server, so a plan from before the change would fail with "cached plan must not change
		// result type". The transaction holds that server connection for the whole session (CFG-28).
		// A connection from the pool may hold statements of an earlier session: the driver forgets them on the client too, or
		// the next use of a text it remembers would name a statement that the server has released.
		if err := c.db.deallocate(ctx, conn); err != nil {
			return nil, s.discard(mapDriverErrContext(err, ctx))
		}
	}
	if c.dialect == "sqlite" {
		watch, err := watchRollback(conn)
		s.rollbacks = watch
		if err != nil {
			return nil, s.end(err)
		}
	}
	return s, nil
}

// catalogBegin is the statement that opens the transaction of a session.
func catalogBegin(dialect string, readOnly bool) string {
	switch {
	case dialect == "mysql" && readOnly:
		return "START TRANSACTION READ ONLY"
	case dialect == "mysql":
		return "START TRANSACTION"
	case dialect == "postgres" && readOnly:
		return "BEGIN READ ONLY"
	case dialect == "postgres":
		return "BEGIN"
	case readOnly:
		return "BEGIN"
	default:
		return "BEGIN IMMEDIATE"
	}
}

// catalogConnectionsFull reports the refusal of a connection over max_user_connections.
func catalogConnectionsFull(err error) bool {
	var refused *mysql.MySQLError
	return errors.As(err, &refused) && refused.Number == 1226
}

// discard closes the connection of the session instead of returning it to the pool, and returns err.
func (s *catalogSession) discard(err error) error {
	// database/sql closes a connection whose Raw callback reports driver.ErrBadConn, and Raw returns that error: it is the
	// expected result, so only any other error is joined.
	if rawErr := s.conn.Raw(func(any) error { return driver.ErrBadConn }); rawErr != nil && !errors.Is(rawErr, driver.ErrBadConn) {
		err = errors.Join(err, mapDriverErr(rawErr))
	}
	if s.dialect == "mysql" {
		s.catalog.reopenUntil.Store(time.Now().Add(2 * time.Second).UnixNano())
	}
	return err
}

// release returns the connection of a session whose COMMIT the server acknowledged to the pool, for the next session: that
// transaction and its locks have ended, and a writable session changes no setting of its connection (INT-106c).
func (s *catalogSession) release() error {
	err := s.rollbacks.stop(s.conn)
	if closeErr := s.conn.Close(); closeErr != nil {
		err = errors.Join(err, mapDriverErr(closeErr))
	}
	return err
}

// end rolls the session back, discards its connection and returns err joined with a failed rollback. A transaction that
// SQLite already rolled back by itself is not rolled back again (INT-155).
func (s *catalogSession) end(err error) error {
	if !s.rollbacks.open() {
		return s.discard(err)
	}
	// The stop closed the connection on purpose, which ends the server's transaction: there is nothing to roll back, and the
	// error is the one that stopped the read. SQLite stops the read with its handle and rolls back as usual.
	if s.stopped && s.dialect != "sqlite" {
		return s.discard(err)
	}
	if _, rollbackErr := s.conn.ExecContext(s.ctx, "ROLLBACK"); rollbackErr != nil {
		mapped := mapDriverErrContext(rollbackErr, s.ctx)
		err = errors.Join(err, &ir.Error{
			Code:  CodeRowRollbackFailed,
			Msg:   fmt.Sprintf("rollback: %v", mapped),
			Cause: mapped,
		})
	}
	return s.discard(err)
}

// catalogRead runs fn in a fresh read-only session and ends the session with its outcome.
func catalogRead[T any](ctx context.Context, c *CatalogConnection, fn func(s *catalogSession) (T, error)) (T, error) {
	var zero T
	s, err := c.begin(ctx, true)
	if err != nil {
		return zero, err
	}
	value, err := fn(s)
	if err != nil {
		return zero, refusedRead(s.end(err))
	}
	if err := s.end(nil); err != nil {
		return zero, err
	}
	return value, nil
}

// refusedRead maps a write that the database's read-only scope refuses to QUERY_READ_ONLY (INT-104), such as a routine that
// writes, as the TypeScript client does.
func refusedRead(err error) error {
	if ErrorCode(err) == "READ_ONLY" {
		return catalogErr(catalogCodeReadOnly, "%v", err)
	}
	return err
}

// catalogWrite runs fn in a writable transaction. A failed fn rolls back. A commit that the database rejects rolls back
// and reports ROW_COMMIT_REJECTED; any other commit failure is reported as an unknown outcome that must not be retried.
func catalogWrite[T any](ctx context.Context, c *CatalogConnection, fn func(s *catalogSession) (T, error)) (T, error) {
	var zero T
	s, err := c.begin(ctx, false)
	if err != nil {
		return zero, err
	}
	if c.dialect == "mysql" {
		if err := s.mysqlPartialRevokesOff(); err != nil {
			return zero, s.end(err)
		}
	}
	value, err := fn(s)
	if err != nil {
		return zero, s.end(err)
	}
	if _, err := s.conn.ExecContext(ctx, "COMMIT"); err != nil {
		mapped := mapDriverErrContext(err, ctx)
		switch ErrorCode(mapped) {
		case CodeDuplicateKey, CodeForeignKey, CodeConstraint, CodeDeadlock:
			return zero, s.end(catalogErr(catalogCodeCommitReject, "native commit rejected: %v", mapped))
		}
		return zero, s.discard(&ir.Error{
			Code:  catalogCodeCommitUnknown,
			Msg:   fmt.Sprintf("commit outcome unknown; do not retry: %v", mapped),
			Cause: mapped,
		})
	}
	return value, s.release()
}

// CurrentNamespace reports the namespace of the connection: the current schema of PostgreSQL, the current database of
// MySQL and the main database of SQLite.
func (c *CatalogConnection) CurrentNamespace(ctx context.Context) (string, error) {
	if err := c.ensureOpen(); err != nil {
		return "", err
	}
	if c.dialect == "sqlite" {
		return "main", nil
	}
	query := "SELECT DATABASE()"
	if c.dialect == "postgres" {
		query = "SELECT current_schema()"
	}
	return catalogRead(ctx, c, func(s *catalogSession) (string, error) {
		raw, err := s.queryRaw(query, nil, 2, catalogMetadataBytes)
		if err != nil {
			return "", err
		}
		rows, err := catalogConvert(raw, raw.types)
		if err != nil {
			return "", err
		}
		if len(rows) != 1 || len(rows[0]) != 1 {
			return "", catalogErr("TABLE_NAMESPACE_UNAVAILABLE", "the connection reported no single namespace")
		}
		name, ok := rows[0][0].(string)
		if !ok {
			return "", catalogErr("TABLE_NAMESPACE_UNAVAILABLE", "the connection reported no text namespace")
		}
		if err := catalogCheckName(name); err != nil {
			return "", err
		}
		return name, nil
	})
}

// catalogRaw is a bounded result before conversion: the column names, the native types that the driver reports and
// the driver values of each row.
type catalogRaw struct {
	names []string
	types []string
	rows  [][]any
}

// queryRaw reads a bounded result. It fails when the result has more than maxRows rows or more than maxBytes of values,
// each driver value counted by catalogSize.
func (s *catalogSession) queryRaw(query string, args []any, maxRows int, maxBytes int) (catalogRaw, error) {
	return s.querySized(query, args, maxRows, maxBytes, func(value any, _ string, _ int) (int, error) { return catalogSize(value), nil })
}

// querySized reads a bounded result like queryRaw, with size giving the bytes that each value of the 1-based column of its
// native type counts against maxBytes; an error of size ends the read with that error. A value that the driver could not
// decode fails with CATALOG_VALUE and keeps the failure as its cause (INT-172).
func (s *catalogSession) querySized(query string, args []any, maxRows int, maxBytes int, size func(value any, native string, column int) (int, error)) (raw catalogRaw, err error) {
	// The query has its own context: a budget that ends the read cancels it, so that closing the rows does not read the rest
	// of a result the server still streams (a cross join of the bench table would otherwise run to its end).
	qctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	rows, err := s.conn.QueryContext(qctx, query, args...)
	if err != nil {
		return catalogRaw{}, mapDriverErrContext(err, s.ctx)
	}
	stopped := false
	defer func() {
		if stopped {
			// The budget error is the one reported: a close that the stop interrupted may fail, as the stop ended the read,
			// so its error stays only as a cause of the budget error.
			s.stopped = true
			cancel()
			if closeErr := rows.Close(); closeErr != nil {
				var coded *ir.Error
				if errors.As(err, &coded) {
					raw, err = catalogRaw{}, &ir.Error{Code: coded.Code, Msg: coded.Msg, Cause: errors.Join(coded.Cause, closeErr)}
				} else {
					raw, err = catalogRaw{}, errors.Join(err, closeErr)
				}
			}
			return
		}
		if closeErr := rows.Close(); closeErr != nil {
			raw, err = catalogRaw{}, errors.Join(err, mapDriverErrContext(closeErr, s.ctx))
		}
	}()
	names, err := rows.Columns()
	if err != nil {
		return catalogRaw{}, mapDriverErr(err)
	}
	columnTypes, err := rows.ColumnTypes()
	if err != nil {
		return catalogRaw{}, mapDriverErr(err)
	}
	raw = catalogRaw{names: names, types: make([]string, len(columnTypes))}
	for i, columnType := range columnTypes {
		raw.types[i] = columnType.DatabaseTypeName()
	}
	budget := 0
	for rows.Next() {
		if len(raw.rows) == maxRows {
			stopped = true
			return catalogRaw{}, catalogErr("CATALOG_LIMIT", "result has more than %d rows", maxRows)
		}
		values := make([]any, len(names))
		pointers := make([]any, len(names))
		for i := range values {
			pointers[i] = &values[i]
		}
		// A value that the driver fails to decode fails Scan (pgx decodes a column in ScanColumn) or the read of the row with
		// a driver error that keeps the failure as its cause; no database sends one for a supported type (INT-172).
		if err := rows.Scan(pointers...); err != nil {
			return catalogRaw{}, mapDriverErrContext(err, s.ctx)
		}
		for i, value := range values {
			n, err := size(value, raw.types[i], i+1)
			if err != nil {
				stopped = true
				return catalogRaw{}, err
			}
			budget += n
		}
		if budget > maxBytes {
			stopped = true
			return catalogRaw{}, catalogErr("CATALOG_LIMIT", "result has more than %d bytes of values", maxBytes)
		}
		raw.rows = append(raw.rows, values)
	}
	if err := rows.Err(); err != nil {
		return catalogRaw{}, mapDriverErrContext(err, s.ctx)
	}
	return raw, nil
}

// exec runs one statement and returns the number of rows it affected.
func (s *catalogSession) exec(query string, args []any) (int64, error) {
	result, err := s.conn.ExecContext(s.ctx, query, args...)
	if err != nil {
		return 0, mapDriverErrContext(err, s.ctx)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, mapDriverErr(err)
	}
	return affected, nil
}

// catalogSize is the encoded size that a driver value counts against a result budget.
func catalogSize(value any) int {
	switch v := value.(type) {
	case []byte:
		return len(v)
	case string:
		return len(v)
	default:
		return 8
	}
}

// catalogConvert converts the driver values of a raw result with the native type of each column.
func catalogConvert(raw catalogRaw, nativeTypes []string) ([][]any, error) {
	if len(nativeTypes) != len(raw.names) {
		return nil, catalogErr(catalogCodeMetadata, "%d native types for %d columns", len(nativeTypes), len(raw.names))
	}
	out := make([][]any, 0, len(raw.rows))
	for _, row := range raw.rows {
		converted := make([]any, len(row))
		for i, value := range row {
			v, err := catalogValue(value, nativeTypes[i])
			if err != nil {
				return nil, err
			}
			converted[i] = v
		}
		out = append(out, converted)
	}
	return out, nil
}

// catalogValue converts one driver value to the catalog value of its native type. Text is a string, binary a copy of its
// bytes, integers int64 (uint64 for a MySQL unsigned value beyond it), floats float64, datetimes time.Time and decimals their plain text. Other types fail explicitly.
func catalogValue(value any, nativeType string) (any, error) {
	switch v := value.(type) {
	case nil, bool, int64, uint64, float64, time.Time:
		return v, nil
	case string:
		// A value that is not valid UTF-8 is its bytes: a database tool shows the cell (INT-153).
		if !utf8.ValidString(v) {
			return []byte(v), nil
		}
		return v, nil
	case []byte:
		if !utf8.Valid(v) {
			return append([]byte(nil), v...), nil
		}
		return catalogBytesValue(v, nativeType)
	default:
		return nil, catalogErr(catalogCodeValue, "unsupported driver value")
	}
}

// catalogBytesValue converts the bytes of one driver value by its native type; a type it does not know fails.
func catalogBytesValue(value []byte, nativeType string) (any, error) {
	t := strings.ToUpper(nativeType)
	switch {
	case t == "", strings.Contains(t, "BLOB"), strings.Contains(t, "BINARY"), strings.Contains(t, "BYTEA"):
		// A SQLite expression has no declared type, and its driver reads a BLOB value as bytes (INT-153).
		return append([]byte(nil), value...), nil
	case catalogNativeTimeType(t):
		if !utf8.Valid(value) {
			return nil, catalogErr(catalogCodeValue, "time of native type %q is not valid UTF-8", nativeType)
		}
		return string(value), nil
	case strings.Contains(t, "DECIMAL"), strings.Contains(t, "NUMERIC"), strings.Contains(t, "MONEY"):
		return string(value), nil
	case strings.Contains(t, "INT"):
		n, err := strconv.ParseInt(string(value), 10, 64)
		if err != nil {
			// A MySQL BIGINT UNSIGNED reaches past int64 (INT-102).
			if u, unsigned := strconv.ParseUint(string(value), 10, 64); unsigned == nil {
				return u, nil
			}
			return nil, catalogErr(catalogCodeValue, "integer of native type %q is not an integer", nativeType)
		}
		return n, nil
	case strings.Contains(t, "FLOAT"), strings.Contains(t, "DOUBLE"), strings.Contains(t, "REAL"):
		f, err := strconv.ParseFloat(string(value), 64)
		if err != nil {
			return nil, catalogErr(catalogCodeValue, "float of native type %q is not a number", nativeType)
		}
		return f, nil
	case strings.Contains(t, "CHAR"), strings.Contains(t, "TEXT"), strings.Contains(t, "JSON"), strings.Contains(t, "ENUM"),
		strings.HasPrefix(t, "SET"), strings.Contains(t, "UUID"), strings.Contains(t, "XML"), strings.Contains(t, "NAME"):
		if !utf8.Valid(value) {
			return nil, catalogErr(catalogCodeValue, "text of native type %q is not valid UTF-8", nativeType)
		}
		return string(value), nil
	default:
		return nil, catalogErr(catalogCodeValue, "unsupported native type %q", nativeType)
	}
}

// catalogNativeTimeType recognizes the supported time-of-day types, excluding time-zone-bearing forms such as TIMETZ.
func catalogNativeTimeType(nativeType string) bool {
	nativeType = strings.TrimSpace(nativeType)
	nativeType = strings.TrimSuffix(nativeType, " WITHOUT TIME ZONE")
	if nativeType == "TIME" {
		return true
	}
	if !strings.HasPrefix(nativeType, "TIME(") || !strings.HasSuffix(nativeType, ")") {
		return false
	}
	precision, err := strconv.Atoi(nativeType[len("TIME(") : len(nativeType)-1])
	return err == nil && precision >= 0 && precision <= 6
}

// catalogParams checks the bound parameters of a statement and returns them with int widened to int64.
func catalogParams(params []any) ([]any, error) {
	out := make([]any, len(params))
	for i, param := range params {
		switch v := param.(type) {
		case nil, bool, string, []byte, time.Time:
			out[i] = v
		case int:
			out[i] = int64(v)
		case int64:
			out[i] = v
		case float32:
			// A 4-byte float cell of a read (INT-183) binds as the float64 that holds it exactly.
			if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
				return nil, catalogErr(catalogCodeParam, "parameter %d is not finite", i+1)
			}
			out[i] = float64(v)
		case float64:
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return nil, catalogErr(catalogCodeParam, "parameter %d is not finite", i+1)
			}
			out[i] = v
		default:
			return nil, catalogErr(catalogCodeParam, "parameter %d has an unsupported type", i+1)
		}
	}
	return out, nil
}

// catalogCheckName accepts a namespace, table or column name of 1..1024 UTF-8 bytes without NUL.
func catalogCheckName(name string) error {
	if name == "" || len(name) > 1024 || strings.ContainsRune(name, 0) || !utf8.ValidString(name) {
		return catalogErr(catalogCodeTableRef, "expected 1..1024 UTF-8 bytes without NUL")
	}
	return nil
}

// catalogQuote quotes an identifier of the dialect, doubling the quote mark inside it.
func catalogQuote(name, dialect string) string {
	mark := `"`
	if dialect == "mysql" {
		mark = "`"
	}
	return mark + strings.ReplaceAll(name, mark, mark+mark) + mark
}

// catalogQualified is the quoted namespace and name of a table.
func catalogQualified(ref CatalogTableRef, dialect string) string {
	return catalogQuote(ref.Namespace, dialect) + "." + catalogQuote(ref.Name, dialect)
}

// catalogPlaceholder is the placeholder of the bound parameter at index (1-based): $n in PostgreSQL, ? elsewhere.
func catalogPlaceholder(index int, dialect string) string {
	if dialect == "postgres" {
		return "$" + strconv.Itoa(index)
	}
	return "?"
}

// catalogErr reports a catalog error with its code, in the form CODE: message.
func catalogErr(code, format string, args ...any) error {
	return &ir.Error{Code: code, Msg: fmt.Sprintf(format, args...)}
}
