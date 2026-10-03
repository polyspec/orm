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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/internal/testcase"
)

// introspectBudget는 2000 table stress database를 introspect하는 데 client마다
// 허용하는 시간이다(docs/dialects.md "Introspection").
const introspectBudget = 5 * time.Second

// compareRunnerDeadline은 introspection runner process 하나의 기한이다. runner는 `go run`이면
// compile을 포함하고, budget을 넘긴 runner도 끝까지 기다려 그 시간을 보고한다.
const compareRunnerDeadline = 5 * time.Minute

// compareDeadline은 database 하나의 case 기한이다. 2000 table 문서를 statement마다 따로
// 실행해 적용하는 일(MySQL에서 몇 분)과 네 runner를 차례로 실행하는 일을 담는다. 세
// database의 check 전체가 5-11분 걸렸으므로 database 하나에 15분은 멈춘 case만 끝낸다.
const compareDeadline = 15 * time.Minute

// applyProgressEvery는 statement를 몇 개 적용할 때마다 단계 줄을 출력하는지다.
const applyProgressEvery = 1000

// TestIntrospectCompare는 stress 문서를 세 database에 적용하고 네 client의
// introspection runner가 같은 출력을 내는지, 그 문서의 schema text가 원본과
// 같은지, 미지원 객체가 없는지, 각 client가 budget 안에 끝나는지 확인한다.
func TestIntrospectCompare(t *testing.T) {
	testcase.Group(t)
	stressPath, rustRunner := os.Getenv("DBSPEC_STRESS_DOCUMENT"), os.Getenv("DBSPEC_INTROSPECT_RUST")
	mysqlDSN, postgresDSN := os.Getenv("ORM_TEST_MYSQL_DSN"), os.Getenv("ORM_TEST_POSTGRES_DSN")
	if stressPath == "" || rustRunner == "" || mysqlDSN == "" || postgresDSN == "" {
		t.Fatal("DBSPEC_STRESS_DOCUMENT, DBSPEC_INTROSPECT_RUST, ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; run make dbspec-introspect-compare-check")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	text, diagnostics, err := dbspec.ReadFile(filepath.Join(root, stressPath))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	document, diagnostics := dbspec.Parse(text, nil)
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	want := expectedSchemaText(t, []*dbspec.Document{document})
	name := "dbspec_cmp_" + strconv.Itoa(os.Getpid())
	runners := []struct {
		client string
		args   []string
	}{
		{"go", []string{"go", "run", "./tests/dbspec/introspect/go"}},
		{"php", []string{"php", "tests/dbspec/introspect/php.php"}},
		{"typescript", []string{"node", "tests/dbspec/introspect/typescript.mjs"}},
		{"rust", []string{filepath.Join(root, rustRunner)}},
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
				if elapsed > introspectBudget {
					t.Errorf("%s %s: introspection took %s, over the %s budget", dialect, r.client, elapsed, introspectBudget)
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

// compareDatabase는 dialect의 빈 database를 만들고 그 URI와 지우는 함수를 돌려준다.
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

// applyStatements는 statement를 한 connection에서 c의 기한 안에 차례로 실행하고,
// applyProgressEvery개마다 단계 줄을 출력한다.
func applyStatements(t *testing.T, c *testcase.Case, dialect, uri string, statements []string) {
	t.Helper()
	db := openURI(t, dialect, uri)
	defer db.Close()
	ctx := c.Context()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
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

// openURI는 runner와 같은 URI 형식을 database/sql driver로 연다.
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

// runnerElapsed는 runner stderr의 "elapsed <ms>" 줄을 읽는다.
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

// checkIntrospected는 runner 출력의 문서가 원본 schema text를 갖고 미지원 객체가
// 없는지 확인한다.
func checkIntrospected(t *testing.T, output, want string) {
	t.Helper()
	if i := strings.Index(output, "\n! "); i >= 0 {
		t.Fatalf("unsupported objects: %s", output[i+1:])
	}
	document, diagnostics := dbspec.Parse(output, nil)
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
