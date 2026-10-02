// Command go는 plans.json(tests/dbspec/plans.json)의 chain(create-from-empty와
// rename-table-and-column)을 Go engine으로 한 database에 적용한다
// (docs/plans.md "Apply"). action은 다음 중 하나다:
//
//   - apply-first: chain의 첫 plan만 적용한다.
//   - apply: chain 전체를 적용한다.
//   - stop: chain 전체를 적용하다가 둘째 plan의 statement 1이 실행된 뒤 멈춘다.
//   - recover: 중단된 MySQL plan을 이어서 끝낸다.
//
// stdout에는 결과 한 줄을 쓴다: 성공은 "ok", stop이 멈춘 것은 "stopped", apply
// error는 "error <code>"다. 그 밖의 error는 stderr에 쓰고 1로 끝난다.
//
// Usage: go run ./tests/dbspec/apply/go <apply-first|apply|stop|recover> <mysql|postgres|sqlite> <uri> <plans.json>
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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

// connectionRules는 모든 client가 새 connection에서 실행하는 statement다
// (tests/dialects connectionRules).
var connectionRules = map[string][]string{
	"mysql":    {"SET time_zone = '+00:00'"},
	"postgres": {"SET TimeZone = 'UTC'"},
	"sqlite":   {"PRAGMA foreign_keys = ON"},
}

// errStop은 stop action이 event에서 apply를 멈추는 error다.
var errStop = errors.New("stop")

func main() {
	if len(os.Args) != 5 {
		fmt.Fprintln(os.Stderr, "usage: go run ./tests/dbspec/apply/go <apply-first|apply|stop|recover> <mysql|postgres|sqlite> <uri> <plans.json>")
		os.Exit(2)
	}
	action, dialect, uri, vectors := os.Args[1], os.Args[2], os.Args[3], os.Args[4]
	result, err := run(action, dialect, uri, vectors)
	if err != nil {
		fmt.Fprintln(os.Stderr, "apply runner:", err)
		os.Exit(1)
	}
	fmt.Println(result)
}

func run(action, dialect, uri, vectors string) (string, error) {
	plans, err := chain(vectors)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	db, err := open(dialect, uri)
	if err != nil {
		return "", err
	}
	defer db.Close()
	conn, err := db.Conn(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	for _, rule := range connectionRules[dialect] {
		if _, err := conn.ExecContext(ctx, rule); err != nil {
			return "", fmt.Errorf("%s: %w", rule, err)
		}
	}
	now := func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 123456789, time.UTC) }
	d := dbspec.Dialect(dialect)
	switch action {
	case "apply-first":
		err = dbspec.Apply(ctx, conn, d, plans[:1], now, nil)
	case "apply":
		err = dbspec.Apply(ctx, conn, d, plans, now, nil)
	case "recover":
		err = dbspec.Recover(ctx, conn, d, plans, now, nil)
	case "stop":
		err = dbspec.Apply(ctx, conn, d, plans, now, func(ev dbspec.ApplyEvent) error {
			if ev.Kind == "applied" && ev.Plan == plans[1].Name && ev.Step == 1 {
				return errStop
			}
			return nil
		})
		if err == errStop {
			return "stopped", nil
		}
		if err == nil {
			return "", errors.New("stop: apply did not stop")
		}
	default:
		return "", fmt.Errorf("unknown action %s", action)
	}
	var applyErr *dbspec.ApplyError
	switch {
	case err == nil:
		return "ok", nil
	case errors.As(err, &applyErr) && error(applyErr) == err:
		return "error " + applyErr.Code, nil
	}
	return "", err
}

// chain은 path의 plans.json에서 create-from-empty와 rename-table-and-column이다.
func chain(path string) ([]*dbspec.Plan, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var vectors struct {
		Cases []struct {
			ID   string   `json:"id"`
			Plan []string `json:"plan"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		return nil, err
	}
	var plans []*dbspec.Plan
	for _, c := range vectors.Cases {
		if c.ID != "create-from-empty" && c.ID != "rename-table-and-column" {
			continue
		}
		p, diagnostics := dbspec.ParsePlan(strings.Join(c.Plan, "\n") + "\n")
		if len(diagnostics) > 0 {
			return nil, fmt.Errorf("%s: %v", c.ID, diagnostics)
		}
		plans = append(plans, p)
	}
	if len(plans) != 2 || plans[1].From != plans[0].To {
		return nil, errors.New("plans.json does not chain create-from-empty and rename-table-and-column")
	}
	return plans, nil
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
