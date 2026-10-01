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
)

// runnerDeadline은 apply runner process 하나의 기한이다.
const runnerDeadline = 2 * time.Minute

// applyClients는 tests/dbspec/apply의 runner를 가진 client다.
var applyClients = []string{"go", "php", "typescript", "rust"}

// TestApplyChainAcrossClients는 한 client가 적용한 chain을 다른 client가 이어
// 적용하는지 모든 순서쌍에서 확인한다(docs/plans.md "Apply"). 세 database에서
// client A가 tests/dbspec/plans.json chain의 첫 plan을, client B가 나머지를 적용한
// 뒤 history row와 introspect한 schema text가 기대와 같아야 한다. MySQL에서는 A가
// 둘째 plan 중간에 멈춘 apply를 B가 interrupted로 거부하고 recover로 끝내야 한다.
func TestApplyChainAcrossClients(t *testing.T) {
	rustRunner := os.Getenv("DBSPEC_APPLY_RUST")
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if rustRunner == "" || mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("DBSPEC_APPLY_RUST, ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; run make dbspec-apply-pairs-check")
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
	build := exec.Command("go", "build", "-o", goRunner, "./tests/dbspec/apply/go")
	build.Dir = root
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build the Go apply runner: %v\n%s", err, out)
	}
	runners := map[string][]string{
		"go":         {goRunner},
		"php":        {"php", "tests/dbspec/apply/php.php"},
		"typescript": {"node", "tests/dbspec/apply/typescript.mjs"},
		"rust":       {filepath.Join(root, rustRunner)},
	}
	// 동시에 도는 다른 test run과 겹치지 않도록 database 이름에 pid와 random 값을 넣는다.
	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	token := strconv.Itoa(os.Getpid()) + "_" + hex.EncodeToString(random)

	// step은 client의 runner로 action을 실행하고 결과 줄이 want인지 확인한다.
	step := func(t *testing.T, client, action, dialect, uri, want string) {
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
		t.Logf("%s %s: %s after %s", client, action, want, elapsed)
	}
	runs := 0
	pair := func(id, dialect string, body func(t *testing.T, uri string)) {
		runs++
		name := fmt.Sprintf("dbspec_pair_%s_%02d", token, runs)
		t.Run(id, func(t *testing.T) {
			begin := time.Now()
			t.Logf("start %s on %s", id, name)
			uri, cleanup := compareDatabase(t, dialect, name, mysqlDSN, postgresDSN)
			defer cleanup()
			if dialect == "sqlite" {
				// sqlx는 없는 SQLite file을 만들지 않으므로 빈 database file을 먼저 만든다.
				if err := os.WriteFile(strings.TrimPrefix(uri, "sqlite://"), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			body(t, uri)
			result := "PASS"
			if t.Failed() {
				result = "FAIL"
			}
			t.Logf("result %s: %s after %s", id, result, time.Since(begin).Round(time.Millisecond))
		})
	}
	for _, dialect := range []string{"mysql", "postgres", "sqlite"} {
		want := chainHistory(t, plans, dialect, "")
		for _, a := range applyClients {
			for _, b := range applyClients {
				if a == b {
					continue
				}
				pair(dialect+".chain."+a+"-"+b, dialect, func(t *testing.T, uri string) {
					step(t, a, "apply-first", dialect, uri, "ok")
					step(t, b, "apply", dialect, uri, "ok")
					checkChainState(t, dialect, uri, want, target.SchemaText)
				})
			}
		}
	}
	// MySQL recovery: A가 둘째 plan의 statement 1을 실행한 뒤 멈추고 B가 끝낸다.
	want := chainHistory(t, plans, "mysql", "")
	running := chainHistory(t, plans, "mysql", "running 1")
	for _, a := range applyClients {
		for _, b := range applyClients {
			if a == b {
				continue
			}
			pair("mysql.recover."+a+"-"+b, "mysql", func(t *testing.T, uri string) {
				step(t, a, "stop", "mysql", uri, "stopped")
				checkHistory(t, "mysql", uri, running)
				step(t, b, "apply", "mysql", uri, "error interrupted")
				step(t, b, "recover", "mysql", uri, "ok")
				checkChainState(t, "mysql", uri, want, target.SchemaText)
			})
		}
	}
	if runs != 48 {
		t.Errorf("ran %d pairs, want 12 pairs on three databases and 12 MySQL recoveries", runs)
	}
	t.Logf("pairs: %d", runs)
}

// chainHistory는 chain을 끝까지 적용한 dialect database의 history row다. last가
// "running <step>"이면 마지막 plan의 row가 그 step에서 running이다.
func chainHistory(t *testing.T, plans []*dbspec.Plan, dialect, last string) []string {
	t.Helper()
	var rows []string
	var source *dbspec.Document
	for i, p := range plans {
		statements, diagnostics := dbspec.PlanStatements(source, p, dbspec.Dialect(dialect))
		if len(diagnostics) > 0 {
			t.Fatal(diagnostics)
		}
		from := p.From
		if from == "" {
			from = "empty"
		}
		state, step := "done", strconv.Itoa(len(statements))
		if i == len(plans)-1 && last != "" {
			state, step, _ = strings.Cut(last, " ")
		}
		rows = append(rows, strings.Join([]string{p.Name, from, p.To, state, step, strconv.Itoa(len(statements)), "2026-10-01T00:00:00Z"}, "|"))
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
