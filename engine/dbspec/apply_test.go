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

	"github.com/polyspec/orm/internal/testcase"
)

// failing은 실제 SQLite connection을 감싸서 정한 statement에 error를 주입하고,
// 정한 query를 다른 query로 바꾼다.
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
	t.Cleanup(func() { db.Close() })
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
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

// logResult는 case의 결과와 걸린 시간을 알린다.
func logResult(t *testing.T, name string, start time.Time) {
	t.Helper()
	result := "PASS"
	if t.Failed() {
		result = "FAIL"
	}
	t.Logf("%s %s elapsed=%s", result, name, time.Since(start))
}

// TestApplyReportsCleanupErrors는 apply가 실패한 뒤 정리(lock 해제, foreign key
// 복원)에서 난 error도 버리지 않고 함께 돌려주는지 확인한다.
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
	// 정리 error가 없으면 실패를 감싸지 않고 그대로 돌려준다.
	if err := Apply(ctx, applyTestConn(t), DialectSQLite, plans, now, stopAt); err != stop {
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

// TestEffectRequiresRow는 효과 query가 row를 돌려주지 않으면 효과가 없다고 읽지
// 않고 error로 보고하는지 확인한다.
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

// TestRollbackRejectsRecordedStepOutsidePlan은 applied row의 step이 plan의 step 밖이면 rollback이 step을 읽지 않고
// chain error로 멈추는지 확인한다(docs/plans.md "Apply").
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
