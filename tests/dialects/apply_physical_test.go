//go:build physical

package dialects

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/engine/dbspec"
)

// applyChain은 tests/dbspec/plans.json의 create-from-empty와 그 target에서
// 시작하는 rename-table-and-column이다.
func applyChain(t *testing.T) []*dbspec.Plan {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "dbspec", "plans.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			ID   string   `json:"id"`
			Plan []string `json:"plan"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	var plans []*dbspec.Plan
	for _, c := range vectors.Cases {
		if c.ID != "create-from-empty" && c.ID != "rename-table-and-column" {
			continue
		}
		p, diagnostics := dbspec.ParsePlan(strings.Join(c.Plan, "\n") + "\n")
		if len(diagnostics) > 0 {
			t.Fatal(diagnostics)
		}
		plans = append(plans, p)
	}
	if len(plans) != 2 || plans[1].From != plans[0].To {
		t.Fatalf("plans.json does not chain create-from-empty and rename-table-and-column")
	}
	return plans
}

var fixedNow = func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }

// applyCode는 apply error의 code다. ApplyError가 아니면 빈 문자열이다.
func applyCode(err error) string {
	var a *dbspec.ApplyError
	if errors.As(err, &a) {
		return a.Code
	}
	return ""
}

// TestApplyChain은 docs/plans.md "Apply"를 세 database에서 확인한다: chain
// 적용과 history, 다시 적용해도 그대로임, drift, lock, 중간 실패, PostgreSQL에서
// 아무것도 풀지 않은 unlock, 그리고 MySQL의 recovery.
func TestApplyChain(t *testing.T) {
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV")
	}
	plans := applyChain(t)
	target, _ := dbspec.ManifestOf([]*dbspec.Document{plans[1].Schema})
	connect, cancel := context.WithTimeout(context.Background(), probeDeadline)
	servers, err := OpenServers(connect, mysqlDSN, postgresDSN, t.TempDir(), "apply"+strconv.Itoa(os.Getpid()))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := servers.Close(); err != nil {
			t.Error(err)
		}
	})
	// schemaIs는 introspect한 schema text가 target인지 확인한다.
	schemaIs := func(e *Env, db string, want string) {
		document, unsupported, err := dbspec.Introspect(e.Ctx, e.Conn, dbspec.Dialect(db), "x")
		if err != nil || len(unsupported) > 0 {
			e.fail("introspect: %v %+v", err, unsupported)
			return
		}
		got := ""
		if len(document.Tables) > 0 {
			m, _ := dbspec.ManifestOf([]*dbspec.Document{document})
			got = m.SchemaText
		}
		if got != want {
			e.fail("schema text\n--- want\n%s--- got\n%s", want, got)
		}
	}
	type scenario struct {
		name string
		dbs  []string
		run  func(e *Env, db string)
	}
	scenarios := []scenario{
		{"chain_history_and_again", []string{"mysql", "postgres", "sqlite"}, func(e *Env, db string) {
			var events []string
			record := func(ev dbspec.ApplyEvent) error {
				events = append(events, ev.Kind)
				return nil
			}
			if err := dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, record); err != nil {
				e.fail("apply: %v", err)
				return
			}
			schemaIs(e, db, target.SchemaText)
			history := map[string]string{"mysql": "`dbspec$plans`"}[db]
			if history == "" {
				history = `"dbspec$plans"`
			}
			e.Want("SELECT COUNT(*) FROM "+history+" WHERE state = 'done'", "2")
			counts := map[string]int{}
			for _, k := range events {
				counts[k]++
			}
			if counts["plan"] != 2 || counts["verified"] != 2 || counts["done"] != 2 || counts["statement"] != counts["applied"] || counts["statement"] == 0 {
				e.fail("events %v", counts)
			}
			events = nil
			if err := dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, record); err != nil || len(events) != 0 {
				e.fail("apply again: %v, events %v", err, events)
			}
		}},
		{"drift", []string{"mysql", "postgres", "sqlite"}, func(e *Env, db string) {
			if err := dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans[:1], fixedNow, nil); err != nil {
				e.fail("apply: %v", err)
				return
			}
			e.Exec(`CREATE TABLE extra (id integer PRIMARY KEY)`)
			if code := applyCode(dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, nil)); code != "drift" {
				e.fail("apply after a change outside plans: code %q, want drift", code)
			}
		}},
		{"lock", []string{"mysql", "postgres", "sqlite"}, func(e *Env, db string) {
			other, err := e.Session()
			if err != nil {
				e.fail("session: %v", err)
				return
			}
			defer other.Conn.Close()
			hold := map[string]string{"mysql": "SELECT GET_LOCK('dbspec$plans', 0)", "postgres": "SELECT pg_advisory_lock(hashtext('dbspec$plans'))", "sqlite": "BEGIN IMMEDIATE"}[db]
			if _, err := other.Conn.ExecContext(e.Ctx, hold); err != nil {
				e.fail("hold: %v", err)
				return
			}
			if code := applyCode(dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, nil)); code != "locked" {
				e.fail("apply under another session's lock: code %q, want locked", code)
			}
			if db == "sqlite" {
				other.Conn.ExecContext(e.Ctx, "ROLLBACK")
			}
		}},
		{"rollback_on_failure", []string{"postgres", "sqlite"}, func(e *Env, db string) {
			stop := errors.New("stop")
			fail := func(ev dbspec.ApplyEvent) error {
				if ev.Kind == "applied" && ev.Step == 1 {
					return stop
				}
				return nil
			}
			if err := dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, fail); !errors.Is(err, stop) {
				e.fail("apply stopped by an event: %v", err)
				return
			}
			schemaIs(e, db, "")
			if err := dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, nil); err != nil {
				e.fail("apply after the rollback: %v", err)
				return
			}
			schemaIs(e, db, target.SchemaText)
		}},
		{"unlock_not_held", []string{"postgres"}, func(e *Env, db string) {
			// event에서 advisory lock을 먼저 풀면 apply 끝의 unlock은 아무것도 풀지 않는다.
			release := func(ev dbspec.ApplyEvent) error {
				if ev.Kind == "plan" && ev.Plan == plans[0].Name {
					_, err := e.Conn.ExecContext(e.Ctx, "SELECT pg_advisory_unlock(hashtext('dbspec$plans'))")
					return err
				}
				return nil
			}
			want := "the advisory lock of dbspec$plans was not held at unlock"
			if err := dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, release); err == nil || err.Error() != want {
				e.fail("apply after the lock was released by another statement: %v, want %q", err, want)
			}
		}},
		{"verify_failure", []string{"mysql", "postgres", "sqlite"}, func(e *Env, db string) {
			// 마지막 statement 뒤에 plan 밖의 table을 만들면 검증이 실패한다.
			sneak := func(ev dbspec.ApplyEvent) error {
				if ev.Kind == "applied" && ev.Plan == plans[0].Name && ev.Step == ev.Steps-1 {
					_, err := e.Conn.ExecContext(e.Ctx, `CREATE TABLE sneak (id integer PRIMARY KEY)`)
					return err
				}
				return nil
			}
			if code := applyCode(dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, sneak)); code != "verify" {
				e.fail("apply with a table outside the plan: code %q, want verify", code)
			}
			if db == "mysql" {
				e.Want("SELECT state FROM `dbspec$plans`", "running")
			} else {
				schemaIs(e, db, "")
			}
		}},
	}
	// MySQL recovery: statement이 commit된 뒤 기록 전에 멈춘 경우와 실행 전에 멈춘 경우.
	for _, kind := range []string{"applied", "statement"} {
		scenarios = append(scenarios, scenario{"recover_after_" + kind, []string{"mysql"}, func(e *Env, db string) {
			stop := errors.New("stop")
			fail := func(ev dbspec.ApplyEvent) error {
				if ev.Kind == kind && ev.Plan == plans[1].Name && ev.Step == 1 {
					return stop
				}
				return nil
			}
			if err := dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, fail); !errors.Is(err, stop) {
				e.fail("apply stopped by an event: %v", err)
				return
			}
			e.Want("SELECT CONCAT(state, ' ', step) FROM `dbspec$plans` WHERE name = '"+plans[1].Name+"'", "running 1")
			if code := applyCode(dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, nil)); code != "interrupted" {
				e.fail("apply over a running plan: code %q, want interrupted", code)
				return
			}
			if err := dbspec.Recover(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, nil); err != nil {
				e.fail("recover: %v", err)
				return
			}
			schemaIs(e, db, target.SchemaText)
			e.Want("SELECT COUNT(*) FROM `dbspec$plans` WHERE state = 'done'", "2")
			if err := dbspec.Recover(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, nil); err != nil {
				e.fail("recover again: %v", err)
			}
		}})
	}
	index := 0
	for _, s := range scenarios {
		for _, db := range s.dbs {
			index++
			probe := Probe{ID: db + ".apply." + s.name, DB: db, Fact: "apply " + s.name, Run: func(e *Env) {
				e.Exec(connectionRules[db]...)
				s.run(e, db)
			}}
			t.Run(probe.ID, func(t *testing.T) {
				begin := time.Now()
				t.Logf("start %s", probe.ID)
				_, err := runWithDeadline(servers, probe, index)
				elapsed := time.Since(begin).Round(time.Millisecond)
				if err != nil {
					t.Errorf("result %s: FAIL after %s: %v", probe.ID, elapsed, err)
					return
				}
				t.Logf("result %s: PASS after %s", probe.ID, elapsed)
			})
		}
	}
}
