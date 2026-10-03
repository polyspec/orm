//go:build physical

package dialects

import (
	"context"
	"database/sql"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// sqliteQuery is the query part of the BENCH_SQLITE_DSN that test-servers.sh
// writes.
const sqliteQuery = "?_pragma=busy_timeout(5000)&timezone=%2B00:00"

// TestSQLiteFileNameWithQuery records which SQLite openers treat a file name
// that still carries the DSN query as the literal file name. Each case opens
// "<dir>/<name>.sqlite<query>", creates a table, and asserts the file names
// that appear in its own directory. A DSN parser must remove the query before
// it names the file.
func TestSQLiteFileNameWithQuery(t *testing.T) {
	testcase.Group(t)
	cases := []struct {
		id      string
		literal bool // true: the query becomes part of the file name
		open    func(ctx context.Context, name string) error
	}{
		{"sqlite.filename.modernc_parses_query", false, func(ctx context.Context, name string) error {
			db, err := sql.Open("sqlite", name)
			if err != nil {
				return err
			}
			defer db.Close()
			_, err = db.ExecContext(ctx, "CREATE TABLE t (a int)")
			return err
		}},
		{"sqlite.filename.php_pdo_literal", true, func(ctx context.Context, name string) error {
			return exec.CommandContext(ctx, "php", "-r", `(new PDO('sqlite:' . $argv[1]))->exec('CREATE TABLE t (a int)');`, name).Run()
		}},
		{"sqlite.filename.node_sqlite_literal", true, func(ctx context.Context, name string) error {
			return exec.CommandContext(ctx, "node", "-e", `new (require('node:sqlite').DatabaseSync)(process.argv[1]).exec('CREATE TABLE t (a int)')`, name).Run()
		}},
		{"sqlite.filename.sqlite3_cli_literal", true, func(ctx context.Context, name string) error {
			return exec.CommandContext(ctx, "sqlite3", name, "CREATE TABLE t (a int)").Run()
		}},
	}
	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) {
			// 각 opener는 probeDeadline 안에 file 하나를 만드는 process나 connection 하나다.
			tc := testcase.Start(t, probeCaseDeadline)
			ctx, cancel := context.WithTimeout(tc.Context(), probeDeadline)
			defer cancel()
			dir := t.TempDir()
			if err := c.open(ctx, filepath.Join(dir, "bench.sqlite")+sqliteQuery); err != nil {
				t.Fatalf("open: %v", err)
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, entry := range entries {
				names = append(names, entry.Name())
			}
			sort.Strings(names)
			want := "bench.sqlite"
			if c.literal {
				want = "bench.sqlite" + sqliteQuery
			}
			if strings.Join(names, ",") != want {
				t.Fatalf("files %q; want %q", names, want)
			}
			tc.Step("files %q", names)
		})
	}
}
