//go:build physical

package dialects

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/internal/testcase"
)

// runnerDeadline은 apply runner process 하나의 기한이다.
const runnerDeadline = 2 * time.Minute

// pairDeadline은 순서쌍 case 하나의 기한이다. 한 case는 runner process를 많아야 세 번
// (stop, apply, recover) 실행하고, database를 만들고 history와 schema를 읽고 지우는 데
// 1분을 더 준다.
const pairDeadline = 3*runnerDeadline + time.Minute

// applyClients는 tests/dbspec/apply의 runner를 가진 client다.
var applyClients = []string{"go", "php", "typescript", "rust"}

// TestApplyChainAcrossClients는 한 client가 적용한 chain을 다른 client가 이어
// 적용하는지 모든 순서쌍에서 확인한다(docs/plans.md "Apply"). 세 database에서
// client A가 tests/dbspec/plans.json chain의 첫 plan을, client B가 나머지를 적용한
// 뒤 history row와 introspect한 schema text가 기대와 같아야 한다. A가 둘째 plan
// 중간에 멈춘 apply를 B가 interrupted로 거부하고 recover로 끝내야 하며, 다시 멈춘
// apply를 B가 rollback으로 되돌려야 한다.
func TestApplyChainAcrossClients(t *testing.T) {
	testcase.Group(t)
	rustRunner := os.Getenv("DBSPEC_APPLY_RUST")
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if rustRunner == "" || mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("DBSPEC_APPLY_RUST, ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; run make dbspec-apply-pairs-check")
	}
	// make는 CARGO_TARGET_DIR 아래의 절대 경로를 준다.
	if !filepath.IsAbs(rustRunner) {
		t.Fatalf("DBSPEC_APPLY_RUST %q must be an absolute path under CARGO_TARGET_DIR", rustRunner)
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	plans := applyChain(t)
	target, diagnostics := dbspec.ManifestOf([]*dbspec.Document{plans[1].Schema})
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	vectors := filepath.Join(root, "tests", "dbspec", "plans.json")
	goRunner := filepath.Join(t.TempDir(), "apply-go")
	// Go runner build는 testcase.Process 기한을 가진다(build cache가 비면 몇 분 걸린다).
	building, cancelBuild := context.WithTimeout(context.Background(), testcase.Process)
	build := exec.CommandContext(building, "go", "build", "-o", goRunner, "./tests/dbspec/apply/go")
	build.Dir = root
	out, err := build.CombinedOutput()
	cancelBuild()
	if err != nil {
		t.Fatalf("build the Go apply runner: %v\n%s", err, out)
	}
	runners := map[string][]string{
		"go":         {goRunner},
		"php":        {"php", "tests/dbspec/apply/php.php"},
		"typescript": {"node", "tests/dbspec/apply/typescript.mjs"},
		"rust":       {rustRunner},
	}
	// 동시에 도는 다른 test run과 겹치지 않도록 database 이름에 pid와 random 값을 넣는다.
	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	token := strconv.Itoa(os.Getpid()) + "_" + hex.EncodeToString(random)

	// step은 client의 runner로 action을 실행하고 결과 줄이 want인지 확인한다.
	step := func(t *testing.T, c *testcase.Case, client, action, dialect, uri, want string) {
		t.Helper()
		begin := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), runnerDeadline)
		defer cancel()
		args := runners[client]
		cmd := exec.CommandContext(ctx, args[0], append(args[1:], action, dialect, uri, vectors)...)
		cmd.Dir = root
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		elapsed := time.Since(begin).Round(time.Millisecond)
		if err != nil {
			t.Fatalf("%s %s: %v after %s\n%s", client, action, err, elapsed, stderr.String())
		}
		if got := strings.TrimSuffix(stdout.String(), "\n"); got != want {
			t.Fatalf("%s %s: %q after %s, want %q\n%s", client, action, got, elapsed, want, stderr.String())
		}
		c.Step("%s %s: %s after %s", client, action, want, elapsed)
	}
	runs := 0
	pair := func(id, dialect string, body func(t *testing.T, c *testcase.Case, uri string)) {
		runs++
		name := fmt.Sprintf("dbspec_pair_%s_%02d", token, runs)
		t.Run(id, func(t *testing.T) {
			c := testcase.Start(t, pairDeadline)
			c.Step("database %s", name)
			uri, cleanup := compareDatabase(t, dialect, name, mysqlDSN, postgresDSN)
			defer cleanup()
			if dialect == "sqlite" {
				// sqlx는 없는 SQLite file을 만들지 않으므로 빈 database file을 먼저 만든다.
				if err := os.WriteFile(strings.TrimPrefix(uri, "sqlite://"), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			body(t, c, uri)
		})
	}
	for _, dialect := range []string{"mysql", "postgres", "sqlite"} {
		want := chainHistory(t, plans, dialect, "")
		for _, a := range applyClients {
			for _, b := range applyClients {
				if a == b {
					continue
				}
				pair(dialect+".chain."+a+"-"+b, dialect, func(t *testing.T, c *testcase.Case, uri string) {
					step(t, c, a, "apply-first", dialect, uri, "ok")
					step(t, c, b, "apply", dialect, uri, "ok")
					checkChainState(t, dialect, uri, want, target.SchemaText)
				})
			}
		}
	}
	// 세 database에서 A가 둘째 plan의 statement 1을 실행한 뒤 멈추고, B가 그것을 이어
	// 끝내거나 되돌린다.
	for _, dialect := range []string{"mysql", "postgres", "sqlite"} {
		want := chainHistory(t, plans, dialect, "")
		running := chainHistory(t, plans, dialect, "applying 1")
		first := chainHistory(t, plans[:1], dialect, "")
		firstTarget, _ := dbspec.ManifestOf([]*dbspec.Document{plans[0].Schema})
		for _, a := range applyClients {
			for _, b := range applyClients {
				if a == b {
					continue
				}
				pair(dialect+".recover."+a+"-"+b, dialect, func(t *testing.T, c *testcase.Case, uri string) {
					step(t, c, a, "stop", dialect, uri, "stopped")
					checkHistory(t, dialect, uri, running)
					step(t, c, b, "apply", dialect, uri, "error interrupted")
					step(t, c, b, "recover", dialect, uri, "ok")
					checkChainState(t, dialect, uri, want, target.SchemaText)
				})
				pair(dialect+".rollback."+a+"-"+b, dialect, func(t *testing.T, c *testcase.Case, uri string) {
					step(t, c, a, "stop", dialect, uri, "stopped")
					checkHistory(t, dialect, uri, running)
					step(t, c, b, "rollback", dialect, uri, "ok")
					checkChainState(t, dialect, uri, first, firstTarget.SchemaText)
				})
			}
		}
	}
	if runs != 108 {
		t.Errorf("ran %d pairs, want 12 pairs of chain, recover and rollback on three databases", runs)
	}
	t.Logf("pairs: %d", runs)
}

// chainHistory는 chain을 끝까지 적용한 dialect database의 history row다. 각 row는
// finalize 앞의 step까지 applied다. last가 "<state> <step>"이면 마지막 plan의 row가
// 그 state와 step이다.
func chainHistory(t *testing.T, plans []*dbspec.Plan, dialect, last string) []string {
	t.Helper()
	var rows []string
	var source *dbspec.Document
	for i, p := range plans {
		steps, diagnostics := dbspec.PlanSteps(source, p, dbspec.Dialect(dialect))
		if len(diagnostics) > 0 {
			t.Fatal(diagnostics)
		}
		applied := len(steps)
		for k, s := range steps {
			if s.Finalize {
				applied = k
				break
			}
		}
		from := p.From
		if from == "" {
			from = "empty"
		}
		state, step := "applied", strconv.Itoa(applied)
		if i == len(plans)-1 && last != "" {
			state, step, _ = strings.Cut(last, " ")
		}
		rows = append(rows, strings.Join([]string{p.Name, from, p.To, state, step, strconv.Itoa(len(steps)), "2026-10-01T00:00:00.123456Z"}, "|"))
		source = p.Schema
	}
	return rows
}

// checkHistory는 uri의 history row가 want인지 확인한다.
func checkHistory(t *testing.T, dialect, uri string, want []string) {
	t.Helper()
	db := openURI(t, dialect, uri)
	defer db.Close()
	q := `"`
	if dialect == "mysql" {
		q = "`"
	}
	rows, err := db.Query("SELECT name, from_hash, to_hash, state, step, steps, applied_at FROM " + q + "dbspec$plans" + q + " ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		v := make([]string, 7)
		if err := rows.Scan(&v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6]); err != nil {
			t.Fatal(err)
		}
		got = append(got, strings.Join(v, "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("history rows\n--- want\n%s\n--- got\n%s", strings.Join(want, "\n"), strings.Join(got, "\n"))
	}
}

// checkChainState는 history row가 want이고 introspect한 schema text가 target인지 확인한다.
func checkChainState(t *testing.T, dialect, uri string, want []string, target string) {
	t.Helper()
	checkHistory(t, dialect, uri, want)
	db := openURI(t, dialect, uri)
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), runnerDeadline)
	defer cancel()
	document, unsupported, err := dbspec.Introspect(ctx, db, dbspec.Dialect(dialect), "x")
	if err != nil || len(unsupported) > 0 {
		t.Fatalf("introspect: %v %+v", err, unsupported)
	}
	manifest, diagnostics := dbspec.ManifestOf([]*dbspec.Document{document})
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	if manifest.SchemaText != target {
		t.Fatalf("schema text\n--- want\n%s--- got\n%s", target, manifest.SchemaText)
	}
}
