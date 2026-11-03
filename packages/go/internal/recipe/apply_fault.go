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
}

// QueryContext counts the reads of the SQLite master query and fails the chosen one.
func (f *faultConn) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	if strings.HasPrefix(query, "SELECT type, name, tbl_name") {
		f.reads++
		if f.cause != nil && f.reads == f.failAt {
			return nil, f.cause
		}
	}
	return f.Conn.QueryContext(ctx, query, args...)
}

// checkApplyFault runs one dbspec.apply_fault step (FCV-4): the public Apply or Rollback on a memory SQLite connection,
// after applied_first and sql, with the fail_catalog_read-th read of the SQLite master query in the call failing. An injected
// failure must reach the apply error as its cause (PLN-92, PLN-93, PLN-96).
func checkApplyFault(t *testing.T, s step, bound map[string]result, database string) error {
	var want struct {
		Code         string   `json:"code"`
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
	var kinds []string
	events := func(event dbspec.ApplyEvent) error {
		kinds = append(kinds, event.Kind)
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
	}
	var applyErr *dbspec.ApplyError
	if !errors.As(failure, &applyErr) || applyErr.Code != want.Code {
		return fmt.Errorf("the call returned %v, want the code %s", failure, want.Code)
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
