//go:build physical

package dialects

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/testcase"
)

// introspectReference is the documented reference value for the time to introspect the 2000-table stress database (docs/spec/dialects.md
// "Introspection"). Exceeding it only warns and does not fail the test (AGENTS.md).
const introspectReference = 5 * time.Second

// compareRunnerDeadline is the deadline of one introspection runner process. If the runner is `go run`, it includes
// compile, and a runner that exceeds the reference still waits to the end and reports that time.
const compareRunnerDeadline = 5 * time.Minute

// compareDeadline is the case deadline for one database. It covers applying the 22000 statements of the 2000-table document
// separately and running the four runners in turn. The longest, MySQL, takes 6-7.7 minutes on
// the machine (T27 measurement: 5m57s on a shared server, 7m44s on a separate server under load).
// MySQL DDL is a database matter where each statement gets slower as tables grow, and even lowering the durability setting
// reduced it by only 14%. That is about 1.3 times the measured value.
const compareDeadline = 10 * time.Minute

// applyProgressEvery is how many statements are applied between progress lines.
const applyProgressEvery = 1000

// TestIntrospectCompare applies the stress document to three databases, and checks that four clients and the PHP extension polyspec_orm
// give the same output from the introspection runner, that the schema text of the document is the same as the original,
// and that there are no unsupported objects; it prints each client's time and warns if the reference is exceeded.
func TestIntrospectCompare(t *testing.T) {
	testcase.Group(t)
	stressPath, rustRunner, extension := os.Getenv("DBSPEC_STRESS_DOCUMENT"), os.Getenv("DBSPEC_INTROSPECT_RUST"), os.Getenv("POLYSPEC_ORM_EXTENSION")
	pythonRunner := os.Getenv("DBSPEC_INTROSPECT_PYTHON")
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if stressPath == "" || rustRunner == "" || extension == "" || pythonRunner == "" || mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("DBSPEC_STRESS_DOCUMENT, DBSPEC_INTROSPECT_RUST, POLYSPEC_ORM_EXTENSION, DBSPEC_INTROSPECT_PYTHON, ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; run make dbspec-introspect-compare-check")
	}
	root, err := filepath.Abs(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	// make gives the document and program copy in its own run directory (RUN_DIR) as absolute paths.
	if !filepath.IsAbs(stressPath) || !filepath.IsAbs(rustRunner) || !filepath.IsAbs(extension) || !filepath.IsAbs(pythonRunner) {
		t.Fatalf("DBSPEC_STRESS_DOCUMENT %q, DBSPEC_INTROSPECT_RUST %q, POLYSPEC_ORM_EXTENSION %q and DBSPEC_INTROSPECT_PYTHON %q must be absolute paths in the run directory of make", stressPath, rustRunner, extension, pythonRunner)
	}
	text, diagnostics, err := dbspec.ReadFile(stressPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	document, _, diagnostics := dbspec.Parse(text, nil)
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	want := expectedSchemaText(t, []*dbspec.Document{document})
	name := "dbspec_cmp_" + strconv.Itoa(os.Getpid())
	runners := []struct {
		client string
		args   []string
	}{
		{"go", []string{"go", "run", "./packages/go/internal/dbspec/introspect"}},
		{"php", []string{"php", "packages/php/testing/dbspec/introspect/php.php"}},
		{"typescript", []string{"node", "packages/ts/testing/dbspec/introspect/typescript.mts"}},
		{"rust", []string{rustRunner}},
		{"php-extension", []string{"php", "-d", "extension=" + extension, "packages/php-ext/testing/dbspec/introspect/php-extension.php"}},
		{"python", []string{pythonRunner, "packages/python/tests/dbspec_introspect_runner.py"}},
	}
	for _, dialect := range []string{"mysql", "postgres", "sqlite"} {
		t.Run(dialect, func(t *testing.T) {
			c := testcase.Start(t, compareDeadline)
			uri, cleanup := compareDatabase(t, dialect, name, mysqlDSN, postgresDSN)
			defer cleanup()
			statements, diagnostics := dbspec.Render([]*dbspec.Document{document}, dbspec.Dialect(dialect))
			if len(diagnostics) > 0 {
				t.Fatal(diagnostics)
			}
			c.Step("applying %d statements", len(statements))
			applyStatements(t, c, dialect, uri, statements)
			c.Step("applied %d statements", len(statements))
			var reference string
			for _, r := range runners {
				c.Step("running the %s runner", r.client)
				ctx, cancel := context.WithTimeout(c.Context(), compareRunnerDeadline)
				cmd := exec.CommandContext(ctx, r.args[0], append(r.args[1:], dialect, uri)...)
				cmd.Dir = root
				var stdout, stderr bytes.Buffer
				cmd.Stdout, cmd.Stderr = &stdout, &stderr
				err := cmd.Run()
				cancel()
				if err != nil {
					t.Fatalf("%s: %v\n%s", r.client, err, stderr.String())
				}
				elapsed, err := runnerElapsed(stderr.String())
				if err != nil {
					t.Fatalf("%s: %v", r.client, err)
				}
				c.Step("%s %s: %d bytes, introspected in %s", dialect, r.client, stdout.Len(), elapsed)
				if elapsed > introspectReference {
					testcase.Warn("%s %s: introspection took %s, above the %s reference (docs/spec/dialects.md, Introspection); machine %s %s", dialect, r.client, elapsed, introspectReference, runtime.GOOS, runtime.GOARCH)
				}
				if reference == "" {
					reference = stdout.String()
					checkIntrospected(t, reference, want)
					continue
				}
				if stdout.String() != reference {
					t.Errorf("%s %s: output differs from go at line %d", dialect, r.client, firstDifferentLine(reference, stdout.String()))
				}
			}
		})
	}
}

// compareDatabase creates an empty database for the dialect and returns its URI and a function to delete it.
func compareDatabase(t *testing.T, dialect, name, mysqlDSN, postgresDSN string) (string, func()) {
	t.Helper()
	switch dialect {
	case "sqlite":
		path := filepath.Join(t.TempDir(), name+".sqlite")
		return "sqlite://" + path, func() {}
	case "mysql":
		u, err := url.Parse(mysqlDSN)
		if err != nil {
			t.Fatal(err)
		}
		admin := openURI(t, "mysql", u.String())
		mustExec(t, admin, "CREATE DATABASE `"+name+"`")
		u.Path = "/" + name
		return u.String(), func() {
			mustExec(t, admin, "DROP DATABASE `"+name+"`")
			admin.Close()
		}
	}
	u, err := url.Parse(postgresDSN)
	if err != nil {
		t.Fatal(err)
	}
	admin := openURI(t, "postgres", u.String())
	mustExec(t, admin, `CREATE DATABASE "`+name+`"`)
	u.Path = "/" + name
	return u.String(), func() {
		mustExec(t, admin, `DROP DATABASE "`+name+`" WITH (FORCE)`)
		admin.Close()
	}
}

// applyStatements runs the statements in order on one connection within c's deadline,
// and prints a progress line every applyProgressEvery.
func applyStatements(t *testing.T, c *testcase.Case, dialect, uri string, statements []string) {
	t.Helper()
	db := openURI(t, dialect, uri)
	defer testcase.Close(t, db)
	ctx := c.Context()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, conn)
	for _, rule := range connectionRules[dialect] {
		if _, err := conn.ExecContext(ctx, rule); err != nil {
			t.Fatalf("%s: %v", rule, err)
		}
	}
	for i, s := range statements {
		if _, err := conn.ExecContext(ctx, s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
		if (i+1)%applyProgressEvery == 0 {
			c.Step("%d of %d statements applied", i+1, len(statements))
		}
	}
}

// openURI opens the URI, in the same format as the runner, with the database/sql driver.
func openURI(t *testing.T, dialect, uri string) *sql.DB {
	t.Helper()
	u, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	var db *sql.DB
	switch dialect {
	case "mysql":
		cfg := mysql.NewConfig()
		cfg.User = u.User.Username()
		cfg.Passwd, _ = u.User.Password()
		cfg.Net, cfg.Addr, cfg.DBName = "tcp", u.Host, strings.TrimPrefix(u.Path, "/")
		connector, err := mysql.NewConnector(cfg)
		if err != nil {
			t.Fatal(err)
		}
		db = sql.OpenDB(connector)
	case "postgres":
		db, err = sql.Open("pgx", uri)
	case "sqlite":
		db, err = sql.Open("sqlite", "file:"+u.Path)
	}
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func mustExec(t *testing.T, db *sql.DB, statement string) {
	t.Helper()
	if _, err := db.Exec(statement); err != nil {
		t.Fatalf("%s: %v", statement, err)
	}
}

// runnerElapsed reads the "elapsed <ms>" line of the runner stderr.
func runnerElapsed(stderr string) (time.Duration, error) {
	for _, line := range strings.Split(stderr, "\n") {
		if ms, ok := strings.CutPrefix(line, "elapsed "); ok {
			v, err := strconv.ParseFloat(ms, 64)
			if err != nil {
				return 0, err
			}
			return time.Duration(v * float64(time.Millisecond)), nil
		}
	}
	return 0, fmt.Errorf("no elapsed line in %q", stderr)
}

// checkIntrospected checks that the document in the runner output has the original schema text and
// no unsupported objects.
func checkIntrospected(t *testing.T, output, want string) {
	t.Helper()
	if i := strings.Index(output, "\n! "); i >= 0 {
		t.Fatalf("unsupported objects: %s", output[i+1:])
	}
	document, _, diagnostics := dbspec.Parse(output, nil)
	if len(diagnostics) > 0 {
		t.Fatalf("runner document: %v", diagnostics)
	}
	if got := expectedSchemaText(t, []*dbspec.Document{document}); got != want {
		t.Fatalf("schema text differs at line %d", firstDifferentLine(want, got))
	}
}

func firstDifferentLine(a, b string) int {
	al, bl := strings.Split(a, "\n"), strings.Split(b, "\n")
	for i := range max(len(al), len(bl)) {
		if i >= len(al) || i >= len(bl) || al[i] != bl[i] {
			return i + 1
		}
	}
	return 0
}
