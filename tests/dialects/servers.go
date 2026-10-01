package dialects

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// Servers holds the administrative connections that create and drop the
// disposable database, schema or file of each probe.
type Servers struct {
	mysqlConfig *mysql.Config
	mysqlAdmin  *sql.DB
	mysqlErr    error // connection failure; every MySQL probe reports it
	postgresDSN string
	postgres    *sql.DB
	postgresErr error // connection failure; every PostgreSQL probe reports it
	sqliteDir   string
	run         string
}

// OpenServers connects to the MySQL and PostgreSQL servers named by the DSN
// URIs and uses dir for SQLite files. run distinguishes concurrent runs. A
// server that cannot be reached is not skipped: each of its probes fails
// with the connection error, so the other databases still report results.
func OpenServers(ctx context.Context, mysqlDSN, postgresDSN, dir, run string) (*Servers, error) {
	cfg, err := mysqlConfig(mysqlDSN)
	if err != nil {
		return nil, err
	}
	s := &Servers{mysqlConfig: cfg, postgresDSN: postgresDSN, sqliteDir: dir, run: run}
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, err
	}
	s.mysqlAdmin = sql.OpenDB(connector)
	if err := s.mysqlAdmin.PingContext(ctx); err != nil {
		s.mysqlErr = fmt.Errorf("mysql: %w", err)
	}
	if s.postgres, err = sql.Open("pgx", postgresDSN); err != nil {
		return nil, err
	}
	if err := s.postgres.PingContext(ctx); err != nil {
		s.postgresErr = fmt.Errorf("postgres: %w", err)
	}
	return s, nil
}

// Unreachable returns the connection error of a database, or nil.
func (s *Servers) Unreachable(db string) error {
	switch db {
	case "mysql":
		return s.mysqlErr
	case "postgres":
		return s.postgresErr
	}
	return nil
}

// Close closes the administrative connections.
func (s *Servers) Close() error {
	return errors.Join(s.mysqlAdmin.Close(), s.postgres.Close())
}

// mysqlConfig converts a mysql:// DSN URI to a driver configuration without a
// default database.
func mysqlConfig(raw string) (*mysql.Config, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "mysql" {
		return nil, fmt.Errorf("invalid mysql DSN URI")
	}
	cfg := mysql.NewConfig()
	cfg.User = u.User.Username()
	cfg.Passwd, _ = u.User.Password()
	cfg.Net = "tcp"
	cfg.Addr = u.Host
	return cfg, nil
}

// Name is the disposable object name of the probe at index.
func (s *Servers) Name(index int) string { return fmt.Sprintf("dfx_%s_%03d", s.run, index) }

// Run creates the probe's database, schema or file, runs the probe and drops
// what it created. The returned notes are the values the probe observed.
func (s *Servers) Run(ctx, cleanup context.Context, p Probe, index int) ([]string, error) {
	if err := s.Unreachable(p.DB); err != nil {
		return nil, err
	}
	name := s.Name(index)
	e := &Env{Ctx: ctx, DB: p.DB, Name: name, Extra: map[string]string{}}
	var drop func() error
	var err error
	switch p.DB {
	case "mysql":
		drop, err = s.openMySQL(ctx, cleanup, e)
	case "postgres":
		drop, err = s.openPostgres(ctx, cleanup, e)
	case "sqlite":
		drop, err = s.openSQLite(ctx, e)
	default:
		err = fmt.Errorf("unknown database %s", p.DB)
	}
	if err != nil {
		if drop != nil {
			err = errors.Join(err, drop())
		}
		return nil, err
	}
	p.Run(e)
	return e.Notes, errors.Join(e.Err, drop())
}

func (s *Servers) openMySQL(ctx, cleanup context.Context, e *Env) (func() error, error) {
	if _, err := s.mysqlAdmin.ExecContext(ctx, "CREATE DATABASE `"+e.Name+"`"); err != nil {
		return nil, err
	}
	cfg := s.mysqlConfig.Clone()
	cfg.DBName = e.Name
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, err
	}
	db := sql.OpenDB(connector)
	e.Admin = s.mysqlAdmin
	e.Extra["addr"] = s.mysqlConfig.Addr
	e.Session = func() (*Env, error) {
		conn, err := db.Conn(ctx)
		return &Env{Ctx: ctx, Conn: conn, DB: e.DB, Name: e.Name}, err
	}
	drop := func() error {
		var errs []error
		if e.Conn != nil {
			errs = append(errs, e.Conn.Close())
		}
		errs = append(errs, db.Close())
		// A probe that creates a login names it after its database.
		_, err := s.mysqlAdmin.ExecContext(cleanup, "DROP USER IF EXISTS '"+e.Name+"'@'127.0.0.1'")
		errs = append(errs, err)
		_, err = s.mysqlAdmin.ExecContext(cleanup, "DROP DATABASE `"+e.Name+"`")
		errs = append(errs, err)
		var count int
		err = s.mysqlAdmin.QueryRowContext(cleanup, "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", e.Name).Scan(&count)
		errs = append(errs, err)
		if err == nil && count != 0 {
			errs = append(errs, fmt.Errorf("database %s remains after cleanup", e.Name))
		}
		return errors.Join(errs...)
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return drop, err
	}
	e.Conn = conn
	return drop, nil
}

func (s *Servers) openPostgres(ctx, cleanup context.Context, e *Env) (func() error, error) {
	if _, err := s.postgres.ExecContext(ctx, `CREATE SCHEMA "`+e.Name+`"`); err != nil {
		return nil, err
	}
	db, err := sql.Open("pgx", s.postgresDSN)
	if err != nil {
		return nil, err
	}
	e.Admin = s.postgres
	open := func() (*sql.Conn, error) {
		conn, err := db.Conn(ctx)
		if err != nil {
			return nil, err
		}
		if _, err := conn.ExecContext(ctx, `SET search_path TO "`+e.Name+`"`); err != nil {
			return nil, errors.Join(err, conn.Close())
		}
		return conn, nil
	}
	e.Session = func() (*Env, error) {
		conn, err := open()
		return &Env{Ctx: ctx, Conn: conn, DB: e.DB, Name: e.Name}, err
	}
	drop := func() error {
		var errs []error
		if e.Conn != nil {
			errs = append(errs, e.Conn.Close())
		}
		errs = append(errs, db.Close())
		// A probe that needs a second schema names it <schema>_b.
		_, err := s.postgres.ExecContext(cleanup, `DROP SCHEMA IF EXISTS "`+e.Name+`_b" CASCADE`)
		errs = append(errs, err)
		_, err = s.postgres.ExecContext(cleanup, `DROP SCHEMA "`+e.Name+`" CASCADE`)
		errs = append(errs, err)
		var count int
		err = s.postgres.QueryRowContext(cleanup, "SELECT COUNT(*) FROM pg_namespace WHERE nspname IN ($1, $2)", e.Name, e.Name+"_b").Scan(&count)
		errs = append(errs, err)
		if err == nil && count != 0 {
			errs = append(errs, fmt.Errorf("schema %s remains after cleanup", e.Name))
		}
		return errors.Join(errs...)
	}
	conn, err := open()
	if err != nil {
		return drop, err
	}
	e.Conn = conn
	return drop, nil
}

func (s *Servers) openSQLite(ctx context.Context, e *Env) (func() error, error) {
	path := filepath.Join(s.sqliteDir, e.Name+".sqlite")
	if _, err := os.Stat(path); err == nil {
		return nil, fmt.Errorf("SQLite file %s already exists", path)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	e.Extra["path"] = path
	e.Session = func() (*Env, error) {
		conn, err := db.Conn(ctx)
		return &Env{Ctx: ctx, Conn: conn, DB: e.DB, Name: e.Name}, err
	}
	drop := func() error {
		var errs []error
		if e.Conn != nil {
			errs = append(errs, e.Conn.Close())
		}
		errs = append(errs, db.Close())
		for _, suffix := range []string{"", "-journal", "-wal", "-shm"} {
			if err := os.Remove(path + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
			if _, err := os.Stat(path + suffix); err == nil {
				errs = append(errs, fmt.Errorf("%s remains after cleanup", path+suffix))
			}
		}
		return errors.Join(errs...)
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return drop, err
	}
	e.Conn = conn
	return drop, nil
}
