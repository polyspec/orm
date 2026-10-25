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
// Usage: go run ./packages/go/internal/dbspec/apply <apply-first|apply|stop|recover|rollback|lock-wait> <mysql|postgres|sqlite> <uri> <plans.json>
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/internal/dbspec/database"
	"github.com/polyspec/orm/packages/go/internal/dbspec/plancases"
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
		fmt.Fprintln(os.Stderr, "usage: go run ./packages/go/internal/dbspec/apply <apply-first|apply|stop|recover|rollback|lock-wait> <mysql|postgres|sqlite> <uri> <plans.json>")
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

func run(action, dialect, uri, vectors string) (_ string, err error) {
	var plans []*dbspec.Plan
	if action != "lock-wait" {
		plans, err = chain(vectors)
		if err != nil {
			return "", err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	db, err := database.Open(dialect, uri)
	if err != nil {
		return "", err
	}
	defer func() { err = errors.Join(err, db.Close()) }()
	conn, err := db.Conn(ctx)
	if err != nil {
		return "", err
	}
	defer func() { err = errors.Join(err, conn.Close()) }()
	for _, rule := range connectionRules[dialect] {
		if _, err := conn.ExecContext(ctx, rule); err != nil {
			return "", fmt.Errorf("%s: %w", rule, err)
		}
	}
	now := func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 123456789, time.UTC) }
	d := dbspec.Dialect(dialect)
	var res dbspec.ApplyResult
	switch action {
	case "lock-wait":
		return lockWait(ctx, conn, dialect, uri, vectors, now)
	case "apply-first":
		res, err = dbspec.Apply(ctx, conn, d, plans[:1], now, nil)
	case "apply":
		res, err = dbspec.Apply(ctx, conn, d, plans, now, nil)
	case "recover":
		err = dbspec.Recover(ctx, conn, d, plans, now, nil)
	case "rollback":
		err = dbspec.Rollback(ctx, conn, d, plans, now, nil)
	case "stop":
		res, err = dbspec.Apply(ctx, conn, d, plans, now, func(ev dbspec.ApplyEvent) error {
			if ev.Kind == "applied" && ev.Plan == plans[1].Name && ev.Step == 1 {
				return errStop
			}
			return nil
		})
		if err == nil && !res.Stopped && res.Failure == nil {
			return "", errors.New("stop: apply did not stop")
		}
	default:
		return "", fmt.Errorf("unknown action %s", action)
	}
	var applyErr *dbspec.ApplyError
	switch {
	case err == nil && res.Stopped:
		return "stopped", nil
	case err == nil && res.Failure != nil:
		return "error " + res.Failure.Code, nil
	case err == nil:
		return "ok", nil
	case errors.As(err, &applyErr) && unjoined(err):
		return "error " + applyErr.Code, nil
	}
	return "", err
}

// openBlocker opens a second connection to the database of uri, the session that holds the lock the apply under test
// waits for; the returned function closes the connection and its database handle and returns their errors.
func openBlocker(ctx context.Context, dialect, uri string) (*sql.Conn, func() error, error) {
	db, err := database.Open(dialect, uri)
	if err != nil {
		return nil, nil, err
	}
	return database.Conn(ctx, db)
}

// lockWait reports the error of closing the blocker with its own result, so a failed close is never lost.
func lockWait(ctx context.Context, conn *sql.Conn, dialect, uri, vectors string, now func() time.Time) (outcome string, err error) {
	plansOf := representativeChain
	if dialect == "sqlite" {
		plansOf = chain
	}
	plans, err := plansOf(vectors)
	if err != nil {
		return "", err
	}
	if dialect != "sqlite" {
		if _, err := dbspec.Apply(ctx, conn, dbspec.Dialect(dialect), plans[:1], now, nil); err != nil {
			return "", err
		}
	}
	blocker, closeBlocker, err := openBlocker(ctx, dialect, uri)
	if err != nil {
		return "", err
	}
	defer func() { err = errors.Join(err, closeBlocker()) }()
	if dialect == "sqlite" {
		return sqliteLockWait(ctx, conn, blocker, plans, now)
	}
	tx, err := blocker.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO archive (note) VALUES ('lock wait')"); err != nil {
		return "", errors.Join(err, tx.Rollback())
	}
	rows, err := tx.QueryContext(ctx, "SELECT id FROM archive FOR UPDATE")
	if err != nil {
		return "", errors.Join(err, tx.Rollback())
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return "", errors.Join(err, rows.Close(), tx.Rollback())
		}
	}
	if err := rows.Err(); err != nil {
		return "", errors.Join(err, rows.Close(), tx.Rollback())
	}
	if err := rows.Close(); err != nil {
		return "", errors.Join(err, tx.Rollback())
	}
	var events []string
	started := time.Now()
	res, err := dbspec.Apply(ctx, conn, dbspec.Dialect(dialect), plans, now, func(ev dbspec.ApplyEvent) error {
		if ev.Kind == "statement" || ev.Kind == "applied" {
			events = append(events, fmt.Sprintf("%s:%d", ev.Kind, ev.Step))
		}
		return nil
	})
	elapsed := time.Since(started)
	rollbackErr := tx.Rollback()
	if rollbackErr != nil {
		return "", fmt.Errorf("release statement lock blocker: %w", rollbackErr)
	}
	if err != nil {
		return "", err
	}
	if res.Failure == nil {
		return "", errors.New("statement lock wait returned no failure; want failed representative step 0")
	}
	if res.Failure.Code != "failed" || res.Failure.Plan != "representative" || res.Failure.Step != 0 {
		return "", fmt.Errorf(
			"statement lock wait returned %s at %s step %d: %w; want failed representative step 0",
			res.Failure.Code, res.Failure.Plan, res.Failure.Step, res.Failure,
		)
	}
	detail := strings.ToLower(res.Failure.Error())
	if !strings.Contains(detail, "lock") && !strings.Contains(detail, "timeout") {
		return "", fmt.Errorf("statement failure does not name the held lock: %w", res.Failure)
	}
	if strings.Join(events, ",") != "statement:0" {
		return "", fmt.Errorf("statement events = %v; want only statement:0", events)
	}
	if elapsed < 4*time.Second || elapsed >= 10*time.Second {
		return "", fmt.Errorf("statement lock wait returned after %s; want 4s <= elapsed < 10s", elapsed)
	}
	return "error failed", nil
}

// sqliteLockWait applies plans while blocker holds an exclusive SQLite lock, and checks that the apply waits about 5s
// and fails with the code locked.
func sqliteLockWait(ctx context.Context, conn, blocker *sql.Conn, plans []*dbspec.Plan, now func() time.Time) (string, error) {
	if _, err := blocker.ExecContext(ctx, "BEGIN EXCLUSIVE"); err != nil {
		return "", err
	}
	release := &releaseSQLiteBlocker{Execer: conn, blocker: blocker}
	started := time.Now()
	result, applyError := dbspec.Apply(ctx, release, dbspec.DialectSQLite, plans, now, nil)
	if !release.released {
		_, cleanupErr := blocker.ExecContext(context.Background(), "ROLLBACK")
		if cleanupErr != nil {
			applyError = errors.Join(applyError, fmt.Errorf("release SQLite lock blocker: %w", cleanupErr))
		}
	}
	if release.releaseErr != nil {
		applyError = errors.Join(applyError, fmt.Errorf("release SQLite lock blocker: %w", release.releaseErr))
	}
	elapsed := time.Since(started)
	if applyError != nil {
		return "", applyError
	}
	if result.Failure == nil {
		return "", errors.New("SQLite lock wait returned no failure; want locked")
	}
	if result.Failure.Code != "locked" {
		return "", fmt.Errorf("SQLite lock wait returned %s: %w; want locked", result.Failure.Code, result.Failure)
	}
	if !strings.Contains(strings.ToLower(result.Failure.Error()), "lock") {
		return "", fmt.Errorf("SQLite failure does not name the held lock: %w", result.Failure)
	}
	if elapsed < 4*time.Second || elapsed >= 10*time.Second {
		return "", fmt.Errorf("SQLite lock wait returned after %s; want 4s <= elapsed < 10s", elapsed)
	}
	return "error locked", nil
}

// releaseSQLiteBlocker mirrors the Python runner's test connection: once SQLite reports
// the bounded BEGIN EXCLUSIVE failure, release the independent blocker before apply restores
// its connection settings and performs its cleanup read.
type releaseSQLiteBlocker struct {
	dbspec.Execer
	blocker    *sql.Conn
	released   bool
	releaseErr error
}

func (c *releaseSQLiteBlocker) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	result, err := c.Execer.ExecContext(ctx, query, args...)
	if query == "BEGIN EXCLUSIVE" && err != nil && !c.released {
		_, c.releaseErr = c.blocker.ExecContext(context.Background(), "ROLLBACK")
		c.released = c.releaseErr == nil
	}
	return result, err
}

// unjoined reports whether err is not an errors.Join of several errors, so a failure returned alone is told apart
// from one returned with a cleanup failure.
func unjoined(err error) bool {
	_, joined := err.(interface{ Unwrap() []error })
	return !joined
}

// chain is create-from-empty and rename-table-and-column from the plans.json at path.
func chain(path string) ([]*dbspec.Plan, error) {
	cases, err := plancases.Read(path)
	if err != nil {
		return nil, err
	}
	var plans []*dbspec.Plan
	for _, c := range cases {
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

func representativeChain(path string) ([]*dbspec.Plan, error) {
	cases, err := plancases.Read(path)
	if err != nil {
		return nil, err
	}
	for _, c := range cases {
		if c.ID != "representative" {
			continue
		}
		source, diagnostics := dbspec.ParsePlan(strings.Join(append([]string{"dbplan 1 base", "from empty", ""}, c.Source...), "\n") + "\n")
		if len(diagnostics) > 0 {
			return nil, fmt.Errorf("representative source: %v", diagnostics)
		}
		target, diagnostics := dbspec.ParsePlan(strings.Join(c.Plan, "\n") + "\n")
		if len(diagnostics) > 0 {
			return nil, fmt.Errorf("representative target: %v", diagnostics)
		}
		if target.From != source.To {
			return nil, errors.New("representative plans do not chain")
		}
		return []*dbspec.Plan{source, target}, nil
	}
	return nil, errors.New("plans.json has no representative case")
}
