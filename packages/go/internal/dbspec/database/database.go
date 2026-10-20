// Package database opens the databases of the dbspec tools by URI.
package database

import (
	"database/sql"
	"fmt"
	"net/url"
	"strings"

	"github.com/go-sql-driver/mysql"
)

// Open opens the URI with the dialect's database/sql driver. The driver of the
// dialect is registered by the program that opens the database.
func Open(dialect, uri string) (*sql.DB, error) {
	u, err := url.Parse(uri)
	if err != nil {
		return nil, err
	}
	switch dialect {
	case "mysql":
		if u.Scheme != "mysql" || u.RawQuery != "" {
			return nil, fmt.Errorf("a MySQL URI is mysql://user@host:port/database without a query: %s", uri)
		}
		return MySQLDB(u)
	case "postgres":
		if u.Scheme != "postgres" {
			return nil, fmt.Errorf("a PostgreSQL URI starts with postgres://: %s", uri)
		}
		return sql.Open("pgx", uri)
	case "sqlite":
		if u.Scheme != "sqlite" || u.RawQuery != "" {
			return nil, fmt.Errorf("a SQLite URI is sqlite:///path without a query: %s", uri)
		}
		return sql.Open("sqlite", "file:"+u.Path)
	}
	return nil, fmt.Errorf("unknown dialect %s", dialect)
}

// MySQLDB opens the MySQL database of the URI u, which is mysql://user@host:port/database,
// with the go-sql-driver over TCP.
func MySQLDB(u *url.URL) (*sql.DB, error) {
	cfg := mysql.NewConfig()
	cfg.User = u.User.Username()
	cfg.Passwd, _ = u.User.Password()
	cfg.Net, cfg.Addr, cfg.DBName = "tcp", u.Host, strings.TrimPrefix(u.Path, "/")
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, err
	}
	return sql.OpenDB(connector), nil
}
