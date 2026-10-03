//go:build physical

package dialects

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/internal/testcase"
)

// planCaseText는 tests/dbspec/plans.json case의 source와 plan text다.
type planCaseText struct {
	Source []string `json:"source"`
	Plan   []string `json:"plan"`
}

func planCases(t *testing.T) map[string]planCaseText {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "dbspec", "plans.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			ID     string   `json:"id"`
			Source []string `json:"source"`
			Plan   []string `json:"plan"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	out := map[string]planCaseText{}
	for _, c := range vectors.Cases {
		out[c.ID] = planCaseText{Source: c.Source, Plan: c.Plan}
	}
	return out
}

func parsePlan(t *testing.T, text string) *dbspec.Plan {
	t.Helper()
	p, diagnostics := dbspec.ParsePlan(text)
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	return p
}

// applyChain은 tests/dbspec/plans.json의 create-from-empty와 그 target에서
// 시작하는 rename-table-and-column이다.
func applyChain(t *testing.T) []*dbspec.Plan {
	t.Helper()
	cases := planCases(t)
	plans := []*dbspec.Plan{
		parsePlan(t, strings.Join(cases["create-from-empty"].Plan, "\n")+"\n"),
		parsePlan(t, strings.Join(cases["rename-table-and-column"].Plan, "\n")+"\n"),
	}
	if plans[1].From != plans[0].To {
		t.Fatalf("plans.json does not chain create-from-empty and rename-table-and-column")
	}
	return plans
}

// caseChain은 case의 source를 만드는 첫 plan base와 case의 plan으로 된 chain이다.
func caseChain(t *testing.T, id string) []*dbspec.Plan {
	t.Helper()
	c := planCases(t)[id]
	base := parsePlan(t, "dbplan 1 base\nfrom empty\n\n"+strings.Join(c.Source, "\n")+"\n")
	plan := parsePlan(t, strings.Join(c.Plan, "\n")+"\n")
	if plan.From != base.To {
		t.Fatalf("the source of %s does not start its plan", id)
	}
	return []*dbspec.Plan{base, plan}
}

// planSteps는 chain에서 plan i의 step이다.
func planSteps(t *testing.T, plans []*dbspec.Plan, i int, db string) []dbspec.PlanStep {
	t.Helper()
	var source *dbspec.Document
	if i > 0 {
		source = plans[i-1].Schema
	}
	steps, diagnostics := dbspec.PlanSteps(source, plans[i], dbspec.Dialect(db))
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	return steps
}

// finalizeAt은 첫 finalize step의 index다.
func finalizeAt(steps []dbspec.PlanStep) int {
	for i, s := range steps {
		if s.Finalize {
			return i
		}
	}
	return len(steps)
}

// chainCounts는 dialect마다 chain plan의 step 수와 finalize 앞 step 수다.
type chainCounts map[string][][2]int

func countsOf(t *testing.T, plans []*dbspec.Plan) chainCounts {
	t.Helper()
	out := chainCounts{}
	for _, db := range []string{"mysql", "postgres", "sqlite"} {
		for i := range plans {
			steps := planSteps(t, plans, i, db)
			out[db] = append(out[db], [2]int{len(steps), finalizeAt(steps)})
		}
	}
	return out
}

var fixedNow = func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 123456789, time.UTC) }

// mysqlApplyLock와 postgresApplyLock은 docs/plans.md "Apply"의 lock 이름과 key다.
const (
	mysqlApplyLock    = "CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51))"
	postgresApplyLock = "hashtext('dbspec$plans'), hashtext(current_schema())"
)

// historyOf는 dialect에서 따옴표로 감싼 history table 이름이다.
func historyOf(db string) string {
	if db == "mysql" {
		return "`dbspec$plans`"
	}
	return `"dbspec$plans"`
}

// applyCode는 apply error의 code다. ApplyError가 아니면 빈 문자열이다.
func applyCode(err error) string {
	var a *dbspec.ApplyError
	if errors.As(err, &a) {
		return a.Code
	}
	return ""
}

type command func(ctx context.Context, c dbspec.Execer, dialect dbspec.Dialect, plans []*dbspec.Plan, now func() time.Time, events func(dbspec.ApplyEvent) error) error

// stopAfter는 plan의 step 번째 statement가 실행된 뒤, step을 기록하기 전에 명령을
// 멈추는 event handler다.
func stopAfter(plan string, step int, stop error) func(dbspec.ApplyEvent) error {
	return func(ev dbspec.ApplyEvent) error {
		if ev.Kind == "applied" && ev.Plan == plan && ev.Step == step {
			return stop
		}
		return nil
	}
}

// TestApplyChain은 docs/plans.md "Apply"를 세 database에서 확인한다: chain 적용과
// history, 다시 적용해도 그대로임, drift, lock, 아무것도 풀지 않은 unlock, 검증,
// representative plan의 모든 step 뒤 중단에서 recover와 rollback, 중단된 rollback의
// 계속, 그사이 쓴 row를 지키는 rollback과 다시 적용, null 검사, finalize.
func TestApplyChain(t *testing.T) {
	testcase.Group(t)
	// scenario는 lock과 session 설정을 server에서 확인하므로 pooler가 아니라 server DSN을 쓴다.
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_SERVER_DSN"), os.Getenv("ORM_TEST_POSTGRES_SERVER_DSN")
	if mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN are required; pass TEST_ENV")
	}
	plans := applyChain(t)
	target, _ := dbspec.ManifestOf([]*dbspec.Document{plans[1].Schema})
	planCounts := countsOf(t, plans)
	representative := caseChain(t, "representative")
	repSource, _ := dbspec.ManifestOf([]*dbspec.Document{representative[0].Schema})
	repTarget, _ := dbspec.ManifestOf([]*dbspec.Document{representative[1].Schema})
	repCounts := countsOf(t, representative)
	required := caseChain(t, "drop-required-column")
	requiredTarget, _ := dbspec.ManifestOf([]*dbspec.Document{required[1].Schema})
	requiredCounts := countsOf(t, required)
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
	// schemaIs는 introspect한 schema text가 want인지 확인한다.
	schemaIs := func(e *Env, db string, want string) {
		if e.Err != nil {
			return
		}
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
	// historyIs는 history row의 name, state, step이 want인지 확인한다.
	historyIs := func(e *Env, db, want string) {
		e.WantRows("SELECT name, state, step FROM "+historyOf(db)+" ORDER BY name", want)
	}
	// run은 명령을 실행하고 error code를 확인한다. code가 빈 문자열이면 성공해야 하며,
	// stop이면 그 error로 멈춰야 한다.
	run := func(e *Env, db, what string, f command, chain []*dbspec.Plan, events func(dbspec.ApplyEvent) error, code string, stop error) error {
		if e.Err != nil {
			return e.Err
		}
		err := f(e.Ctx, e.Conn, dbspec.Dialect(db), chain, fixedNow, events)
		switch {
		case stop != nil:
			if err != stop {
				e.fail("%s: %v, want the stop error", what, err)
			}
		case code == "" && err != nil:
			e.fail("%s: %v", what, err)
		case code != "" && applyCode(err) != code:
			e.fail("%s: %v, want %s", what, err, code)
		}
		return err
	}
	type scenario struct {
		name string
		dbs  []string
		run  func(e *Env, db string)
	}
	all := []string{"mysql", "postgres", "sqlite"}
	scenarios := []scenario{
		{"chain_history_and_again", all, func(e *Env, db string) {
			var events []string
			record := func(ev dbspec.ApplyEvent) error {
				events = append(events, ev.Kind)
				return nil
			}
			run(e, db, "apply", dbspec.Apply, plans, record, "", nil)
			schemaIs(e, db, target.SchemaText)
			c := planCounts[db]
			historyIs(e, db, fmt.Sprintf("create_from_empty|applied|%d,rename_table_and_column|applied|%d", c[0][1], c[1][1]))
			counts := map[string]int{}
			for _, k := range events {
				counts[k]++
			}
			e.Check(counts["plan"] == 2 && counts["verified"] == 2 && counts["done"] == 2 && counts["statement"] == counts["applied"] && counts["statement"] == c[0][1]+c[1][1], "events %v", counts)
			events = nil
			run(e, db, "apply again", dbspec.Apply, plans, record, "", nil)
			e.Check(len(events) == 0, "apply again: events %v", events)
		}},
		{"drift", all, func(e *Env, db string) {
			run(e, db, "apply", dbspec.Apply, plans[:1], nil, "", nil)
			e.Exec(`CREATE TABLE extra (id integer PRIMARY KEY)`)
			run(e, db, "apply after a change outside plans", dbspec.Apply, plans, nil, "drift", nil)
		}},
		{"lock", all, func(e *Env, db string) {
			other, err := e.Session()
			if err != nil {
				e.fail("session: %v", err)
				return
			}
			defer other.Conn.Close()
			hold := map[string]string{"mysql": "SELECT GET_LOCK(" + mysqlApplyLock + ", 0)", "postgres": "SELECT pg_advisory_lock(" + postgresApplyLock + ")", "sqlite": "BEGIN IMMEDIATE"}[db]
			if _, err := other.Conn.ExecContext(e.Ctx, hold); err != nil {
				e.fail("hold: %v", err)
				return
			}
			run(e, db, "apply under another session's lock", dbspec.Apply, plans, nil, "locked", nil)
			if db == "sqlite" {
				other.Conn.ExecContext(e.Ctx, "ROLLBACK")
			}
		}},
		{"other_database", all, func(e *Env, db string) {
			// 첫 database의 apply가 lock을 잡은 동안 두 번째 database, schema 또는 file에
			// 같은 chain을 적용한다. lock은 database 하나만 덮으므로 locked가 아니다.
			other, err := e.Second()
			if err != nil {
				e.fail("second %s: %v", db, err)
				return
			}
			defer other.Conn.Close()
			other.Exec(connectionRules[db]...)
			var otherErr error
			applied := false
			during := func(ev dbspec.ApplyEvent) error {
				if ev.Kind == "plan" && ev.Plan == plans[0].Name && !applied {
					applied = true
					otherErr = dbspec.Apply(other.Ctx, other.Conn, dbspec.Dialect(db), plans, fixedNow, nil)
				}
				return nil
			}
			run(e, db, "apply", dbspec.Apply, plans, during, "", nil)
			e.Check(applied && otherErr == nil, "apply to %s while %s applies: ran %v, error %v", other.Name, e.Name, applied, otherErr)
			schemaIs(e, db, target.SchemaText)
			schemaIs(other, db, target.SchemaText)
			if other.Err != nil {
				e.fail("%s: %v", other.Name, other.Err)
			}
		}},
		{"empty_chain", all, func(e *Env, db string) {
			// plan이 없는 chain은 table이 없는 database에 아무것도 적용하지 않는다.
			var events []string
			record := func(ev dbspec.ApplyEvent) error {
				events = append(events, ev.Kind)
				return nil
			}
			for _, c := range []struct {
				name string
				f    command
			}{{"apply", dbspec.Apply}, {"recover", dbspec.Recover}, {"rollback", dbspec.Rollback}, {"finalize", dbspec.Finalize}} {
				run(e, db, c.name+" of the empty chain", c.f, []*dbspec.Plan{}, record, "", nil)
			}
			e.Check(len(events) == 0, "events of the empty chain: %v", events)
			schemaIs(e, db, "")
			e.Want("SELECT COUNT(*) FROM "+historyOf(db), "0")
			e.Exec(`CREATE TABLE extra (id integer PRIMARY KEY)`)
			run(e, db, "apply of the empty chain to a database with a table", dbspec.Apply, []*dbspec.Plan{}, nil, "drift", nil)
		}},
		{"unlock_not_held", []string{"postgres"}, func(e *Env, db string) {
			// event에서 advisory lock을 먼저 풀면 명령 끝의 unlock은 아무것도 풀지 않는다.
			release := func(ev dbspec.ApplyEvent) error {
				if ev.Kind == "plan" && ev.Plan == plans[0].Name {
					_, err := e.Conn.ExecContext(e.Ctx, "SELECT pg_advisory_unlock("+postgresApplyLock+")")
					return err
				}
				return nil
			}
			want := "the advisory lock of dbspec$plans was not held at unlock"
			if err := dbspec.Apply(e.Ctx, e.Conn, dbspec.Dialect(db), plans, fixedNow, release); err == nil || err.Error() != want {
				e.fail("apply after the lock was released by another statement: %v, want %q", err, want)
			}
		}},
		{"verify_failure", all, func(e *Env, db string) {
			// 마지막 statement 뒤에 plan 밖의 table을 만들면 검증이 실패하고 row는 모든
			// step을 기록한 채 applying으로 남는다.
			n := planCounts[db][0][1]
			sneak := func(ev dbspec.ApplyEvent) error {
				if ev.Kind == "applied" && ev.Plan == plans[0].Name && ev.Step == n-1 {
					_, err := e.Conn.ExecContext(e.Ctx, `CREATE TABLE sneak (id integer PRIMARY KEY)`)
					return err
				}
				return nil
			}
			run(e, db, "apply with a table outside the plan", dbspec.Apply, plans, sneak, "verify", nil)
			historyIs(e, db, fmt.Sprintf("%s|applying|%d", plans[0].Name, n))
		}},
		{"rows_between", all, func(e *Env, db string) {
			// 적용한 plan에 쓴 row는 rollback 뒤에도 남고 지운 column의 값과 default가
			// 돌아오며, 다시 적용하면 더한 column의 값이 돌아온다. finalize 뒤 rollback은
			// 되돌릴 수 없다.
			chain, c := representative, repCounts[db]
			run(e, db, "apply base", dbspec.Apply, chain[:1], nil, "", nil)
			e.Exec("INSERT INTO users (mail, legacy_code, age, nick) VALUES ('a@x', 7, 3, 'n1')")
			run(e, db, "apply", dbspec.Apply, chain, nil, "", nil)
			e.Exec("INSERT INTO clients (email, age) VALUES ('b@x', 5)", "UPDATE clients SET status = 'vip' WHERE email = 'a@x'")
			run(e, db, "rollback", dbspec.Rollback, chain, nil, "", nil)
			schemaIs(e, db, repSource.SchemaText)
			historyIs(e, db, fmt.Sprintf("base|applied|%d", c[0][1]))
			e.WantRows("SELECT mail, legacy_code, nick FROM users ORDER BY mail", "a@x|7|n1,b@x|0|x")
			run(e, db, "apply again", dbspec.Apply, chain, nil, "", nil)
			schemaIs(e, db, repTarget.SchemaText)
			e.WantRows("SELECT email, status FROM clients ORDER BY email", "a@x|vip,b@x|new")
			historyIs(e, db, fmt.Sprintf("base|applied|%d,representative|applied|%d", c[0][1], c[1][1]))
			run(e, db, "finalize", dbspec.Finalize, chain, nil, "", nil)
			historyIs(e, db, fmt.Sprintf("base|done|%d,representative|done|%d", c[0][0], c[1][0]))
			e.Want(hiddenLeft[db]+" AND "+map[string]string{"mysql": "TABLE_NAME", "postgres": "c.relname", "sqlite": "m.name"}[db]+" <> 'dbspec$plans'", "0")
			schemaIs(e, db, repTarget.SchemaText)
			run(e, db, "rollback of a finalized plan", dbspec.Rollback, chain, nil, "irreversible", nil)
			schemaIs(e, db, repTarget.SchemaText)
		}},
		{"nulls", all, func(e *Env, db string) {
			// 숨긴 non-null default 없는 column에 그사이 NULL row가 생기면 rollback은 아무것도
			// 바꾸지 않고 row 수를 적은 nulls error로 멈춘다.
			chain, c := required, requiredCounts[db]
			run(e, db, "apply", dbspec.Apply, chain, nil, "", nil)
			e.Exec("INSERT INTO t (a) VALUES ('y')")
			err := run(e, db, "rollback with a NULL row", dbspec.Rollback, chain, nil, "nulls", nil)
			e.Check(err != nil && strings.Contains(err.Error(), "has 1 NULL rows"), "rollback with a NULL row: %v, want the count", err)
			schemaIs(e, db, requiredTarget.SchemaText)
			historyIs(e, db, fmt.Sprintf("base|applied|%d,drop_required_column|applied|%d", c[0][1], c[1][1]))
		}},
	}
	// representative plan의 step k마다: apply를 statement 뒤에 멈추고 rollback하고, 다시
	// 멈추고 recover하고, 적용한 plan의 rollback을 step k의 rollback statement 뒤에
	// 멈추고 rollback을 이어 간다.
	for _, db := range all {
		c := repCounts[db]
		baseRow := fmt.Sprintf("base|applied|%d", c[0][1])
		for k := 0; k < c[1][1]; k++ {
			scenarios = append(scenarios, scenario{fmt.Sprintf("interrupt_%02d", k), []string{db}, func(e *Env, db string) {
				stop := errors.New("stop")
				chain := representative
				name := chain[1].Name
				run(e, db, "apply base", dbspec.Apply, chain[:1], nil, "", nil)
				run(e, db, "apply stopped", dbspec.Apply, chain, stopAfter(name, k, stop), "", stop)
				historyIs(e, db, fmt.Sprintf("%s,representative|applying|%d", baseRow, k))
				run(e, db, "apply over an interrupted plan", dbspec.Apply, chain, nil, "interrupted", nil)
				run(e, db, "rollback of the interrupted plan", dbspec.Rollback, chain, nil, "", nil)
				schemaIs(e, db, repSource.SchemaText)
				historyIs(e, db, baseRow)
				run(e, db, "apply stopped again", dbspec.Apply, chain, stopAfter(name, k, stop), "", stop)
				run(e, db, "recover", dbspec.Recover, chain, nil, "", nil)
				schemaIs(e, db, repTarget.SchemaText)
				historyIs(e, db, fmt.Sprintf("%s,representative|applied|%d", baseRow, c[1][1]))
				run(e, db, "rollback stopped", dbspec.Rollback, chain, stopAfter(name, k, stop), "", stop)
				historyIs(e, db, fmt.Sprintf("%s,representative|rolling_back|%d", baseRow, k+1))
				run(e, db, "rollback continued", dbspec.Rollback, chain, nil, "", nil)
				schemaIs(e, db, repSource.SchemaText)
				historyIs(e, db, baseRow)
			}})
		}
	}
	index := 0
	for _, s := range scenarios {
		for _, db := range s.dbs {
			index++
			probe := Probe{ID: db + ".apply." + s.name, DB: db, Fact: "apply " + s.name, Run: func(e *Env) {
				e.Exec(connectionRules[db]...)
				s.run(e, db)
			}}
			t.Run(probe.ID, func(t *testing.T) { runProbeCase(t, servers, probe, index, "") })
		}
	}
	t.Logf("apply runs: %d", index)
}

// TestApplyThroughTransactionPooler는 docs/plans.md "Apply"의 server session 요구를 PgBouncer의
// transaction pooling으로 확인한다. transaction pooler는 statement마다 server connection을 다시
// 고르므로 lock이 command 전체를 덮지 못한다. apply는 lock을 잡을 때와 step마다 server session을
// 확인하고, 바뀌었거나 다른 client와 나눠 쓰면 다음 statement 전에 session error로 멈춘다.
// 각 scenario는 server에 자기 database를 만들고 PgBouncer로 그 database에 연결한다. PgBouncer는
// 쉬는 server connection을 LIFO로 다시 쓰므로(server_round_robin = 0) 아래 순서가 정해진다.
func TestApplyThroughTransactionPooler(t *testing.T) {
	testcase.Group(t)
	serverDSN, poolerDSN := os.Getenv("ORM_TEST_POSTGRES_SERVER_DSN"), os.Getenv("ORM_TEST_PGBOUNCER_DSN")
	if serverDSN == "" || poolerDSN == "" {
		t.Fatal("ORM_TEST_POSTGRES_SERVER_DSN and ORM_TEST_PGBOUNCER_DSN are required; pass TEST_ENV")
	}
	plans := applyChain(t)
	scenarios := []struct {
		name string
		run  func(ctx context.Context, apply, other *sql.Conn) error
	}{
		// 다른 client가 session advisory lock을 잡은 server connection을 apply가 이어받는다.
		{"lock_shared", func(ctx context.Context, apply, other *sql.Conn) error {
			if _, err := other.ExecContext(ctx, "SELECT pg_advisory_lock("+postgresApplyLock+")"); err != nil {
				return err
			}
			return dbspec.Apply(ctx, apply, dbspec.DialectPostgres, plans, fixedNow, nil)
		}},
		// 첫 step 앞에서 다른 client가 transaction으로 apply의 server connection을 잡으므로 apply의
		// 다음 statement는 다른 server connection에서 실행된다.
		{"session_changed", func(ctx context.Context, apply, other *sql.Conn) error {
			var tx *sql.Tx
			defer func() {
				if tx != nil {
					tx.Rollback()
				}
			}()
			hold := func(ev dbspec.ApplyEvent) error {
				if ev.Kind != "statement" || tx != nil {
					return nil
				}
				var err error
				if tx, err = other.BeginTx(ctx, nil); err != nil {
					return err
				}
				_, err = tx.ExecContext(ctx, "SELECT 1")
				return err
			}
			return dbspec.Apply(ctx, apply, dbspec.DialectPostgres, plans, fixedNow, hold)
		}},
	}
	for _, s := range scenarios {
		t.Run(s.name, func(t *testing.T) {
			testcase.Start(t, testcase.Database)
			ctx, cancel := context.WithTimeout(context.Background(), testcase.Database)
			defer cancel()
			name := fmt.Sprintf("orm_case_%d_pooler_%s", os.Getpid(), s.name)
			admin, err := sql.Open("pgx", serverDSN)
			if err != nil {
				t.Fatal(err)
			}
			defer admin.Close()
			if _, err := admin.ExecContext(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := admin.ExecContext(context.Background(), `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
					t.Error(err)
				}
			}()
			pooler, err := sql.Open("pgx", retargetPostgres(t, poolerDSN, name))
			if err != nil {
				t.Fatal(err)
			}
			defer pooler.Close()
			apply, err := pooler.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer apply.Close()
			other, err := pooler.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer other.Close()
			err = s.run(ctx, apply, other)
			var applyErr *dbspec.ApplyError
			if !errors.As(err, &applyErr) || applyErr.Code != "session" || !strings.Contains(applyErr.Message, "a direct or session-pooled connection") {
				t.Fatalf("apply through a transaction pooler: %v, want a session error", err)
			}
		})
	}
}

// retargetPostgres는 PostgreSQL DSN의 database를 name으로 바꾸고 simple protocol을 쓰게 한다.
// pooler 뒤의 server connection은 statement마다 바뀔 수 있으므로 prepared statement를 쓰지 않는다.
func retargetPostgres(t *testing.T, dsn, name string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	query := u.Query()
	query.Set("default_query_exec_mode", "simple_protocol")
	u.RawQuery = query.Encode()
	return u.String()
}
