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
	catalogSQLBytes      = 256 << 10
)

// Error codes of the catalog connection that the Rust reference names; QUERY_READ_ONLY is the code that tests check.
const (
	catalogCodeReadOnly      = "QUERY_READ_ONLY"
	catalogCodeValue         = "CATALOG_VALUE"
	catalogCodeParam         = "CATALOG_PARAM"
	catalogCodeMetadata      = "TABLE_METADATA_INVALID"
	catalogCodeTableRef      = "TABLE_REFERENCE_INVALID"
	catalogCodePageChanged   = "TABLE_PAGE_METADATA_CHANGED"
	catalogCodeRowConflict   = "ROW_CONFLICT"
	catalogCodeRowSchema     = "ROW_SCHEMA_CHANGED"
	catalogCodeRowWrite      = "ROW_WRITE_MISMATCH"
	catalogCodeRowSnapshot   = "ROW_SNAPSHOT_INVALID"
	catalogCodeRowAmbiguous  = "ROW_IDENTITY_AMBIGUOUS"
	catalogCodeRowUnsupport  = "ROW_MUTATION_UNSUPPORTED"
	catalogCodeCommitReject  = "ROW_COMMIT_REJECTED"
	catalogCodeCommitUnknown = "ROW_COMMIT_INDETERMINATE"
)

// CatalogConnection is a native catalog connection to a MySQL, PostgreSQL or SQLite database selected by its DSN. It
// reads table metadata and bounded table pages, runs validated read-only queries and changes rows with explicit commands.
// Its descriptors and pages do not authorize a row change; each change checks its original row inside its own transaction.
type CatalogConnection struct {
	db      *DB
	dialect string
	closed  atomic.Bool
}

// ConnectCatalog opens the catalog connection of a mysql, postgres or sqlite DSN. A markdown DSN is refused. A SQLite
// DSN must name an existing regular file, and the connection never creates one.
func ConnectCatalog(dsn string) (*CatalogConnection, error) {
	parsed, err := parseDSN(dsn, 0)
	if err != nil {
		return nil, err
	}
	switch parsed.driver {
	case "markdown":
		return nil, configErr("CATALOG_DSN: a markdown corpus has no database catalog; give a mysql, postgres or sqlite DSN")
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
	}
	db, err := open(context.Background(), parsed, Config{})
	if err != nil {
		return nil, err
	}
	return &CatalogConnection{db: db, dialect: parsed.driver}, nil
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

// catalogSession is one pooled connection inside one transaction. The connection is discarded when the session ends, so
// a session setting such as the SQLite query_only pragma never returns to the pool.
type catalogSession struct {
	ctx     context.Context
	conn    *sql.Conn
	dialect string
}

// begin opens a session with a read-only transaction or a writable one. A SQLite read-only session sets query_only first.
func (c *CatalogConnection) begin(ctx context.Context, readOnly bool) (*catalogSession, error) {
	if err := c.ensureOpen(); err != nil {
		return nil, err
	}
	conn, err := c.db.sql.Conn(ctx)
	if err != nil {
		return nil, mapDriverErr(err)
	}
	s := &catalogSession{ctx: ctx, conn: conn, dialect: c.dialect}
	if readOnly && c.dialect == "sqlite" {
		if _, err := conn.ExecContext(ctx, "PRAGMA query_only=ON"); err != nil {
			return nil, s.discard(mapDriverErr(err))
		}
	}
	if _, err := conn.ExecContext(ctx, catalogBegin(c.dialect, readOnly)); err != nil {
		return nil, s.discard(mapDriverErr(err))
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

// discard closes the connection of the session instead of returning it to the pool, and returns err.
func (s *catalogSession) discard(err error) error {
	// database/sql closes a connection whose Raw callback reports driver.ErrBadConn; the error is the expected result.
	_ = s.conn.Raw(func(any) error { return driver.ErrBadConn })
	return err
}

// end rolls the session back, discards its connection and returns err joined with a failed rollback.
func (s *catalogSession) end(err error) error {
	if _, rollbackErr := s.conn.ExecContext(s.ctx, "ROLLBACK"); rollbackErr != nil {
		err = errors.Join(err, catalogErr("ROW_ROLLBACK_FAILED", "rollback: %v", mapDriverErr(rollbackErr)))
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
		return zero, s.end(err)
	}
	if err := s.end(nil); err != nil {
		return zero, err
	}
	return value, nil
}

// catalogWrite runs fn in a writable transaction. A failed fn rolls back. A commit that the database rejects rolls back
// and reports ROW_COMMIT_REJECTED; any other commit failure is reported as an unknown outcome that must not be retried.
func catalogWrite[T any](ctx context.Context, c *CatalogConnection, fn func(s *catalogSession) (T, error)) (T, error) {
	var zero T
	s, err := c.begin(ctx, false)
	if err != nil {
		return zero, err
	}
	value, err := fn(s)
	if err != nil {
		return zero, s.end(err)
	}
	if _, err := s.conn.ExecContext(ctx, "COMMIT"); err != nil {
		mapped := mapDriverErr(err)
		switch ErrorCode(mapped) {
		case CodeDuplicateKey, CodeForeignKey, CodeConstraint, CodeDeadlock:
			return zero, s.end(catalogErr(catalogCodeCommitReject, "native commit rejected: %v", mapped))
		}
		return zero, s.discard(catalogErr(catalogCodeCommitUnknown, "commit outcome unknown; do not retry: %v", mapped))
	}
	return value, s.discard(nil)
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

// queryRaw reads a bounded result. It fails when the result has more than maxRows rows or more than maxBytes of values.
func (s *catalogSession) queryRaw(query string, args []any, maxRows int, maxBytes int) (catalogRaw, error) {
	rows, err := s.conn.QueryContext(s.ctx, query, args...)
	if err != nil {
		return catalogRaw{}, mapDriverErr(err)
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return catalogRaw{}, mapDriverErr(err)
	}
	columnTypes, err := rows.ColumnTypes()
	if err != nil {
		return catalogRaw{}, mapDriverErr(err)
	}
	raw := catalogRaw{names: names, types: make([]string, len(columnTypes))}
	for i, columnType := range columnTypes {
		raw.types[i] = columnType.DatabaseTypeName()
	}
	budget := 0
	for rows.Next() {
		if len(raw.rows) == maxRows {
			return catalogRaw{}, catalogErr("CATALOG_LIMIT", "result has more than %d rows", maxRows)
		}
		values := make([]any, len(names))
		pointers := make([]any, len(names))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return catalogRaw{}, mapDriverErr(err)
		}
		for _, value := range values {
			budget += catalogSize(value)
		}
		if budget > maxBytes {
			return catalogRaw{}, catalogErr("CATALOG_LIMIT", "result has more than %d bytes of values", maxBytes)
		}
		raw.rows = append(raw.rows, values)
	}
	if err := rows.Err(); err != nil {
		return catalogRaw{}, mapDriverErr(err)
	}
	return raw, nil
}

// exec runs one statement and returns the number of rows it affected.
func (s *catalogSession) exec(query string, args []any) (int64, error) {
	result, err := s.conn.ExecContext(s.ctx, query, args...)
	if err != nil {
		return 0, mapDriverErr(err)
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
// bytes, integers int64, floats float64, datetimes time.Time and decimals their plain text. Other types fail explicitly.
func catalogValue(value any, nativeType string) (any, error) {
	switch v := value.(type) {
	case nil, bool, int64, float64, time.Time:
		return v, nil
	case string:
		if !utf8.ValidString(v) {
			return nil, catalogErr(catalogCodeValue, "text of native type %q is not valid UTF-8", nativeType)
		}
		return v, nil
	case []byte:
		return catalogBytesValue(v, nativeType)
	default:
		return nil, catalogErr(catalogCodeValue, "unsupported driver value %T", value)
	}
}

// catalogBytesValue converts the bytes of one driver value by its native type; a type it does not know fails.
func catalogBytesValue(value []byte, nativeType string) (any, error) {
	t := strings.ToUpper(nativeType)
	switch {
	case strings.Contains(t, "BLOB"), strings.Contains(t, "BINARY"), strings.Contains(t, "BYTEA"):
		return append([]byte(nil), value...), nil
	case strings.Contains(t, "DECIMAL"), strings.Contains(t, "NUMERIC"), strings.Contains(t, "MONEY"):
		return string(value), nil
	case strings.Contains(t, "INT"):
		n, err := strconv.ParseInt(string(value), 10, 64)
		if err != nil {
			return nil, catalogErr(catalogCodeValue, "integer of native type %q: %v", nativeType, err)
		}
		return n, nil
	case strings.Contains(t, "FLOAT"), strings.Contains(t, "DOUBLE"), strings.Contains(t, "REAL"):
		f, err := strconv.ParseFloat(string(value), 64)
		if err != nil {
			return nil, catalogErr(catalogCodeValue, "float of native type %q: %v", nativeType, err)
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
		case float64:
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return nil, catalogErr(catalogCodeParam, "parameter %d is not finite", i+1)
			}
			out[i] = v
		default:
			return nil, catalogErr(catalogCodeParam, "parameter %d has unsupported type %T", i+1, param)
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
