package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"regexp"
	"strconv"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestMapErrPreservesSQLiteConstraintContract(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, err := sql.Open("sqlite", "file:orm-sqlite-error-contract?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON; CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id), code TEXT NOT NULL UNIQUE); CREATE TABLE checked (value TEXT CHECK (value <> '')); INSERT INTO parent(id) VALUES (1); INSERT INTO child(parent_id, code) VALUES (1, 'one')`); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		stmt string
		want string
	}{
		{name: "duplicate", stmt: `INSERT INTO child(parent_id, code) VALUES (1, 'one')`, want: orm.CodeDuplicateKey},
		{name: "foreign key", stmt: `INSERT INTO child(parent_id, code) VALUES (99, 'two')`, want: orm.CodeForeignKey},
		{name: "check constraint", stmt: `INSERT INTO checked(value) VALUES ('')`, want: orm.CodeConstraint},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := db.ExecContext(ctx, tt.stmt)
			if err == nil {
				t.Fatal("statement unexpectedly succeeded")
			}
			mapped := mapErr(err)
			if got := orm.ErrorCode(mapped); got != tt.want {
				t.Fatalf("mapped SQLite error code = %q, want %q: %v", got, tt.want, mapped)
			}
			if errors.Is(mapped, err) {
				t.Fatal("mapped error must be the ORM error boundary, not the driver error")
			}
		})
	}
}

func TestSqliteLockedIsDriverNotDeadlock(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, n := range []int{6, 262} {
		if got := sqliteCode(n, "database table is locked"); got != orm.CodeDriver {
			t.Fatalf("SQLITE_LOCKED %d code = %q, want %q", n, got, orm.CodeDriver)
		}
	}
}

// TestResultCodeNamesMatchTable compares result_codes.go, which orm-gen sqlite-codes generates, with the
// sqlite_result_codes table of docs/spec/sqlite-result-codes.yaml: every listed code has its name, and the file holds no other code.
// A listed code ends a message with its name, and an unlisted one with its number. It checks the generator against its
// table; the recipe case sqlite_extended_code_names tests the messages in every runtime.
func TestResultCodeNamesMatchTable(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	src, err := os.ReadFile("../../../../docs/spec/sqlite-result-codes.yaml")
	if err != nil {
		t.Fatal(err)
	}
	listed := map[int]string{}
	for _, m := range regexp.MustCompile(`(?m)^  - name: (SQLITE_\w+)\n    value: (\d+)$`).FindAllSubmatch(src, -1) {
		value, err := strconv.Atoi(string(m[2]))
		if err != nil {
			t.Fatal(err)
		}
		listed[value] = string(m[1])
	}
	if len(listed) == 0 {
		t.Fatal("docs/spec/sqlite-result-codes.yaml lists no SQLite result codes")
	}
	for value, name := range listed {
		if got := resultCodeNames[value]; got != name {
			t.Errorf("result code %d: got %q, want %q", value, got, name)
		}
	}
	for value, name := range resultCodeNames {
		if _, ok := listed[value]; !ok {
			t.Errorf("result_codes.go names %d (%s), which sqlite-result-codes.yaml does not list", value, name)
		}
	}
	for _, c := range []struct {
		code int
		want string
	}{{257, " (SQLITE_ERROR_MISSING_COLLSEQ)"}, {5130, " (SQLITE_IOERR_SHMLOCK)"}, {65535, " (SQLite result code 65535)"}} {
		if got := resultCodeSuffix(c.code); got != c.want {
			t.Errorf("resultCodeSuffix(%d) = %q, want %q", c.code, got, c.want)
		}
	}
}
