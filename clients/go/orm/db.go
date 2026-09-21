// Package orm is the Go client runtime. Generated model packages build
// requests through Core; the runtime compiles them into plans, executes them
// on the model connection or the active transaction, and assembles models.
package orm

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/schema"
)

// Config is the connection configuration. Paths and secrets are declared,
// never discovered.
type Config struct {
	AESKey             string           // secret "aes" for aes and aes_hex columns
	BlindIndexKey      string           // secret for encrypted equality indexes
	AESVersion         int32            // version written with AES payloads; zero selects 1
	AESKeys            map[int32]string // every declared version, used to decode mixed-version rows
	PoolSize           int              // maximum open connections; zero uses the driver default
	StatementTimeoutMs int              // bound of every statement of the connection; zero keeps the server default
	PlanCacheSize      int              // maximum compiled plans; zero uses the default
	StatementCacheSize int              // maximum prepared statements; zero uses the default
	OnQuery            func(Event)
}

// Event is emitted for every executed statement when Config.OnQuery is set.
type Event struct {
	SQL      string
	Args     []any // binds; secret and clock slots are replaced by Secret and Now
	Duration time.Duration
	PlanID   string
	Err      error
}

// Secret replaces a secret bind wherever binds are shown.
const Secret = "$SECRET"

// NowBind replaces an executor clock bind wherever binds are shown.
const NowBind = "$NOW"

// Schema identifies the schema a generated package was built from.
type Schema struct {
	Hash string
}

// DB is a database connection with its schema engine, plan cache, and statement
// cache. A DB value is a handle: WithContext copies it with another context, and
// every copy shares one connection through dbMutable.
type DB struct {
	sql      *sql.DB
	eng      *engine.Engine
	ctx      context.Context
	root     *DB
	m        *dbMutable
	engines  map[string]*engine.Engine
	cfg      Config
	driver   string
	location *time.Location

	plans map[uint64]*cached
	stmts map[string]*sql.Stmt
}

// dbMutable is the state every handle of one connection shares.
type dbMutable struct {
	engineMu sync.RWMutex

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
}

var processSchemas = struct {
	sync.RWMutex
	byDriver map[string]map[string]*engine.Engine
}{byDriver: map[string]map[string]*engine.Engine{}}

// RegisterEngine makes a generated schema available to every connection of
// its dialect. Generated Connect calls it.
func RegisterEngine(eng *engine.Engine) error {
	if eng == nil || eng.P == nil || eng.M == nil {
		return configErr("schema engine is required")
	}
	driver := eng.P.D.Name()
	processSchemas.Lock()
	defer processSchemas.Unlock()
	if processSchemas.byDriver[driver] == nil {
		processSchemas.byDriver[driver] = map[string]*engine.Engine{}
	}
	processSchemas.byDriver[driver][eng.M.SchemaHash] = eng
	return nil
}

// CheckSchemaHash compares the generated schema hash with the loaded manifest.
func CheckSchemaHash(eng *engine.Engine, generated string) error {
	if eng.M.SchemaHash != generated {
		return &ir.Error{Code: CodeSchemaHashMismatch, Msg: fmt.Sprintf("generated models are from schema %s, the engine loaded %s: generate the models again", generated, eng.M.SchemaHash)}
	}
	return nil
}

func (d *DB) engineFor(hash string) *engine.Engine {
	d.m.engineMu.RLock()
	local := d.engines[hash]
	d.m.engineMu.RUnlock()
	if local != nil {
		return local
	}
	processSchemas.RLock()
	defer processSchemas.RUnlock()
	return processSchemas.byDriver[d.driver][hash]
}

// BackendWaitingForLock reports whether another backend of this PostgreSQL
// connection pool is waiting for a lock. The inspection is an ORM-owned
// orchestration capability; non-PostgreSQL adapters have no equivalent
// backend view and return false without exposing driver SQL to callers.
func (d *DB) BackendWaitingForLock(ctx context.Context) (bool, error) {
	if d == nil || d.sql == nil {
		return false, configErr("database connection is required")
	}
	if d.driver != "postgres" {
		return false, nil
	}
	var waiting bool
	err := d.sql.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1
		FROM pg_locks l
		JOIN pg_stat_activity a ON a.pid=l.pid
		WHERE a.datname=current_database()
		  AND a.pid<>pg_backend_pid()
		  AND NOT l.granted
	)`).Scan(&waiting)
	return waiting, mapDriverErr(err)
}

func (d *DB) compile(r *ir.Request) (*plan.Plan, error) {
	eng := d.engineFor(r.SchemaHash)
	if eng == nil {
		return nil, configErr("schema %s is not registered for %s", r.SchemaHash, d.driver)
	}
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

// Open connects to the database selected by the DSN URI scheme. The schema
// engine plans every statement in this process.
func Open(dsn string, eng *engine.Engine, cfg Config) (*DB, error) {
	if cfg.StatementTimeoutMs < 0 {
		return nil, configErr("statement timeout must not be negative")
	}
	parsed, err := parseDSN(dsn, cfg.StatementTimeoutMs)
	if err != nil {
		return nil, err
	}
	if eng == nil || eng.M == nil || eng.P == nil {
		return nil, configErr("schema engine is required")
	}
	if name := eng.P.D.Name(); name != parsed.driver {
		return nil, configErr("driver %s but the schema engine uses %s", parsed.driver, name)
	}
	return open(context.Background(), parsed, eng, cfg)
}

func open(ctx context.Context, dsn parsedDSN, eng *engine.Engine, cfg Config) (*DB, error) {
	if cfg.PlanCacheSize == 0 {
		cfg.PlanCacheSize = defaultCacheSize
	}
	if cfg.StatementCacheSize == 0 {
		cfg.StatementCacheSize = defaultCacheSize
	}
	if cfg.PlanCacheSize < 1 || cfg.StatementCacheSize < 1 {
		return nil, configErr("cache sizes must be positive")
	}
	sqlDriver, ok := lookupDriver(dsn.driver)
	if !ok {
		msg := fmt.Sprintf("driver %q is not registered", dsn.driver)
		if dsn.driver == "postgres" || dsn.driver == "sqlite" {
			msg += fmt.Sprintf(`: import _ "github.com/polyspec/orm/clients/go/orm/%s"`, dsn.driver)
		}
		return nil, configErr("%s", msg)
	}
	s, err := sql.Open(sqlDriver, dsn.native)
	if err != nil {
		return nil, configErr("%s", err)
	}
	if cfg.PoolSize < 0 {
		s.Close()
		return nil, configErr("pool size must not be negative")
	}
	if cfg.PoolSize > 0 {
		s.SetMaxOpenConns(cfg.PoolSize)
		s.SetMaxIdleConns(cfg.PoolSize)
	}
	if err := s.PingContext(ctx); err != nil {
		s.Close()
		return nil, mapDriverErr(err)
	}
	if dsn.driver == "sqlite" {
		if err := checkSQLite(ctx, s); err != nil {
			s.Close()
			return nil, err
		}
	}
	if cfg.AESVersion == 0 {
		cfg.AESVersion = 1
	}
	if len(cfg.AESKeys) == 0 && cfg.AESKey != "" {
		cfg.AESKeys = map[int32]string{cfg.AESVersion: cfg.AESKey}
	}
	if err := RegisterEngine(eng); err != nil {
		s.Close()
		return nil, err
	}
	return &DB{sql: s, eng: eng, ctx: ctx, m: &dbMutable{}, engines: map[string]*engine.Engine{eng.M.SchemaHash: eng}, cfg: cfg, driver: dsn.driver, location: dsn.location, plans: map[uint64]*cached{}, stmts: map[string]*sql.Stmt{}}, nil
}

// checkSQLite rejects SQLite builds older than the supported minimum.
func checkSQLite(ctx context.Context, s *sql.DB) error {
	var version string
	if err := s.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&version); err != nil {
		return mapDriverErr(err)
	}
	var major, minor int
	fmt.Sscanf(version, "%d.%d", &major, &minor)
	if major < 3 || major == 3 && minor < 46 {
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
		if err := d.sql.Close(); err != nil && d.m.closeErr == nil {
			d.m.closeErr = err
		}
	})
	return d.m.closeErr
}

// Stats returns the connection pool state.
func (d *DB) Stats() DBStats {
	stats := d.sql.Stats()
	return DBStats{MaxOpenConnections: stats.MaxOpenConnections, OpenConnections: stats.OpenConnections, InUse: stats.InUse, Idle: stats.Idle}
}

// Driver is the database of the connection: mysql, postgres, or sqlite.
func (d *DB) Driver() string { return d.driver }

// SetOnQuery replaces the query event hook.
func (d *DB) SetOnQuery(fn func(Event)) { d.cfg.OnQuery = fn }

// Drivers other than MySQL live in their own packages so a MySQL-only program
// does not link PostgreSQL and SQLite; import the driver package for its side
// effect.
var (
	driverMu   sync.RWMutex
	sqlDrivers = map[string]string{"mysql": "mysql"}
	errMappers = map[string]func(error) error{"mysql": mapMySQLErr}
)

// RegisterDriver registers a database driver and its error mapping. Driver
// packages call it from init.
func RegisterDriver(name, sqlDriver string, mapErr func(error) error) {
	driverMu.Lock()
	defer driverMu.Unlock()
	sqlDrivers[name] = sqlDriver
	errMappers[name] = mapErr
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
		st.Close()
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

// mapDriverErr converts driver errors named by the error catalog into coded
// errors and keeps the driver message.
func mapDriverErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &ir.Error{Code: CodeCanceled, Msg: err.Error()}
	}
	driverMu.RLock()
	mappers := errMappers
	driverMu.RUnlock()
	for _, m := range mappers {
		if mapped := m(err); mapped != err {
			return mapped
		}
	}
	return err
}

func mapMySQLErr(err error) error {
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
	case me.Number == 3024 || me.Number == 1317: // query timeout / interrupted
		return &ir.Error{Code: CodeCanceled, Msg: me.Error()}
	case me.Number == 1298:
		return configErr("dsn timezone: %s; a named zone needs the MySQL time zone tables (mysql_tzinfo_to_sql)", me.Message)
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

func manifestEntity(eng *engine.Engine, name string) *schema.Entity {
	if eng == nil || eng.M == nil {
		return nil
	}
	return eng.M.Entities[name]
}

func quoteText(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
