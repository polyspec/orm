package dbspec

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/packages/go/testcase"
)

// failing wraps a real SQLite connection, injects an error into a chosen statement, and
// replaces a chosen query with another query.
type failing struct {
	conn    *sql.Conn
	fail    map[string]error
	replace map[string]string
}

func (f *failing) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	if err, ok := f.fail[query]; ok {
		return nil, err
	}
	return f.conn.ExecContext(ctx, query, args...)
}

func (f *failing) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	if q, ok := f.replace[query]; ok {
		return f.conn.QueryContext(ctx, q)
	}
	return f.conn.QueryContext(ctx, query, args...)
}

func applyTestConn(t *testing.T) *sql.Conn {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "apply.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, db) })
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, conn) })
	return conn
}

func applyTestPlans(t *testing.T) []*Plan {
	t.Helper()
	v := loadPlanVectors(t)
	for _, c := range v.Cases {
		if c.ID == "create-from-empty" {
			p, diagnostics := ParsePlan(strings.Join(c.Plan, "\n") + "\n")
			if len(diagnostics) > 0 {
				t.Fatal(diagnostics)
			}
			return []*Plan{p}
		}
	}
	t.Fatal("plans.json has no create-from-empty case")
	return nil
}

// logResult reports the case's result and the time it took.
func logResult(t *testing.T, name string, start time.Time) {
	t.Helper()
	result := "PASS"
	if t.Failed() {
		result = "FAIL"
	}
	t.Logf("%s %s elapsed=%s", result, name, time.Since(start))
}

// TestApplyReportsCleanupErrors checks that when apply fails, the errors from cleanup (releasing the lock, restoring foreign key
// checks) are not discarded but returned together with it.
// Requirements: PLN-97.
func TestApplyReportsCleanupErrors(t *testing.T) {
	testcase.Start(t, testcase.Database)
	start := time.Now()
	t.Log("RUN apply/cleanup-errors deadline=20s")
	now := func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	plans := applyTestPlans(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	stop := errors.New("stop")
	stopAt := func(ev ApplyEvent) error {
		if ev.Kind == "applied" {
			return stop
		}
		return nil
	}
	// Without a cleanup error, it returns the failure unwrapped.
	if err := Apply(ctx, applyTestConn(t), DialectSQLite, plans, now, stopAt); !errors.Is(err, stop) || errors.Unwrap(err) != nil {
		t.Errorf("apply stopped by an event without a cleanup error: %#v, want the event error itself", err)
	}

	release := errors.New("release failed")
	c := &failing{conn: applyTestConn(t), fail: map[string]error{"PRAGMA locking_mode = normal": release}}
	err := Apply(ctx, c, DialectSQLite, plans, now, stopAt)
	if !errors.Is(err, stop) || !errors.Is(err, release) {
		t.Errorf("apply stopped by an event with a failing lock release: %v, want both errors", err)
	}

	begin := errors.New("begin failed")
	restore := errors.New("restore failed")
	c = &failing{conn: applyTestConn(t), fail: map[string]error{"BEGIN EXCLUSIVE": begin, "PRAGMA foreign_keys = 0": restore}}
	err = Apply(ctx, c, DialectSQLite, plans, now, nil)
	if applyErr := (*ApplyError)(nil); !errors.As(err, &applyErr) || applyErr.Code != "locked" || !errors.Is(err, restore) {
		t.Errorf("apply with a failing BEGIN EXCLUSIVE and foreign key restore: %v, want locked and the restore error", err)
	}
	logResult(t, "apply/cleanup-errors", start)
}

// TestEffectRequiresRow checks that when an effect query returns no row, it is reported as an error
// rather than read as no effect.
func TestEffectRequiresRow(t *testing.T) {
	testcase.Start(t, testcase.Database)
	start := time.Now()
	t.Log("RUN apply/effect-row deadline=5s")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := &failing{conn: applyTestConn(t), replace: map[string]string{effectQueries[DialectSQLite]["table"]: "SELECT 1 WHERE 0"}}
	a := &applier{ctx: ctx, c: c, r: renderer{d: DialectSQLite}}
	if _, err := a.effect(present("table", "orders", "")); err == nil {
		t.Error("effect with a query that returns no row: no error")
	}
	logResult(t, "apply/effect-row", start)
}

// TestRollbackRejectsRecordedStepOutsidePlan checks that when the step of an applied row is outside the plan's steps, rollback stops without reading the step
// with a chain error (docs/spec/plans.md "Apply").
func TestRollbackRejectsRecordedStepOutsidePlan(t *testing.T) {
	testcase.Start(t, testcase.Database)
	start := time.Now()
	t.Log("RUN apply/rollback-step-outside deadline=20s")
	now := func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	plans := applyTestPlans(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn := applyTestConn(t)
	if err := Apply(ctx, conn, DialectSQLite, plans, now, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, `UPDATE "dbspec$plans" SET step = 99`); err != nil {
		t.Fatal(err)
	}
	err := Rollback(ctx, conn, DialectSQLite, plans, now, nil)
	applyErr := (*ApplyError)(nil)
	if !errors.As(err, &applyErr) || applyErr.Code != "chain" || !strings.Contains(applyErr.Message, "the recorded step 99 is outside the plan's") {
		t.Errorf("rollback of an applied row at step 99: %v, want a chain error about the recorded step", err)
	}
	logResult(t, "apply/rollback-step-outside", start)
}

// TestFinalizeMarksPlanDone checks that finalize of an applied plan that hides nothing, which has no finalize step,
// makes its history row done at once (docs/spec/plans.md "Finalize").
// Requirements: PLN-94.
func TestFinalizeMarksPlanDone(t *testing.T) {
	testcase.Start(t, testcase.Database)
	start := time.Now()
	t.Log("RUN apply/finalize-done deadline=20s")
	now := func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	plans := applyTestPlans(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn := applyTestConn(t)
	if err := Apply(ctx, conn, DialectSQLite, plans, now, nil); err != nil {
		t.Fatal(err)
	}
	var kinds []string
	events := func(ev ApplyEvent) error {
		kinds = append(kinds, ev.Kind)
		return nil
	}
	if err := Finalize(ctx, conn, DialectSQLite, plans, now, events); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := conn.QueryRowContext(ctx, `SELECT state FROM "dbspec$plans" WHERE name = ?`, plans[0].Name).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "done" {
		t.Errorf("history state after finalize = %q, want done", state)
	}
	if got := strings.Join(kinds, ","); got != "finalize,done" {
		t.Errorf("finalize events = %s, want finalize,done", got)
	}
	logResult(t, "apply/finalize-done", start)
}
