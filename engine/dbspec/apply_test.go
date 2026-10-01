package dbspec

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
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
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "dbspec", "plans.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Cases []struct {
			ID   string   `json:"id"`
			Plan []string `json:"plan"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
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

// TestApplyReportsCleanupErrors는 apply가 실패한 뒤 정리(ROLLBACK, foreign key
// 복원)에서 난 error도 버리지 않고 함께 돌려주는지 확인한다.
func TestApplyReportsCleanupErrors(t *testing.T) {
	start := time.Now()
	t.Log("RUN apply/cleanup-errors deadline=5s")
	now := func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	plans := applyTestPlans(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stop := errors.New("stop")
	rollback := errors.New("rollback failed")
	c := &failing{conn: applyTestConn(t), fail: map[string]error{"ROLLBACK": rollback}}
	err := Apply(ctx, c, DialectSQLite, plans, now, func(ev ApplyEvent) error {
		if ev.Kind == "applied" {
			return stop
		}
		return nil
	})
	if !errors.Is(err, stop) || !errors.Is(err, rollback) {
		t.Errorf("apply stopped by an event with a failing ROLLBACK: %v, want both errors", err)
	}

	begin := errors.New("begin failed")
	restore := errors.New("restore failed")
	c = &failing{conn: applyTestConn(t), fail: map[string]error{"BEGIN IMMEDIATE": begin, "PRAGMA foreign_keys = ON": restore}}
	err = Apply(ctx, c, DialectSQLite, plans, now, nil)
	if applyErr := (*ApplyError)(nil); !errors.As(err, &applyErr) || applyErr.Code != "locked" || !errors.Is(err, restore) {
		t.Errorf("apply with a failing BEGIN IMMEDIATE and foreign key restore: %v, want locked and the restore error", err)
	}
	t.Logf("PASS apply/cleanup-errors elapsed=%s", time.Since(start))
}

// TestMySQLEffectRequiresRow는 catalog 확인 query가 row를 돌려주지 않으면 효과가
// 없다고 읽지 않고 error로 보고하는지 확인한다.
func TestMySQLEffectRequiresRow(t *testing.T) {
	start := time.Now()
	t.Log("RUN apply/mysql-effect-row deadline=5s")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	query := "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?"
	c := &failing{conn: applyTestConn(t), replace: map[string]string{query: "SELECT 1 WHERE 0"}}
	a := &applier{ctx: ctx, c: c, r: renderer{d: DialectMySQL}}
	if _, err := a.mysqlEffect("CREATE TABLE `orders` (`id` BIGINT NOT NULL)"); err == nil {
		t.Error("mysqlEffect with a catalog query that returns no row: no error")
	}
	t.Logf("PASS apply/mysql-effect-row elapsed=%s", time.Since(start))
}
