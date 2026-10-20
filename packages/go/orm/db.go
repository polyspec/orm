// Package orm is the Go client runtime. Generated model packages build
// requests through Core; the runtime compiles them into plans, executes them
// on the model connection or the active transaction, and assembles models.
package orm

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/packages/go/engine"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

// Config is the connection configuration. Paths and secrets are declared,
// never discovered.
type Config struct {
	AESKey             string           // key of AESVersion for aes writes; empty takes AESKeys[AESVersion]
	BlindIndexKey      string           // secret for encrypted equality indexes
	AESVersion         int32            // version written with AES payloads; zero selects 1
	AESKeys            map[int32]string // every declared version, used to decode mixed-version rows
	PoolSize           int              // maximum open connections; zero uses 10
	PoolIdleSize       int              // maximum idle connections; zero keeps up to PoolSize
	PoolLifetimeMs     int              // lifetime of a connection in milliseconds; zero keeps connections without a bound
	StatementTimeoutMs int              // bound of every statement of the connection; zero keeps the server default
	PlanCacheSize      int              // maximum compiled plans; zero uses the default
	StatementCacheSize int              // maximum prepared statements; zero uses the default
	// AuditSource returns the audit values of the current request, a map from
	// column name to value of the audit record table, such as the account and
	// the request id. A transaction with orm.Audit calls it once with the
	// transaction's context; an error fails the transaction. The ORM writes no
	// audit value of its own.
	AuditSource func(ctx context.Context) (map[string]any, error)
}

// Secret replaces a secret bind wherever binds are shown.
const Secret = "$SECRET"

// NowBind replaces an executor clock bind wherever binds are shown.
const NowBind = "$NOW"

// Schema is the manifest that the generated package holds: the document set's manifest
// text and its manifestHash. The runtime model is built once, the first time it is used.
type Schema struct {
	Hash string
	Text string
	// External is the text of the external documents that the set uses from external tables (runtimemodel.Model.ExternalText).
	// A set that uses no external documents is empty.
	External string

	once  sync.Once
	model *runtimemodel.Model
	err   error
}

// Model returns the runtime model of the manifest text. If the text is wrong, it returns
// SCHEMA_INVALID, and if the text's hash differs from Hash, SCHEMA_HASH_MISMATCH.
func (s *Schema) Model() (*runtimemodel.Model, error) {
	s.once.Do(func() {
		m, diagnostics := runtimemodel.LoadSet(s.Text, s.External)
		switch {
		case len(diagnostics) > 0:
			s.err = &ir.Error{Code: CodeSchemaInvalid, Msg: runtimemodel.DiagnosticsError(diagnostics)}
		case m.ManifestHash != s.Hash:
			s.err = &ir.Error{Code: CodeSchemaHashMismatch, Msg: fmt.Sprintf("generated code declares manifest %s, its manifest text hashes to %s: generate the models again", s.Hash, m.ManifestHash)}
		default:
			s.model = m
		}
	})
	return s.model, s.err
}

// DB is a database connection with its schema engine, plan cache, and statement
// cache. A DB value is a handle: WithContext copies it with another context, and
// every copy shares one connection through dbMutable.
type DB struct {
	sql *sql.DB
	// md is the flowmark session pool of a markdown:// connection. On SQL connections it is nil, and sql takes that
	// place.
	md   *mdPool
	ctx  context.Context
	root *DB
	// hook is the request hook of this handle. If nil, the request is planned as is.
	hook     RequestHook
	m        *dbMutable
	cfg      Config
	driver   string
	location *time.Location

	plans map[uint64]*cached
	stmts map[string]*sql.Stmt
}

// dbMutable is the state every handle of one connection shares.
type dbMutable struct {
	// engines holds the engine of this connection's dialect for each manifestHash.
	engineMu sync.RWMutex
	engines  map[string]*engine.Engine
	// schemas holds the schema registered for each hash in engines.
	schemas map[string]*Schema

	planMu    sync.RWMutex
	planOrder []uint64

	stmMu     sync.Mutex
	stmtOrder []string

	closeOnce sync.Once
	closed    atomic.Bool
	closeErr  error

	sqliteRowLockMu    sync.Mutex
	sqliteRowLockReady atomic.Bool

	keyringOnce sync.Once
	keyring     AESKeyring
	keyringErr  error

	// subs holds the connection's statement event subscribers and the transaction number.
	subs subscribers

	// rollbackFault is the test fault that FailNextRollback sets. Only builds with the build tag
	// ormtest can set it.
	rollbackFault atomic.Bool

	// statementFault is the test fault that FailNextStatement sets. The next statement
	// that consumes it resets it to nil. Only builds with the ormtest build tag can set it.
	statementFault atomic.Pointer[stmtFault]

	// fixedClock is the test clock that FixClock sets. When it is set, the executor clock is
	// this time. Only builds with the ormtest build tag can set it.
	fixedClock atomic.Pointer[time.Time]

	// lastAffected is the connection's last successful write result's affected count plus 1,
	// or 0 if there was no write. LastAffected reads it, and only builds with the ormtest build tag
	// have it.
	lastAffected atomic.Int64
}

// engineFor returns the engine of the schema registered on this connection. If the text the request's generated
// code holds does not hash to the declared hash, or its manifest is not registered on this connection,
// it is SCHEMA_HASH_MISMATCH. The target a request can run against is decided
// by the database the connection writes, not by the code the process read, so a connection plans only
// the sets registered to it.
func (d *DB) engineFor(s *Schema) (*engine.Engine, error) {
	if s == nil {
		return nil, configErr("the model has no schema")
	}
	if _, err := s.Model(); err != nil {
		return nil, err
	}
	d.m.engineMu.RLock()
	eng := d.m.engines[s.Hash]
	d.m.engineMu.RUnlock()
	if eng == nil {
		return nil, &ir.Error{Code: CodeSchemaHashMismatch, Msg: fmt.Sprintf("manifest %s is not registered on this connection: connect through its generated package or install it", s.Hash)}
	}
	return eng, nil
}

// registeredModel is the runtime model of the schema registered on this connection. An SQL connection uses the engine's
// model, and a markdown connection, which does not plan, uses the model of the set it registered. If it is not registered,
// it is SCHEMA_HASH_MISMATCH.
func (d *DB) registeredModel(s *Schema) (*runtimemodel.Model, error) {
	if d.md != nil {
		return d.markdownModel(s)
	}
	eng, err := d.engineFor(s)
	if err != nil {
		return nil, err
	}
	return eng.M, nil
}

// registered is the runtime model of the schema to register. If the text does not hash to the declared hash,
// it is CONFIG before any statement, and if the text is not a manifest, it is SCHEMA_INVALID.
func (s *Schema) registered() (*runtimemodel.Model, error) {
	if s == nil {
		return nil, configErr("schema is required")
	}
	m, err := s.Model()
	if ErrorCode(err) == CodeSchemaHashMismatch {
		return nil, configErr("invalid schema manifest: %s", err.(*ir.Error).Msg)
	}
	return m, err
}

// register registers the schema's set on this connection. Registering the same set again changes nothing.
func (d *DB) register(s *Schema) error {
	m, err := s.registered()
	if err != nil {
		return err
	}
	d.m.engineMu.Lock()
	defer d.m.engineMu.Unlock()
	if d.m.schemas[s.Hash] != nil {
		return nil
	}
	// A markdown connection does not plan (docs/spec/protocol.md §5), so it registers only the set, without a dialect engine.
	if d.md != nil {
		d.m.schemas[s.Hash] = s
		return nil
	}
	eng, err := engine.New(m, d.driver)
	if err != nil {
		return err
	}
	d.m.engines[s.Hash] = eng
	d.m.schemas[s.Hash] = s
	return nil
}

// BackendWaitingForLock reports whether another backend of this PostgreSQL
// connection pool is waiting for a lock. The inspection is an ORM-owned
// orchestration capability; non-PostgreSQL adapters have no equivalent
// backend view and return false without exposing driver SQL to callers.
func (d *DB) BackendWaitingForLock(ctx context.Context) (bool, error) {
	if d != nil {
		if err := d.unsupportedOnMarkdown("backendWaitingForLock"); err != nil {
			return false, err
		}
	}
	if d == nil || d.sql == nil {
		return false, configErr("database connection is required")
	}
	if d.driver != "postgres" {
		return false, nil
	}
	var waiting bool
	err := (runner{d: d, q: d.sql}).scan(ctx, KindUtility, nil, `SELECT EXISTS(
		SELECT 1
		FROM pg_locks l
		JOIN pg_stat_activity a ON a.pid=l.pid
		WHERE a.datname=current_database()
		  AND a.pid<>pg_backend_pid()
		  AND NOT l.granted
	)`, nil, &waiting)
	return waiting, err
}

func (d *DB) compile(eng *engine.Engine, r *ir.Request) (*plan.Plan, error) {
	if err := ir.Validate(eng.M, r); err != nil {
		return nil, err
	}
	return eng.P.Compile(r)
}

// DBStats reports the connection pool state.
type DBStats struct {
	MaxOpenConnections int
	OpenConnections    int
	InUse              int
	Idle               int
}

const defaultCacheSize = 256

// defaultPoolSize is the maximum of open connections when Config.PoolSize is
// zero; the TypeScript and Rust clients use the same value.
const defaultPoolSize = 10

// Connect opens the database selected by the DSN URI scheme. The connection
// has no schema registered: a model request on it fails with
// SCHEMA_HASH_MISMATCH until Install registers the set of the model.
func Connect(dsn string, cfg Config) (*DB, error) {
	if cfg.StatementTimeoutMs < 0 {
		return nil, configErr("statement timeout must not be negative")
	}
	parsed, err := parseDSN(dsn, cfg.StatementTimeoutMs)
	if err != nil {
		return nil, err
	}
	return open(context.Background(), parsed, cfg)
}

// ConnectSchema opens the database selected by the DSN URI scheme and
// registers the set of a generated schema on the connection, as
// Utils().Schema().Register does; the connect helper of a generated package
// calls it. A manifest text that does not hash to its declared hash fails
// with CONFIG before the connection opens. Registering reads nothing from the
// database: Install and AddTablesAndColumns verify the database.
func ConnectSchema(dsn string, s *Schema, cfg Config) (*DB, error) {
	if _, err := s.registered(); err != nil {
		return nil, err
	}
	d, err := Connect(dsn, cfg)
	if err != nil {
		return nil, err
	}
	if err := d.register(s); err != nil {
		return nil, closeAfter(d, err)
	}
	return d, nil
}

func open(ctx context.Context, dsn parsedDSN, cfg Config) (*DB, error) {
	if cfg.PlanCacheSize == 0 {
		cfg.PlanCacheSize = defaultCacheSize
	}
	if cfg.StatementCacheSize == 0 {
		cfg.StatementCacheSize = defaultCacheSize
	}
	if cfg.PlanCacheSize < 1 || cfg.StatementCacheSize < 1 {
		return nil, configErr("cache sizes must be positive")
	}
	if dsn.driver == "markdown" {
		return openMarkdown(ctx, dsn, cfg)
	}
	sqlDriver, ok := lookupDriver(dsn.driver)
	if !ok {
		msg := fmt.Sprintf("driver %q is not registered", dsn.driver)
		// The driver package names are pg and sqlite.
		if pkg := map[string]string{"postgres": "pg", "sqlite": "sqlite"}[dsn.driver]; pkg != "" {
			msg += fmt.Sprintf(`: import _ "github.com/polyspec/orm/packages/go/orm/%s"`, pkg)
		}
		return nil, configErr("%s", msg)
	}
	s, err := openSQL(sqlDriver, dsn)
	if err != nil {
		return nil, configErr("%s", err)
	}
	if cfg.PoolSize < 0 {
		return nil, closeAfter(s, configErr("pool size must not be negative"))
	}
	if cfg.PoolSize == 0 {
		cfg.PoolSize = defaultPoolSize
	}
	if cfg.PoolIdleSize < 0 || cfg.PoolIdleSize > cfg.PoolSize {
		return nil, closeAfter(s, configErr("pool idle size must be between 0 and the pool size %d", cfg.PoolSize))
	}
	if cfg.PoolIdleSize == 0 {
		cfg.PoolIdleSize = cfg.PoolSize
	}
	if cfg.PoolLifetimeMs < 0 {
		return nil, closeAfter(s, configErr("pool lifetime must not be negative"))
	}
	s.SetMaxOpenConns(cfg.PoolSize)
	s.SetMaxIdleConns(cfg.PoolIdleSize)
	s.SetConnMaxLifetime(time.Duration(cfg.PoolLifetimeMs) * time.Millisecond)
	if err := s.PingContext(ctx); err != nil {
		return nil, closeAfter(s, mapDriverErr(err))
	}
	if dsn.driver == "sqlite" {
		if err := checkSQLite(); err != nil {
			return nil, closeAfter(s, err)
		}
	}
	if cfg.AESVersion == 0 {
		cfg.AESVersion = 1
	}
	// AESKey is the key of AESVersion: writes encrypt with it, and AESKeys
	// holds it at AESVersion.
	switch {
	case len(cfg.AESKeys) == 0 && cfg.AESKey != "":
		cfg.AESKeys = map[int32]string{cfg.AESVersion: cfg.AESKey}
	case cfg.AESKey == "":
		cfg.AESKey = cfg.AESKeys[cfg.AESVersion]
	case cfg.AESKeys[cfg.AESVersion] != cfg.AESKey:
		return nil, closeAfter(s, configErr("AESKey differs from AESKeys[%d]", cfg.AESVersion))
	}
	return &DB{sql: s, ctx: ctx, m: &dbMutable{engines: map[string]*engine.Engine{}, schemas: map[string]*Schema{}}, cfg: cfg, driver: dsn.driver, location: dsn.location, plans: map[uint64]*cached{}, stmts: map[string]*sql.Stmt{}}, nil
}

// closeAfter closes c, which the failed call does not return, and returns err; a failed Close is joined to err.
func closeAfter(c io.Closer, err error) error {
	if closeErr := c.Close(); closeErr != nil {
		return errors.Join(err, closeErr)
	}
	return err
}

// checkSQLite rejects SQLite builds older than the supported minimum. The
// version is the library version the SQLite driver package registers, so
// connecting sends no statement to learn it.
func checkSQLite() error {
	driverMu.RLock()
	version := sqliteVersion
	driverMu.RUnlock()
	if version == "" {
		return &ir.Error{Code: CodeConfig, Msg: "the SQLite driver registered no library version"}
	}
	// A version that does not start with major.minor is refused as older, like a version below 3.46.
	var major, minor int
	if _, err := fmt.Sscanf(version, "%d.%d", &major, &minor); err != nil || major < 3 || major == 3 && minor < 46 {
		return &ir.Error{Code: CodeCapabilityUnsupported, Msg: "SQLite " + version + " is older than 3.46"}
	}
	return nil
}

// WithContext returns a handle on the same connection whose statements run
// under ctx: cancelling ctx cancels the statement in flight and returns
// ErrCanceled. Models connect to the handle as they connect to the connection,
// and transactions started on it inherit the context. Closing either handle
// closes the connection.
func (d *DB) WithContext(ctx context.Context) *DB {
	if ctx == nil {
		ctx = context.Background()
	}
	handle := *d
	handle.ctx = ctx
	handle.root = d.Root()
	return &handle
}

// RequestHook receives each request of a handle right before the client plans
// it (docs/operations/usage.md "Request hook"). It changes r in place; addParam appends a
// value to the request parameters and returns its index, and params is a copy of
// the parameters that the request binds, which the hook reads. An error it
// returns fails the operation unchanged before any statement.
type RequestHook func(r *ir.Request, addParam func(value any) int, params []any) error

// WithRequestHook returns a handle on the same connection whose hook receives
// each request of the handle before planning. The handle shares the pool, the
// caches, the subscribers and the active transactions, and keeps the context
// of d; a handle carries one hook, so a hooked d gets the new hook. The client
// plans the changed request as any other, so the planner validates it.
func (d *DB) WithRequestHook(hook RequestHook) *DB {
	handle := *d
	handle.hook = hook
	handle.root = d.Root()
	return &handle
}

// Root returns the connection a handle was derived from, so two handles of one
// connection compare equal. A connection returns itself.
func (d *DB) Root() *DB {
	if d.root != nil {
		return d.root
	}
	return d
}

// Close releases cached statements and the connection pool. It is idempotent.
func (d *DB) Close() error {
	d.m.closeOnce.Do(func() {
		d.m.closed.Store(true)
		d.m.planMu.Lock()
		d.plans = map[uint64]*cached{}
		d.m.planOrder = nil
		d.m.planMu.Unlock()
		d.m.stmMu.Lock()
		for key, st := range d.stmts {
			if err := st.Close(); err != nil && d.m.closeErr == nil {
				d.m.closeErr = fmt.Errorf("close statement %q: %w", key, err)
			}
		}
		d.stmts = map[string]*sql.Stmt{}
		d.m.stmtOrder = nil
		d.m.stmMu.Unlock()
		if d.md != nil {
			if err := d.md.close(); err != nil && d.m.closeErr == nil {
				d.m.closeErr = err
			}
			return
		}
		if err := d.sql.Close(); err != nil && d.m.closeErr == nil {
			d.m.closeErr = err
		}
	})
	return d.m.closeErr
}

// Stats returns the connection pool state.
func (d *DB) Stats() DBStats {
	if d.md != nil {
		return d.md.stats()
	}
	stats := d.sql.Stats()
	return DBStats{MaxOpenConnections: stats.MaxOpenConnections, OpenConnections: stats.OpenConnections, InUse: stats.InUse, Idle: stats.Idle}
}

// Driver is the database of the connection: mysql, postgres, sqlite, or
// markdown, a corpus that a flowmark server serves.
func (d *DB) Driver() string { return d.driver }

// Drivers other than MySQL live in their own packages so a MySQL-only program
// does not link PostgreSQL and SQLite; import the driver package for its side
// effect.
var (
	driverMu   sync.RWMutex
	sqlDrivers = map[string]string{"mysql": "mysql"}
	errMappers = map[string]func(error) error{"mysql": mapMySQLErr}
	// sqliteVersion is the library version that the SQLite driver package registered.
	sqliteVersion string
)

// RegisterSQLiteVersion registers the version of the SQLite library that the
// SQLite driver package links. The SQLite driver package calls it from init.
func RegisterSQLiteVersion(version string) {
	driverMu.Lock()
	defer driverMu.Unlock()
	sqliteVersion = version
}

// RegisterDriver registers a database driver and its error mapping. Driver
// packages call it from init.
func RegisterDriver(name, sqlDriver string, mapErr func(error) error) {
	driverMu.Lock()
	defer driverMu.Unlock()
	sqlDrivers[name] = sqlDriver
	errMappers[name] = mapErr
}

// openSQL opens the database/sql pool. The MySQL driver reads datetime cells
// in the connection time zone, so a cell arrives as the value localTime
// returns unchanged.
func openSQL(sqlDriver string, dsn parsedDSN) (*sql.DB, error) {
	if dsn.driver != "mysql" || sqlDriver != "mysql" {
		return sql.Open(sqlDriver, dsn.native)
	}
	cfg, err := mysql.ParseDSN(dsn.native)
	if err != nil {
		return nil, err
	}
	cfg.Loc = dsn.location
	if dsn.sslCA != "" {
		// ssl-mode=VERIFY_IDENTITY: TLS that checks the server certificate against the CA and the host name.
		// The password travels only inside TLS: the driver sends the caching_sha2_password
		// secret over TLS, and requests the server's RSA public key only when there is no TLS.
		pem, err := os.ReadFile(dsn.sslCA)
		if err != nil {
			return nil, fmt.Errorf("mysql DSN ssl-ca %s cannot be read: %w", dsn.sslCA, err)
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("mysql DSN ssl-ca %s holds no PEM certificate", dsn.sslCA)
		}
		cfg.TLS = &tls.Config{RootCAs: roots, ServerName: dsn.sslHost, MinVersion: tls.VersionTLS12}
	}
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, err
	}
	return sql.OpenDB(connector), nil
}

func lookupDriver(name string) (string, bool) {
	driverMu.RLock()
	defer driverMu.RUnlock()
	d, ok := sqlDrivers[name]
	return d, ok
}

func (d *DB) stmt(ctx context.Context, sqlText string) (*sql.Stmt, error) {
	d.m.stmMu.Lock()
	st, ok := d.stmts[sqlText]
	d.m.stmMu.Unlock()
	if ok {
		return st, nil
	}
	st, err := d.sql.PrepareContext(ctx, sqlText)
	if err != nil {
		return nil, mapDriverErr(err)
	}
	d.m.stmMu.Lock()
	defer d.m.stmMu.Unlock()
	if prev, ok := d.stmts[sqlText]; ok {
		if err := st.Close(); err != nil {
			return nil, mapDriverErr(err)
		}
		return prev, nil
	}
	d.stmts[sqlText] = st
	d.m.stmtOrder = append(d.m.stmtOrder, sqlText)
	for len(d.m.stmtOrder) > d.cfg.StatementCacheSize {
		oldest := d.m.stmtOrder[0]
		d.m.stmtOrder = d.m.stmtOrder[1:]
		if old, exists := d.stmts[oldest]; exists {
			delete(d.stmts, oldest)
			_ = old.Close()
		}
	}
	return st, nil
}

// mapDriverErr reports a driver error that the error catalog names with its code, and the rest
// as DRIVER. An error with a code keeps the driver message and the driver
// error as its cause.
func mapDriverErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &ir.Error{Code: CodeCanceled, Msg: err.Error(), Cause: err}
	}
	var coded *ir.Error
	if errors.As(err, &coded) {
		return err
	}
	driverMu.RLock()
	mappers := errMappers
	driverMu.RUnlock()
	for _, m := range mappers {
		if mapped := m(err); mapped != err {
			if errors.As(mapped, &coded) && coded.Cause == nil {
				coded.Cause = err
			}
			return mapped
		}
	}
	// An error the driver reports as unable to use the connection any further is a lost-connection error.
	if errors.Is(err, driver.ErrBadConn) {
		return &ir.Error{Code: CodeConnectionLost, Msg: err.Error(), Cause: err}
	}
	// Other driver errors, such as a write a trigger refused, are DRIVER.
	return &ir.Error{Code: CodeDriver, Msg: err.Error(), Cause: err}
}

func mapMySQLErr(err error) error {
	// go-sql-driver reports a statement on a connection the server ended or that dropped as ErrInvalidConn.
	if errors.Is(err, mysql.ErrInvalidConn) {
		return &ir.Error{Code: CodeConnectionLost, Msg: err.Error()}
	}
	var me *mysql.MySQLError
	if !errors.As(err, &me) {
		return err
	}
	state := string(me.SQLState[:])
	switch {
	case me.Number == 3572: // ER_LOCK_NOWAIT
		return &ir.Error{Code: CodeLockNotAvailable, Msg: me.Error()}
	case me.Number == 1213 || state == "40001":
		return &ir.Error{Code: CodeDeadlock, Msg: me.Error()}
	case me.Number == 1062 || (me.Number == 0 && state == "23000"):
		return &ir.Error{Code: CodeDuplicateKey, Msg: me.Error()}
	case me.Number == 1451 || me.Number == 1452:
		return &ir.Error{Code: CodeForeignKey, Msg: me.Error()}
	case me.Number == 3819 || me.Number == 4025: // check constraint violated
		return &ir.Error{Code: CodeConstraint, Msg: me.Error()}
	case me.Number == 1290 || me.Number == 1792: // read-only server / READ ONLY transaction
		return &ir.Error{Code: CodeReadOnly, Msg: me.Error()}
	case me.Number == 3024 || me.Number == 1317: // query timeout / interrupted
		return &ir.Error{Code: CodeCanceled, Msg: me.Error()}
	case me.Number == 4031: // ER_CLIENT_INTERACTION_TIMEOUT: the server ended an idle connection
		return &ir.Error{Code: CodeConnectionLost, Msg: me.Error()}
	}
	return err
}

// Error is the coded error returned by the ORM.
type Error = ir.Error

// ErrorCode returns the ORM error code carried by err, or an empty string.
func ErrorCode(err error) string {
	var e *ir.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// TransactionConflict creates the retryable DEADLOCK error.
func TransactionConflict(message string) error {
	return &ir.Error{Code: CodeDeadlock, Msg: message}
}

// IsDeadlock reports a DEADLOCK error.
func IsDeadlock(err error) bool { return ErrorCode(err) == CodeDeadlock }

// IsLockNotAvailable reports that a NOWAIT lock could not be acquired.
func IsLockNotAvailable(err error) bool { return ErrorCode(err) == CodeLockNotAvailable }

// IsDuplicateKey reports a DUPLICATE_KEY error.
func IsDuplicateKey(err error) bool { return ErrorCode(err) == CodeDuplicateKey }

// IsForeignKey reports a FOREIGN_KEY error.
func IsForeignKey(err error) bool { return ErrorCode(err) == CodeForeignKey }

// IsConstraint reports a database constraint violation independent of the driver.
func IsConstraint(err error) bool { return ErrorCode(err) == CodeConstraint }

// IsNoRows reports a NO_ROWS error.
func IsNoRows(err error) bool { return ErrorCode(err) == CodeNoRows }

func configErr(format string, a ...any) error {
	return &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf(format, a...)}
}

func quoteText(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
