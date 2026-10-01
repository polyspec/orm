// Package dialects holds the schema dialect fact probes of docs/dialects.md.
//
// Each probe states one observable fact about MySQL, PostgreSQL or SQLite,
// runs DDL, DML and catalog queries in its own disposable database, schema or
// file, and fails when the database does not behave as stated. The physical
// test in facts_physical_test.go runs every probe with its own deadline.
package dialects

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
)

// Probe is one asserted fact. ID is stable and is cited by docs/dialects.md.
type Probe struct {
	ID   string
	DB   string
	Fact string
	Run  func(e *Env)
}

// probeID is <database>.<topic>.<fact>.
var probeID = regexp.MustCompile(`^(mysql|postgres|sqlite)\.[a-z0-9_]+\.[a-z0-9_]+$`)

// All returns every probe ordered by database and ID.
func All() []Probe {
	var all []Probe
	all = append(all, mysqlProbes()...)
	all = append(all, postgresProbes()...)
	all = append(all, sqliteProbes()...)
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].DB != all[j].DB {
			return dbOrder(all[i].DB) < dbOrder(all[j].DB)
		}
		return all[i].ID < all[j].ID
	})
	return all
}

func dbOrder(db string) int {
	switch db {
	case "mysql":
		return 0
	case "postgres":
		return 1
	}
	return 2
}

// Validate reports duplicate or malformed probe IDs and a database prefix
// that differs from the probe database.
func Validate(probes []Probe) error {
	seen := map[string]bool{}
	for _, p := range probes {
		if !probeID.MatchString(p.ID) {
			return fmt.Errorf("probe ID %q does not match %s", p.ID, probeID)
		}
		if !strings.HasPrefix(p.ID, p.DB+".") {
			return fmt.Errorf("probe %s runs on %s", p.ID, p.DB)
		}
		if seen[p.ID] {
			return fmt.Errorf("duplicate probe ID %s", p.ID)
		}
		seen[p.ID] = true
		if p.Fact == "" || p.Run == nil {
			return fmt.Errorf("probe %s has no fact or body", p.ID)
		}
	}
	return nil
}

// Env is the connection of one probe. A failed step records the first error;
// later steps do nothing, so a probe body reads as its list of steps.
type Env struct {
	Ctx     context.Context
	Conn    *sql.Conn
	DB      string
	Name    string // database, schema or file of this probe
	Session func() (*Env, error)
	Admin   *sql.DB // server connection used to create and drop probe objects
	Extra   map[string]string
	Err     error
	Notes   []string
}

func (e *Env) fail(format string, args ...any) {
	if e.Err == nil {
		e.Err = fmt.Errorf(format, args...)
	}
}

// Note records an observed value for the probe report.
func (e *Env) Note(format string, args ...any) {
	e.Notes = append(e.Notes, fmt.Sprintf(format, args...))
}

// Exec runs statements that must succeed.
func (e *Env) Exec(statements ...string) {
	for _, s := range statements {
		if e.Err != nil {
			return
		}
		if _, err := e.Conn.ExecContext(e.Ctx, s); err != nil {
			e.fail("%s: %v", s, err)
		}
	}
}

// ExecArgs runs one statement with bind values.
func (e *Env) ExecArgs(statement string, args ...any) {
	if e.Err != nil {
		return
	}
	if _, err := e.Conn.ExecContext(e.Ctx, statement, args...); err != nil {
		e.fail("%s: %v", statement, err)
	}
}

// Fails runs a statement that must fail with the given error: a MySQL error
// number, a PostgreSQL SQLSTATE, or a substring of the SQLite message.
func (e *Env) Fails(statement, want string, args ...any) {
	if e.Err != nil {
		return
	}
	_, err := e.Conn.ExecContext(e.Ctx, statement, args...)
	if err == nil {
		e.fail("%s: succeeded; want error %s", statement, want)
		return
	}
	got := ErrorCode(err)
	if e.DB == "sqlite" {
		if !strings.Contains(got, want) {
			e.fail("%s: error %q; want message containing %q", statement, got, want)
		}
		return
	}
	if got != want {
		e.fail("%s: error %s (%v); want %s", statement, got, err, want)
	}
}

// ErrorCode returns the MySQL error number, the PostgreSQL SQLSTATE or the
// SQLite message of an error.
func ErrorCode(err error) string {
	var my *mysql.MySQLError
	if errors.As(err, &my) {
		return strconv.Itoa(int(my.Number))
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code
	}
	return err.Error()
}

// Value returns the first column of the first row as text; SQL NULL is NULL.
func (e *Env) Value(query string, args ...any) string {
	if e.Err != nil {
		return ""
	}
	var v sql.NullString
	if err := e.Conn.QueryRowContext(e.Ctx, query, args...).Scan(&v); err != nil {
		e.fail("%s: %v", query, err)
		return ""
	}
	if !v.Valid {
		return "NULL"
	}
	return v.String
}

// Column returns the first column of every row joined by a comma.
func (e *Env) Column(query string, args ...any) string {
	if e.Err != nil {
		return ""
	}
	rows, err := e.Conn.QueryContext(e.Ctx, query, args...)
	if err != nil {
		e.fail("%s: %v", query, err)
		return ""
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		e.fail("%s: %v", query, err)
		return ""
	}
	var out []string
	for rows.Next() {
		values := make([]sql.NullString, len(columns))
		targets := make([]any, len(columns))
		for i := range values {
			targets[i] = &values[i]
		}
		if err := rows.Scan(targets...); err != nil {
			e.fail("%s: %v", query, err)
			return ""
		}
		cells := make([]string, len(values))
		for i, v := range values {
			cells[i] = "NULL"
			if v.Valid {
				cells[i] = v.String
			}
		}
		out = append(out, strings.Join(cells, "|"))
	}
	if err := rows.Err(); err != nil {
		e.fail("%s: %v", query, err)
	}
	return strings.Join(out, ",")
}

// Want compares the first value of a query with the expected text.
func (e *Env) Want(query, want string, args ...any) {
	got := e.Value(query, args...)
	if e.Err == nil && got != want {
		e.fail("%s: got %q; want %q", query, got, want)
	}
}

// WantRows compares Column output with the expected text.
func (e *Env) WantRows(query, want string, args ...any) {
	got := e.Column(query, args...)
	if e.Err == nil && got != want {
		e.fail("%s: got %q; want %q", query, got, want)
	}
}

// Check records a failure when ok is false.
func (e *Env) Check(ok bool, format string, args ...any) {
	if e.Err == nil && !ok {
		e.fail(format, args...)
	}
}

// Other opens another connection to the same probe database.
func (e *Env) Other() *Env {
	if e.Err != nil {
		return &Env{Err: e.Err}
	}
	other, err := e.Session()
	if err != nil {
		e.fail("open second session: %v", err)
		return &Env{Err: e.Err}
	}
	return other
}

// Merge copies the first error of a second session into this probe.
func (e *Env) Merge(other *Env) {
	if other != nil && other.Err != nil {
		e.fail("second session: %v", other.Err)
	}
	if other != nil && other.Conn != nil {
		if err := other.Conn.Close(); err != nil {
			e.fail("close second session: %v", err)
		}
		other.Conn = nil
	}
}
