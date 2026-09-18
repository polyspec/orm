package ormgen

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// toolDSN is a database named by the same DSN URI the clients accept:
// mysql://, postgres://, or sqlite://<absolute path>. The scheme selects the
// dialect.
type toolDSN struct {
	dialect string
	driver  string
	native  string
	raw     string
}

func parseToolDSN(raw string) (toolDSN, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return toolDSN{}, fmt.Errorf("MIGRATION_CONFIG: dsn must be a URI using mysql://, postgres://, or sqlite://")
	}
	out := toolDSN{dialect: strings.ToLower(u.Scheme), raw: raw}
	q := u.Query()
	switch out.dialect {
	case "mysql":
		if u.Host == "" || strings.Trim(u.Path, "/") == "" {
			return toolDSN{}, fmt.Errorf("MIGRATION_CONFIG: mysql DSN must include host and database")
		}
		cfg := mysql.NewConfig()
		cfg.DBName = strings.Trim(u.Path, "/")
		cfg.Net, cfg.Addr = "tcp", u.Host
		if socket := q.Get("socket"); socket != "" {
			cfg.Net, cfg.Addr = "unix", socket
		}
		if u.User != nil {
			cfg.User = u.User.Username()
			cfg.Passwd, _ = u.User.Password()
		}
		if zone := q.Get("timezone"); zone != "" {
			cfg.Params = map[string]string{"time_zone": "'" + strings.ReplaceAll(zone, "'", "''") + "'"}
		}
		out.driver, out.native = "mysql", cfg.FormatDSN()
	case "postgres":
		if u.Host == "" && q.Get("host") == "" || strings.Trim(u.Path, "/") == "" {
			return toolDSN{}, fmt.Errorf("MIGRATION_CONFIG: postgres DSN must include host and database")
		}
		q.Del("timezone")
		u.RawQuery = q.Encode()
		out.driver, out.native = "pgx", u.String()
	case "sqlite":
		if !strings.HasPrefix(u.Path, "/") || u.Host != "" {
			return toolDSN{}, fmt.Errorf("MIGRATION_CONFIG: sqlite DSN must be sqlite://<absolute path>")
		}
		out.driver, out.native = "sqlite", u.Path
	default:
		return toolDSN{}, fmt.Errorf("MIGRATION_CONFIG: unsupported DSN scheme %q; want mysql, postgres, or sqlite", u.Scheme)
	}
	return out, nil
}

// redacted names the database without its password.
func (d toolDSN) redacted() string {
	u, err := url.Parse(d.raw)
	if err != nil {
		return d.dialect + "://"
	}
	return u.Redacted()
}

// openToolDB opens and pings the database named by a DSN URI.
func openToolDB(raw string) (*sql.DB, toolDSN, error) {
	dsn, err := parseToolDSN(raw)
	if err != nil {
		return nil, toolDSN{}, err
	}
	db, err := sql.Open(dsn.driver, dsn.native)
	if err != nil {
		return nil, toolDSN{}, fmt.Errorf("MIGRATION_CONNECT: dsn=%s: %w", dsn.redacted(), err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, toolDSN{}, fmt.Errorf("MIGRATION_CONNECT: dsn=%s: %w", dsn.redacted(), err)
	}
	return db, dsn, nil
}
