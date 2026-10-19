// Command go applies the chain of plans.json (tests/dbspec/plans.json; create-from-empty and
// rename-table-and-column) to one database with the Go engine
// (docs/spec/plans.md "Apply"). action is one of the following:
//
//   - apply-first: applies only the first plan of the chain.
//   - apply: applies the whole chain.
//   - stop: applies the whole chain, and stops after statement 1 of the second plan has run.
//   - recover: finishes an interrupted plan.
//   - rollback: rolls back the last plan in history.
//
// stdout gets one result line: "ok" on success, "stopped" when stop halted, apply
// error is "error <code>". Other errors are written to stderr and exit with 1.
//
// Usage: go run ./packages/go/internal/dbspec/apply <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>
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

	"github.com/polyspec/orm/packages/go/engine/dbspec"
)

// connectionRules is the statements that every client runs on a new connection
// (packages/go/internal/dialects connectionRules).
var connectionRules = map[string][]string{
	"mysql":    {"SET time_zone = '+00:00'"},
	"postgres": {"SET TimeZone = 'UTC'"},
	"sqlite":   {"PRAGMA foreign_keys = ON"},
}

// errStop is the error with which the stop action halts apply on an event.
var errStop = errors.New("stop")

func main() {
	if len(os.Args) != 5 {
		fmt.Fprintln(os.Stderr, "usage: go run ./packages/go/internal/dbspec/apply <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>")
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
	case "rollback":
		err = dbspec.Rollback(ctx, conn, d, plans, now, nil)
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

// chain is create-from-empty and rename-table-and-column from the plans.json at path.
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

// open opens the URI with the dialect's database/sql driver.
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
