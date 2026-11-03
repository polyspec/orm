package recipe

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/testcase"
)

// faultConn wraps a SQLite connection: read failAt of the SQLite master query fails with cause.
type faultConn struct {
	*sql.Conn
	cause  error
	failAt int
	reads  int
	fail   map[string]error
	noRow  []string
}

// QueryContext counts the reads of the SQLite master query and fails the chosen one.
func (f *faultConn) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	if strings.HasPrefix(query, "SELECT type, name, tbl_name") {
		f.reads++
		if f.cause != nil && f.reads == f.failAt {
			return nil, f.cause
		}
	}
	if slices.Contains(f.noRow, query) {
		return f.Conn.QueryContext(ctx, "SELECT 1 WHERE 0")
	}
	return f.Conn.QueryContext(ctx, query, args...)
}

// ExecContext fails a statement of fail in the call.
func (f *faultConn) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	if err, ok := f.fail[query]; ok {
		return nil, err
	}
	return f.Conn.ExecContext(ctx, query, args...)
}

// sqliteResult is an error of a SQLite result code, as the driver returns it.
type sqliteResult struct {
	message string
	code    int
}

func (e sqliteResult) Error() string { return e.message }
func (e sqliteResult) Code() int     { return e.code }

// checkApplyFault runs one dbspec.apply_fault step (FCV-4): the public Apply or Rollback on a memory SQLite connection,
// after applied_first and sql, with the fail_catalog_read-th read of the SQLite master query in the call failing. An injected
// failure must reach the apply error as its cause (PLN-92, PLN-93, PLN-96). Errors.Join holds the failure, then the cleanup
// errors in order (PLN-97, PLN-106).
func checkApplyFault(t *testing.T, s step, bound map[string]result, database string) error {
	var want struct {
		Code         string   `json:"code"`
		Failure      string   `json:"failure"`
		FailureEnds  string   `json:"failure_ends_with"`
		Cleanup      []string `json:"cleanup"`
		HistoryState string   `json:"history_state"`
		AbsentEvents []string `json:"absent_events"`
	}
	if err := json.Unmarshal(s.Expect[database], &want); err != nil {
		return err
	}
	plan, err := dbspecPlan(s.Plan, bound)
	if err != nil {
		return err
	}
	plans := []*dbspec.Plan{plan}
	now := func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	ctx := context.Background()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return err
	}
	defer testcase.Close(t, db)
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer testcase.Close(t, conn)
	fault := &faultConn{Conn: conn}
	if s.AppliedFirst {
		result, err := dbspec.Apply(ctx, fault, dbspec.DialectSQLite, plans, now, nil)
		if err != nil {
			return err
		}
		if result.Failure != nil {
			return result.Failure
		}
	}
	for _, statement := range s.SQL {
		if _, err := conn.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	if s.FailCatalogRead > 0 {
		fault.cause = errors.New("catalog read failed")
		fault.failAt = fault.reads + s.FailCatalogRead
	}
	fault.noRow = s.NoRowQueries
	if s.FailStatements != nil {
		fault.fail = map[string]error{}
		for _, f := range s.FailStatements {
			var injected error = errors.New(f.Message)
			if f.SQLiteResult != 0 {
				injected = sqliteResult{message: f.Message, code: f.SQLiteResult}
			}
			fault.fail[f.Statement] = injected
		}
	}
	var kinds []string
	events := func(event dbspec.ApplyEvent) error {
		kinds = append(kinds, event.Kind)
		if s.StopOnApplied != "" && event.Kind == "applied" {
			return errors.New(s.StopOnApplied)
		}
		return nil
	}
	var failure error
	if s.Call == "rollback" {
		failure = dbspec.Rollback(ctx, fault, dbspec.DialectSQLite, plans, now, events)
	} else {
		result, err := dbspec.Apply(ctx, fault, dbspec.DialectSQLite, plans, now, events)
		failure = err
		if err == nil && result.Failure != nil {
			failure = result.Failure
		}
		if err == nil && result.Stopped {
			failure = result.Stop
		}
	}
	if failure == nil {
		return fmt.Errorf("the call succeeded, want %+v", want)
	}
	if want.Code != "" {
		var applyErr *dbspec.ApplyError
		if !errors.As(failure, &applyErr) || applyErr.Code != want.Code {
			return fmt.Errorf("the call returned %v, want the code %s", failure, want.Code)
		}
	}
	messages := strings.Split(failure.Error(), "\n")
	if want.Failure != "" && messages[0] != want.Failure {
		return fmt.Errorf("the failure is %q, want %q", messages[0], want.Failure)
	}
	if !strings.HasSuffix(messages[0], want.FailureEnds) {
		return fmt.Errorf("the failure is %q, want it to end with %q", messages[0], want.FailureEnds)
	}
	if want.Cleanup != nil && !slices.Equal(messages[1:], want.Cleanup) {
		return fmt.Errorf("the cleanup errors are %q, want %q", messages[1:], want.Cleanup)
	}
	if fault.cause != nil && !errors.Is(failure, fault.cause) {
		return fmt.Errorf("the error %v does not hold the catalog read error", failure)
	}
	if want.HistoryState != "" {
		var state string
		if err := conn.QueryRowContext(ctx, `SELECT state FROM "dbspec$plans"`).Scan(&state); err != nil {
			return err
		}
		if state != want.HistoryState {
			return fmt.Errorf("the history state is %s, want %s", state, want.HistoryState)
		}
	}
	for _, kind := range want.AbsentEvents {
		if slices.Contains(kinds, kind) {
			return fmt.Errorf("the events %v hold %s", kinds, kind)
		}
	}
	return nil
}
