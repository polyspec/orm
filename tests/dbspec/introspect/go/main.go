// Command go는 한 database를 Go engine으로 introspect해 tests/dbspec/introspect의
// 출력 형식으로 쓴다: stdout에 canonical 문서와 미지원 객체 줄
// "! kind<TAB>table<TAB>name", stderr에 미지원 객체마다 "reason ..." 줄과 "elapsed <ms>".
//
// Usage: go run ./tests/dbspec/introspect/go <mysql|postgres|sqlite> <uri>
package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/engine/dbspec"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: go run ./tests/dbspec/introspect/go <mysql|postgres|sqlite> <uri>")
		os.Exit(2)
	}
	dialect, uri := os.Args[1], os.Args[2]
	db, err := open(dialect, uri)
	if err != nil {
		fail(err)
	}
	defer db.Close()
	start := time.Now()
	document, unsupported, err := dbspec.Introspect(context.Background(), db, dbspec.Dialect(dialect), "introspected")
	if err != nil {
		fail(err)
	}
	elapsed := time.Since(start)
	var b strings.Builder
	b.WriteString(dbspec.Emit(document))
	for _, u := range unsupported {
		fmt.Fprintf(&b, "! %s\t%s\t%s\n", u.Kind, u.Table, u.Name)
		fmt.Fprintf(os.Stderr, "reason %s %s %s: %s\n", u.Kind, u.Table, u.Name, u.Reason)
	}
	os.Stdout.WriteString(b.String())
	fmt.Fprintf(os.Stderr, "elapsed %.1f\n", float64(elapsed.Microseconds())/1000)
}

// open은 URI를 dialect의 database/sql driver로 연다.
func open(dialect, uri string) (*sql.DB, error) {
	u, err := url.Parse(uri)
	if err != nil {
		return nil, err
	}
	switch dialect {
	case "mysql":
		if u.Scheme != "mysql" || u.RawQuery != "" {
			return nil, fmt.Errorf("a MySQL URI is mysql://user@host:port/database without a query: %s", uri)
		}
		cfg := mysql.NewConfig()
		cfg.User = u.User.Username()
		cfg.Passwd, _ = u.User.Password()
		cfg.Net, cfg.Addr, cfg.DBName = "tcp", u.Host, strings.TrimPrefix(u.Path, "/")
		connector, err := mysql.NewConnector(cfg)
		if err != nil {
			return nil, err
		}
		return sql.OpenDB(connector), nil
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

func fail(err error) {
	fmt.Fprintln(os.Stderr, "introspect:", err)
	os.Exit(1)
}
