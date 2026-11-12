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
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/internal/message"
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
	// killMu guards kill, the MySQL connection that a budget stop kills the statement of a read through (CFG-35). The catalog
	// opens it at its first stop and keeps it until Close, so that no stop closes a connection that a later stop must reopen.
	killMu sync.Mutex
	kill   *sql.Conn
	// ids holds the MySQL connection id of each driver connection of the pool, read once when a session first takes it.
	ids sync.Map
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
// every MySQL connection sets with SET NAMES when it connects (DIA-202), and the UTF8 client_encoding on PostgreSQL, which pgx
// sends as a startup parameter. The MySQL driver does not parse a date or datetime into a time.Time either: it would move
// a date that is no calendar date, such as 2024-02-30, to another day, and the catalog checks the text that the server
// sends (INT-174).
//
// On PostgreSQL the catalog also reads each value of a fixed-length built-in type in its binary form, which no setting
// changes: pgx's database/sql driver asks for that form when it describes a statement, and parses the text form of a date
// or a timestamp, which follows DateStyle, so a query that sets DateStyle would fail that parse before INT-186 refuses the
// read. A DSN names no query mode (CFG-19), so pgx describes every statement.
func catalogNativeDSN(parsed parsedDSN) (string, error) {
	if parsed.driver == "postgres" {
		u, err := url.Parse(parsed.native)
		if err != nil {
			return "", err
		}
		q := u.Query()
		q.Set("client_encoding", "UTF8")
		// PostgreSQL reads the option string literally, so a space stays percent-encoded, as parseDSN writes it.
		u.RawQuery = strings.ReplaceAll(q.Encode(), "+", "%20")
		return u.String(), nil
	}
	cfg, err := mysql.ParseDSN(parsed.native)
	if err != nil {
		return "", err
	}
	cfg.ParseTime = false
	return cfg.FormatDSN(), nil
}

// Dialect is the database of the connection: mysql, postgres or sqlite.
func (c *CatalogConnection) Dialect() string { return c.dialect }

// Close releases the connection pool.
// Close releases the connection pool. An operation after Close fails with CATALOG_CLOSED and sends no statement.
func (c *CatalogConnection) Close() error {
	c.closed.Store(true)
	c.killMu.Lock()
	var err error
	if c.kill != nil {
		if closeErr := c.kill.Close(); closeErr != nil {
			err = mapDriverErr(closeErr, c.db.server)
		}
		c.kill = nil
	}
	c.killMu.Unlock()
	return errors.Join(err, c.db.Close())
}

// connectionID is the MySQL connection id of conn: the thread id of its server session, or, through ProxySQL, the id of its
// ProxySQL session, which ProxySQL answers for the statement itself and which its KILL QUERY names (CFG-35). It is read once for
// each connection of the pool.
func (c *CatalogConnection) connectionID(ctx context.Context, conn *sql.Conn) (key any, id int64, err error) {
	if err := conn.Raw(func(driverConn any) error {
		key = driverConn
		return nil
	}); err != nil {
		return nil, 0, mapDriverErr(err, c.db.server)
	}
	if known, ok := c.ids.Load(key); ok {
		if id, ok := known.(int64); ok {
			return key, id, nil
		}
	}
	if err := conn.QueryRowContext(ctx, "SELECT CONNECTION_ID()").Scan(&id); err != nil {
		return nil, 0, mapDriverErrContext(err, ctx, c.db.server)
	}
	c.ids.Store(key, id)
	return key, id, nil
}

// killQuery ends the running statement of the MySQL connection id through the kill connection of the catalog, which it opens at
// the first stop and keeps (CFG-35). The killed statement ends with an error on its own connection, which stays open. A kill
// connection that fails is closed, and the next stop opens another.
func (c *CatalogConnection) killQuery(ctx context.Context, id int64) error {
	c.killMu.Lock()
	defer c.killMu.Unlock()
	if c.kill == nil {
		conn, err := c.acquire(ctx)
		if err != nil {
			return err
		}
		c.kill = conn
	}
	if _, err := c.kill.ExecContext(ctx, "KILL QUERY "+strconv.FormatInt(id, 10)); err != nil {
		// database/sql closes a connection whose Raw callback reports driver.ErrBadConn, and Raw returns that error.
		if rawErr := c.kill.Raw(func(any) error { return driver.ErrBadConn }); rawErr != nil && !errors.Is(rawErr, driver.ErrBadConn) {
			err = errors.Join(err, rawErr)
		}
		c.kill = nil
		c.reopenUntil.Store(time.Now().Add(2 * time.Second).UnixNano())
		return err
	}
	return nil
}

// ensureOpen fails with CATALOG_CLOSED once Close has run.
func (c *CatalogConnection) ensureOpen() error {
	if c.closed.Load() {
		return catalogErr(CodeCatalogClosed, "the catalog connection is closed")
	}
	return nil
}

// catalogSession is one pooled connection inside one transaction. A session whose transaction ended with an acknowledged
// COMMIT or ROLLBACK returns its connection to the pool, a read-only SQLite session after it turned query_only off; any other
// session discards it.
type catalogSession struct {
	catalog *CatalogConnection
	// stopped is set when a budget stopped a read by closing its socket: the cancel of the read on PostgreSQL, and on MySQL when
	// no kill ended the statement (CFG-35).
	stopped bool
	// readOnly is set for a read-only session.
	readOnly bool
	// key and id are the driver connection and the MySQL connection id of a MySQL session; nil and 0 elsewhere.
	key     any
	id      int64
	ctx     context.Context
	conn    *sql.Conn
	dialect string
	// server is the server of a mysql connection, which reads an error number by its table (DIA-201); empty elsewhere.
	server string
	// rollbacks learns that SQLite rolled the transaction back by itself; it is nil on MySQL and PostgreSQL.
	rollbacks *rollbackWatch
	// settings are the values of the PostgreSQL output settings when the transaction began (INT-186); nil elsewhere.
	settings []any
}

// catalogOutputSettingColumns are the PostgreSQL settings that the output of a cell depends on by INT-185 (INT-186).
const catalogOutputSettingColumns = "current_setting('DateStyle'), current_setting('IntervalStyle'), current_setting('TimeZone'), " +
	"current_setting('extra_float_digits'), current_setting('bytea_output'), current_setting('lc_monetary'), " +
	"current_setting('search_path')"

// catalogOutputSettings reads the output settings in the transaction of a session.
const catalogOutputSettings = "SELECT " + catalogOutputSettingColumns

// catalogFixedOutputSettings sets, for the transaction of a session, the output settings under which the output of every cell kind
// is its exact text (INT-186): ISO leaves the order of date input as it was.
const catalogFixedOutputSettings = "SELECT set_config('DateStyle', 'ISO', true), set_config('extra_float_digits', '1', true), " +
	"set_config('bytea_output', 'hex', true)"

// catalogRuleSettingChanged refuses a read whose statement changed an output setting (INT-186).
func catalogRuleSettingChanged() error {
	return catalogErr(CodeCatalogValue, "the query changed a setting that the output of its values depends on")
}

// outputSettings reads the values of the output settings in the transaction of the session.
func (s *catalogSession) outputSettings() ([]any, error) {
	raw, err := s.queryRaw(catalogOutputSettings, nil, 2, catalogMetadataBytes)
	if err != nil {
		return nil, err
	}
	if len(raw.rows) != 1 {
		return nil, catalogErr(catalogCodeMetadata, "current_setting returned %d rows", len(raw.rows))
	}
	return raw.rows[0], nil
}

// settingsUnchanged refuses a PostgreSQL session whose output settings, read after its rows and before its transaction ends,
// differ from their values when the transaction began (INT-186): a change that no row carries, as in a result of no rows. A
// local setting reverts when the transaction ends, so the check runs inside it.
func (s *catalogSession) settingsUnchanged() error {
	if s.settings == nil {
		return nil
	}
	now, err := s.outputSettings()
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(now, s.settings) {
		return catalogRuleSettingChanged()
	}
	return nil
}

// begin opens a session with a read-only transaction or a writable one. A SQLite read-only session sets query_only first.
func (c *CatalogConnection) begin(ctx context.Context, readOnly bool) (*catalogSession, error) {
	if err := c.ensureOpen(); err != nil {
		return nil, err
	}
	conn, err := c.acquire(ctx)
	if err != nil {
		return nil, mapDriverErrContext(err, ctx, c.db.server)
	}
	s := &catalogSession{catalog: c, ctx: ctx, conn: conn, dialect: c.dialect, server: c.db.server, readOnly: readOnly}
	if c.dialect == "mysql" {
		if s.key, s.id, err = c.connectionID(ctx, conn); err != nil {
			return nil, s.discard(err)
		}
	}
	if readOnly && c.dialect == "sqlite" {
		if _, err := conn.ExecContext(ctx, "PRAGMA query_only=ON"); err != nil {
			return nil, s.discard(mapDriverErrContext(err, ctx, c.db.server))
		}
	}
	if readOnly && c.dialect == "mysql" {
		// At REPEATABLE READ the information schema answers from the snapshot of the transaction, so a descriptor read after
		// the rows could not differ from the one read before them (INT-121).
		if _, err := conn.ExecContext(ctx, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"); err != nil {
			return nil, s.discard(mapDriverErrContext(err, ctx, c.db.server))
		}
	}
	if _, err := conn.ExecContext(ctx, catalogBegin(c.dialect, readOnly)); err != nil {
		return nil, s.discard(mapDriverErrContext(err, ctx, c.db.server))
	}
	if c.dialect == "postgres" {
		// A catalog session runs after schema changes by design, and through PgBouncer a Parse of a text that the server connection
		// already holds never reaches the server, so a plan from before the change would fail with "cached plan must not change
		// result type". The transaction holds that server connection for the whole session (CFG-28).
		// A connection from the pool may hold statements of an earlier session: the driver forgets them on the client too, or
		// the next use of a text it remembers would name a statement that the server has released.
		if err := c.db.deallocate(ctx, conn); err != nil {
			return nil, s.discard(mapDriverErrContext(err, ctx, c.db.server))
		}
		if _, err := s.queryRaw(catalogFixedOutputSettings, nil, 2, catalogMetadataBytes); err != nil {
			return nil, s.end(err)
		}
		settings, err := s.outputSettings()
		if err != nil {
			return nil, s.end(err)
		}
		s.settings = settings
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

// acquire takes a connection of the pool. A socket that this catalog closed holds its place in max_user_connections until the
// server ends that thread. The server announces that to no one, so this is a timer: the reopen is tried again within the 2 s of
// CFG-35 from the close (within 40 ms measured). A connect that follows no close of this catalog fails at once.
func (c *CatalogConnection) acquire(ctx context.Context) (*sql.Conn, error) {
	conn, err := c.db.sql.Conn(ctx)
	for catalogConnectionsFull(err) && time.Now().UnixNano() < c.reopenUntil.Load() {
		time.Sleep(10 * time.Millisecond)
		conn, err = c.db.sql.Conn(ctx)
	}
	return conn, err
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
		err = errors.Join(err, mapDriverErr(rawErr, s.server))
	}
	if s.dialect == "mysql" {
		s.catalog.reopenUntil.Store(time.Now().Add(2 * time.Second).UnixNano())
		if s.key != nil {
			s.catalog.ids.Delete(s.key)
		}
	}
	return err
}

// release returns the connection of a session whose COMMIT the server acknowledged to the pool, for the next session: that
// transaction and its locks have ended, and a writable session changes no setting of its connection (INT-106c).
func (s *catalogSession) release() error {
	err := s.rollbacks.stop(s.conn)
	if closeErr := s.conn.Close(); closeErr != nil {
		err = errors.Join(err, mapDriverErr(closeErr, s.server))
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
		mapped := mapDriverErrContext(rollbackErr, s.ctx, s.server)
		err = errors.Join(err, &ir.Error{
			Code:  CodeRowRollbackFailed,
			Msg:   fmt.Sprintf("rollback: %v", mapped),
			Cause: mapped,
		})
		return s.discard(err)
	}
	// The transaction has ended, so the connection holds no lock and no state of the session: the pool keeps it for the next
	// session, and a catalog runs its sessions on one connection (CFG-35). query_only is a setting of the SQLite connection.
	if s.readOnly && s.dialect == "sqlite" {
		if _, offErr := s.conn.ExecContext(s.ctx, "PRAGMA query_only=OFF"); offErr != nil {
			return s.discard(errors.Join(err, mapDriverErrContext(offErr, s.ctx, s.server)))
		}
	}
	if releaseErr := s.release(); releaseErr != nil {
		return errors.Join(err, releaseErr)
	}
	return err
}

// catalogRead runs fn in a fresh read-only session and ends the session with its outcome.
func catalogRead[T any](ctx context.Context, c *CatalogConnection, fn func(s *catalogSession) (T, error)) (T, error) {
	var zero T
	s, err := c.begin(ctx, true)
	if err != nil {
		return zero, err
	}
	value, err := fn(s)
	if err == nil {
		err = s.settingsUnchanged()
	}
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
	value, err := fn(s)
	if err != nil {
		return zero, s.end(err)
	}
	if err := s.settingsUnchanged(); err != nil {
		return zero, s.end(err)
	}
	if _, err := s.conn.ExecContext(ctx, "COMMIT"); err != nil {
		mapped := mapDriverErrContext(err, ctx, c.db.server)
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
	return s.querySized(query, args, maxRows, maxBytes, false, catalogRawSize)
}

// queryCellsRaw reads a bounded result of cells like queryRaw, with the output settings of each row checked (INT-186).
func (s *catalogSession) queryCellsRaw(query string, args []any, maxRows int, maxBytes int) (catalogRaw, error) {
	return s.querySized(query, args, maxRows, maxBytes, true, catalogRawSize)
}

func catalogRawSize(value any, _ string, _ int) (int, error) { return catalogSize(value), nil }

// catalogSettingsRead runs the statement of a PostgreSQL read of cells so that each row carries the output settings under
// which the server writes it (INT-186): a MATERIALIZED CTE keeps a plan of its own, so the outer projection of a row runs
// right before the server sends that row and runs its output functions. A read query may end with one semicolon
// (catalogValidateReadOnly), which cannot stand inside the CTE.
func catalogSettingsRead(query string) string {
	if _, semicolon, _ := catalogWords(query, "postgres"); semicolon >= 0 {
		query = query[:semicolon]
	}
	return "WITH catalog_read AS MATERIALIZED (\n" + query + "\n) SELECT catalog_read.*, " + catalogOutputSettingColumns + " FROM catalog_read"
}

// querySized reads a bounded result like queryRaw, with size giving the bytes that each value of the 1-based column of its
// native type counts against maxBytes; an error of size ends the read with that error. A value that the driver could not
// decode fails with CATALOG_VALUE and keeps the failure as its cause (INT-172), and a PostgreSQL column of a type that
// INT-185 refuses by its type fails before any value is read. A read of cells (cells) on PostgreSQL checks the output settings
// of each row before its values (INT-186); the columns of the settings are no columns of the result and count against no
// budget.
func (s *catalogSession) querySized(query string, args []any, maxRows int, maxBytes int, cells bool, size func(value any, native string, column int) (int, error)) (raw catalogRaw, err error) {
	settings := 0
	if cells && s.settings != nil {
		query, settings = catalogSettingsRead(query), len(s.settings)
	}
	// The query has its own context: a budget that ends the read cancels it, so that closing the rows does not read the rest
	// of a result the server still streams (a cross join of the bench table would otherwise run to its end).
	qctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	rows, err := s.conn.QueryContext(qctx, query, args...)
	if err != nil {
		return catalogRaw{}, mapDriverErrContext(err, s.ctx, s.server)
	}
	stopped := false
	defer func() {
		if stopped {
			// The budget error is the one reported: a close that the stop interrupted may fail, as the stop ended the read,
			// so its error stays only as a cause of the budget error. A MySQL stop kills the statement through the kill
			// connection of the catalog, and the connection of the read stays open; when that kill fails, as when the server
			// refuses the kill connection, the cancel closes the socket, as it does on PostgreSQL (CFG-35).
			var killErr error
			if s.dialect == "mysql" {
				killErr = s.catalog.killQuery(s.ctx, s.id)
			}
			if s.dialect != "mysql" || killErr != nil {
				s.stopped = true
				cancel()
			}
			if closeErr := errors.Join(killErr, rows.Close()); closeErr != nil {
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
			raw, err = catalogRaw{}, errors.Join(err, mapDriverErrContext(closeErr, s.ctx, s.server))
		}
	}()
	names, err := rows.Columns()
	if err != nil {
		return catalogRaw{}, mapDriverErr(err, s.server)
	}
	columnTypes, err := rows.ColumnTypes()
	if err != nil {
		return catalogRaw{}, mapDriverErr(err, s.server)
	}
	if len(names) < settings || len(columnTypes) != len(names) {
		return catalogRaw{}, catalogErr(catalogCodeMetadata, "the read returned %d columns", len(names))
	}
	width := len(names) - settings
	names, columnTypes = names[:width], columnTypes[:width]
	raw = catalogRaw{names: names, types: make([]string, len(columnTypes))}
	for i, columnType := range columnTypes {
		raw.types[i] = columnType.DatabaseTypeName()
	}
	if err := newCatalogCells(s).refuseByType(raw.types); err != nil {
		stopped = true
		return catalogRaw{}, err
	}
	budget := 0
	for rows.Next() {
		if len(raw.rows) == maxRows {
			stopped = true
			return catalogRaw{}, catalogErr("CATALOG_LIMIT", "result has more than %d rows", maxRows)
		}
		values := make([]any, width+settings)
		pointers := make([]any, len(values))
		for i := range values {
			pointers[i] = &values[i]
		}
		// Scan into an any copies the driver value, so a failure of Scan is a value that the driver failed to decode (pgx
		// decodes a column in ScanColumn): CATALOG_VALUE with no column, the failure kept as its cause (INT-172).
		if err := rows.Scan(pointers...); err != nil {
			return catalogRaw{}, &ir.Error{Code: CodeCatalogValue, Msg: catalogTextDecodeFailure, Cause: err}
		}
		if settings > 0 && !reflect.DeepEqual(values[width:], s.settings) {
			stopped = true
			return catalogRaw{}, catalogRuleSettingChanged()
		}
		values = values[:width]
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
		return catalogRaw{}, mapDriverErrContext(err, s.ctx, s.server)
	}
	return raw, nil
}

// exec runs one statement and returns the number of rows it affected.
func (s *catalogSession) exec(query string, args []any) (int64, error) {
	result, err := s.conn.ExecContext(s.ctx, query, args...)
	if err != nil {
		return 0, mapDriverErrContext(err, s.ctx, s.server)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, mapDriverErr(err, s.server)
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
	return &ir.Error{Code: code, Msg: message.Sprintf(format, args...)}
}
