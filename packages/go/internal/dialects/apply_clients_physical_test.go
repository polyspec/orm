//go:build physical

package dialects

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/testcase"
)

// runnerDeadline is the deadline of one apply runner process.
const runnerDeadline = 2 * time.Minute

// pairDeadline is the deadline of one ordered-pair case. A case runs the runner process at most three times
// (stop, apply, recover), and creating a database and reading and deleting its history and schema
// gets one more minute.
const pairDeadline = 3*runnerDeadline + time.Minute

// applyClients is the client with the apply runner of tests/dbspec/apply, as set by the declared implementations of config/parity.json.
var applyClients = dbspecLanguages()

// dbspecLanguages reads the declared implementations of config/parity.json. This test runs from the package directory,
// so the paths are relative to packages/go/internal/dialects.
func dbspecLanguages() []string {
	return testcase.ParityImplementations(repoRoot)
}

// TestApplyChainAcrossClients checks, for every ordered pair, whether a chain applied by one client is continued
// by another client (docs/spec/plans.md "Apply"). On three databases
// client A applies the first plan of the tests/dbspec/plans.json chain and client B applies the rest;
// the history rows and the introspected schema text afterward must equal the expected ones. When A stops
// partway, B must reject the interrupted apply and finish it with recover, and when it stops again
// an apply, B must roll it back with rollback.
func TestApplyChainAcrossClients(t *testing.T) {
	testcase.Group(t)
	rustRunner, extension, python := os.Getenv("DBSPEC_APPLY_RUST"), os.Getenv("POLYSPEC_ORM_EXTENSION"), os.Getenv("ORM_PYTHON")
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if rustRunner == "" || extension == "" || python == "" || mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("DBSPEC_APPLY_RUST, POLYSPEC_ORM_EXTENSION, ORM_PYTHON, ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; run make dbspec-apply-pairs-check")
	}
	// make gives as absolute paths the Rust runner under CARGO_TARGET_DIR, the PHP extension in the run directory, and the python of the venv made by install-python.
	if !filepath.IsAbs(rustRunner) || !filepath.IsAbs(extension) || !filepath.IsAbs(python) {
		t.Fatalf("DBSPEC_APPLY_RUST %q, POLYSPEC_ORM_EXTENSION %q and ORM_PYTHON %q must be absolute paths", rustRunner, extension, python)
	}
	root, err := filepath.Abs(repoRoot)
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
	// The Go runner build has the testcase.Process deadline (it takes minutes when the build cache is empty).
	building, cancelBuild := context.WithTimeout(context.Background(), testcase.Process)
	build := exec.CommandContext(building, "go", "build", "-o", goRunner, "./packages/go/internal/dbspec/apply")
	build.Dir = root
	out, err := build.CombinedOutput()
	cancelBuild()
	if err != nil {
		t.Fatalf("build the Go apply runner: %v\n%s", err, out)
	}
	runners := map[string][]string{
		"go":            {goRunner},
		"php":           {"php", "packages/php/testing/dbspec/apply/php.php"},
		"typescript":    {"node", "packages/ts/testing/dbspec/apply/typescript.mts"},
		"rust":          {rustRunner},
		"php-extension": {"php", "-d", "extension=" + extension, "packages/php-ext/testing/dbspec/apply/php-extension.php"},
		"python":        {python, "packages/python/tests/dbspec_apply_runner.py"},
	}
	// The database name includes the pid and a random value so that it does not overlap with another test run at the same time.
	token := uniqueToken(t)

	// step runs the action with the client's runner and checks that the result line is want.
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
				// sqlx does not create a missing SQLite file, so an empty database file is created first.
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
	// On three databases, A runs statement 1 of the second plan and stops, and B continues
	// it to finish or roll it back.
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
	if runs != 270 {
		t.Errorf("ran %d pairs, want 30 pairs of chain, recover and rollback on three databases", runs)
	}
	t.Logf("pairs: %d", runs)
}

// chainHistory is the history rows of the dialect database to which the chain was applied to the end. Each row is
// applied up to the step before finalize. If last is "<state> <step>", the row of the last plan has
// that state and step.
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

// checkHistory checks whether the history rows of uri are want.
func checkHistory(t *testing.T, dialect, uri string, want []string) {
	t.Helper()
	db := openURI(t, dialect, uri)
	defer testcase.Close(t, db)
	q := `"`
	if dialect == "mysql" {
		q = "`"
	}
	rows, err := db.Query("SELECT name, from_hash, to_hash, state, step, steps, applied_at FROM " + q + "dbspec$plans" + q + " ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, rows)
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

// checkChainState checks that the history rows are want and the introspected schema text is target.
func checkChainState(t *testing.T, dialect, uri string, want []string, target string) {
	t.Helper()
	checkHistory(t, dialect, uri, want)
	db := openURI(t, dialect, uri)
	defer testcase.Close(t, db)
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
