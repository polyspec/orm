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
	conn          *sql.Conn
	fail          map[string]error
	queryFail     map[string]error
	queryFailCall map[string]int
	queryCalls    map[string]int
	replace       map[string]string
}

func (f *failing) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	if err, ok := f.fail[query]; ok {
		return nil, err
	}
	return f.conn.ExecContext(ctx, query, args...)
}

func (f *failing) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	if err, ok := f.queryFail[query]; ok {
		if f.queryCalls == nil {
			f.queryCalls = map[string]int{}
		}
		f.queryCalls[query]++
		if call := f.queryFailCall[query]; call == 0 || call == f.queryCalls[query] {
			return nil, err
		}
	}
	if q, ok := f.replace[query]; ok {
		return f.conn.QueryContext(ctx, q)
	}
	return f.conn.QueryContext(ctx, query, args...)
}

// Requirements: PLN-92, PLN-93, PLN-96.
// TestSettledVerifyPreservesIntrospectionErrors distinguishes a catalog read failure from real schema drift.
func TestSettledVerifyPreservesIntrospectionErrors(t *testing.T) {
	testcase.Start(t, testcase.Database)
	start := time.Now()
	t.Log("RUN apply/settled-introspection-error deadline=20s")
	now, plans, ctx := applyTestSetup(t)
	sentinel := errors.New("catalog read failed")
	c := &failing{conn: applyTestConn(t), queryFail: map[string]error{sqliteMasterQuery: sentinel}}
	result, err := Apply(ctx, c, DialectSQLite, plans, now, nil)
	if err != nil || result.Failure == nil || result.Failure.Code != "verify" || !errors.Is(result.Failure, sentinel) {
		t.Errorf("apply with a catalog read failure: result=%+v error=%v, want verify preserving the original error", result, err)
	}

	conn := applyTestConn(t)
	if _, err := conn.ExecContext(ctx, `CREATE TABLE unrelated (id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	result, err = Apply(ctx, conn, DialectSQLite, plans, now, nil)
	if err != nil || result.Failure == nil || result.Failure.Code != "drift" {
		t.Errorf("apply with a real schema mismatch: result=%+v error=%v, want drift", result, err)
	}

	rollbackConn := applyTestConn(t)
	applyOK(t, ctx, rollbackConn, plans, now)
	rollbackCause := errors.New("rollback catalog read failed")
	rollbackFailing := &failing{conn: rollbackConn, queryFail: map[string]error{sqliteMasterQuery: rollbackCause}}
	err = Rollback(ctx, rollbackFailing, DialectSQLite, plans, now, nil)
	applyErr := (*ApplyError)(nil)
	if !errors.As(err, &applyErr) || applyErr.Code != "verify" || !errors.Is(err, rollbackCause) {
		t.Errorf("rollback with a catalog read failure: %v, want verify preserving the original error", err)
	}

	driftConn := applyTestConn(t)
	applyOK(t, ctx, driftConn, plans, now)
	if _, err := driftConn.ExecContext(ctx, `CREATE TABLE unrelated (id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	err = Rollback(ctx, driftConn, DialectSQLite, plans, now, nil)
	if !errors.As(err, &applyErr) || applyErr.Code != "drift" {
		t.Errorf("rollback with a real schema mismatch: %v, want drift", err)
	}

	postForwardConn := &failing{
		conn:          applyTestConn(t),
		queryFail:     map[string]error{sqliteMasterQuery: sentinel},
		queryFailCall: map[string]int{sqliteMasterQuery: 2},
	}
	var kinds []string
	result, err = Apply(ctx, postForwardConn, DialectSQLite, plans, now, func(event ApplyEvent) error {
		kinds = append(kinds, event.Kind)
		return nil
	})
	if err != nil || result.Failure == nil || result.Failure.Code != "verify" || !errors.Is(result.Failure, sentinel) {
		t.Errorf("apply with a post-forward catalog read failure: result=%+v error=%v, want verify preserving the original error", result, err)
	}
	var state string
	if err := postForwardConn.conn.QueryRowContext(ctx, `SELECT state FROM "dbspec$plans"`).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != stateApplying || strings.Contains(strings.Join(kinds, ","), "verified") || strings.Contains(strings.Join(kinds, ","), "done") {
		t.Errorf("post-forward verification failure reports success: history state=%q events=%s", state, strings.Join(kinds, ","))
	}
	logResult(t, "apply/settled-introspection-error", start)
}

func applyTestConn(t *testing.T) *sql.Conn {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "apply.db"))
	if err != nil {
		t.Fatal(err)
	}
	return testSQLConn(t, db)
}

func testSQLConn(t *testing.T, db *sql.DB) *sql.Conn {
	t.Helper()
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

// TestApplyReportsCleanupErrors checks that apply preserves the primary failure and all cleanup errors in order in Go's native error chain.
// Requirements: PLN-97, PLN-106.
func TestApplyReportsCleanupErrors(t *testing.T) {
	testcase.Start(t, testcase.Database)
	start := time.Now()
	t.Log("RUN apply/cleanup-errors deadline=20s")
	now, plans, ctx := applyTestSetup(t)

	stop := errors.New("stop")
	stopAt := stopAfterApplied(stop)
	// Without a cleanup error, it returns the failure unwrapped.
	if res, err := Apply(ctx, applyTestConn(t), DialectSQLite, plans, now, stopAt); err != nil || !res.Stopped || !errors.Is(res.Stop, stop) {
		t.Errorf("apply stopped by an event without a cleanup error: %+v, %v, want stopped by the event error", res, err)
	}

	release := errors.New("release failed")
	restore := errors.New("restore failed")
	c := &failing{conn: applyTestConn(t), fail: map[string]error{"PRAGMA foreign_keys = 0": restore, "PRAGMA locking_mode = normal": release}}
	_, err := Apply(ctx, c, DialectSQLite, plans, now, stopAt)
	if !errors.Is(err, stop) || !errors.Is(err, restore) || !errors.Is(err, release) {
		t.Errorf("apply stopped by an event with failing cleanup: %v, want all three errors", err)
	}
	if want := stop.Error() + "\n" + restore.Error() + "\n" + release.Error(); err == nil || err.Error() != want {
		t.Errorf("apply cleanup error order: %v, want %q", err, want)
	}

	begin := sqliteResultError(5)
	restore = errors.New("restore failed")
	c = &failing{conn: applyTestConn(t), fail: map[string]error{"BEGIN EXCLUSIVE": begin, "PRAGMA foreign_keys = 0": restore}}
	_, err = Apply(ctx, c, DialectSQLite, plans, now, nil)
	if applyErr := (*ApplyError)(nil); !errors.As(err, &applyErr) || applyErr.Code != "locked" || !errors.Is(err, restore) {
		t.Errorf("apply with a failing BEGIN EXCLUSIVE and foreign key restore: %v, want locked and the restore error", err)
	}
	logResult(t, "apply/cleanup-errors", start)
}

// TestApplyStopWithCleanupFailureReturnsJoin checks that when an event stops apply and a cleanup step then fails,
// the result is the joined error of the stop and the cleanup failure, not a stop by itself.
// Requirements: PLN-97.
func TestApplyStopWithCleanupFailureReturnsJoin(t *testing.T) {
	testcase.Start(t, testcase.Database)
	start := time.Now()
	t.Log("RUN apply/stop-join deadline=20s")
	now, plans, ctx := applyTestSetup(t)

	stop := errors.New("stop")
	stopAt := stopAfterApplied(stop)
	release := errors.New("release failed")
	c := &failing{conn: applyTestConn(t), fail: map[string]error{"PRAGMA locking_mode = normal": release}}
	_, err := Apply(ctx, c, DialectSQLite, plans, now, stopAt)
	if want := stop.Error() + "\n" + release.Error(); err == nil || err.Error() != want {
		t.Errorf("apply stopped by an event with a failing lock release: %v, want %q", err, want)
	}
	logResult(t, "apply/stop-join", start)
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
	now, plans, ctx := applyTestSetup(t)
	conn := applyTestConn(t)
	applyOK(t, ctx, conn, plans, now)
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
	now, plans, ctx := applyTestSetup(t)
	conn := applyTestConn(t)
	applyOK(t, ctx, conn, plans, now)
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

// applyTestSetup returns the clock, the plans, and a context of 20 seconds for an
// apply test; the context is cancelled when the test ends.
func applyTestSetup(t *testing.T) (func() time.Time, []*Plan, context.Context) {
	t.Helper()
	now := func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	plans := applyTestPlans(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return now, plans, ctx
}

// stopAfterApplied returns the event hook that stops apply with stop once the
// plan is applied.
func stopAfterApplied(stop error) func(ApplyEvent) error {
	return func(ev ApplyEvent) error {
		if ev.Kind == "applied" {
			return stop
		}
		return nil
	}
}

// applyOK applies the plans to c with the clock now, and fails the test when
// apply fails.
func applyOK(t *testing.T, ctx context.Context, c Execer, plans []*Plan, now func() time.Time) {
	t.Helper()
	if _, err := Apply(ctx, c, DialectSQLite, plans, now, nil); err != nil {
		t.Fatal(err)
	}
}
