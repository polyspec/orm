package dbspec

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
	_ "modernc.org/sqlite"
)

type sqliteQueryCounter struct {
	db    *sql.DB
	count int
}

func (q *sqliteQueryCounter) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	q.count++
	return q.db.QueryContext(ctx, query, args...)
}

// TestQueryCountIsIndependentOfSQLiteTableCount observes the queries Introspect actually executes.
// Requirements: DIA-198.
func TestQueryCountIsIndependentOfSQLiteTableCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, tableCount := range []int{1, 5} {
		db, err := sql.Open("sqlite", ":memory:")
		if err != nil {
			t.Fatal(err)
		}
		db.SetMaxOpenConns(1)
		for i := range tableCount {
			if _, err := db.ExecContext(context.Background(), `CREATE TABLE "item_`+strconv.Itoa(i)+`" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "label" TEXT NULL)`); err != nil {
				if closeErr := db.Close(); closeErr != nil {
					t.Errorf("close fixture after table creation failure: %v", closeErr)
				}
				t.Fatalf("create table %d: %v", i, err)
			}
		}
		counter := &sqliteQueryCounter{db: db}
		_, unsupported, err := Introspect(context.Background(), counter, DialectSQLite, "introspected")
		closeErr := db.Close()
		if err != nil {
			t.Fatalf("introspect %d tables: %v", tableCount, err)
		}
		if closeErr != nil {
			t.Fatalf("close SQLite memory connection: %v", closeErr)
		}
		if len(unsupported) != 0 {
			t.Fatalf("introspect %d tables: unsupported objects: %+v", tableCount, unsupported)
		}
		if counter.count != 3 {
			t.Fatalf("introspect %d tables sent %d catalog queries, want 3", tableCount, counter.count)
		}
		t.Logf("%d tables: %d observed catalog queries", tableCount, counter.count)
	}
}

// Requirements: DIA-133.
func TestIntrospectSQLiteFulltextTableMatchesSharedFixture(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	fixturePath := filepath.Join(repositoryRoot(t), "tests", "dbspec", "introspect.json")
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read shared introspection fixture %s: %v", fixturePath, err)
	}
	type introspectCase struct {
		ID          string              `json:"id"`
		Documents   map[string][]string `json:"documents"`
		Statements  []string            `json:"statements"`
		Document    []string            `json:"document"`
		Unsupported [][]string          `json:"unsupported"`
	}
	var vectors struct {
		Cases []introspectCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("decode shared introspection fixture: %v", err)
	}
	var sharedCase *introspectCase
	for i := range vectors.Cases {
		if vectors.Cases[i].ID == "sqlite-fulltext-table" {
			sharedCase = &vectors.Cases[i]
			break
		}
	}
	if sharedCase == nil {
		t.Fatal("shared introspection fixture has no sqlite-fulltext-table case")
	}
	documents, err := parseDocumentSet(sharedCase.Documents)
	if err != nil {
		t.Fatalf("parse shared case documents: %v", err)
	}
	statements, diagnostics := Render(documents, DialectSQLite)
	if len(diagnostics) > 0 {
		t.Fatalf("render shared case documents: %v", diagnostics)
	}
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close SQLite memory database: %v", err)
		}
	}()
	db.SetMaxOpenConns(1)
	for _, statement := range statements {
		if _, err := db.ExecContext(context.Background(), statement); err != nil {
			t.Fatalf("apply shared case document statement %q: %v", statement, err)
		}
	}
	for _, statement := range sharedCase.Statements {
		if _, err := db.ExecContext(context.Background(), statement); err != nil {
			t.Fatalf("apply shared case statement %q: %v", statement, err)
		}
	}
	document, unsupported, err := Introspect(context.Background(), db, DialectSQLite, "introspected")
	if err != nil {
		t.Fatalf("introspect SQLite FTS5 table: %v", err)
	}
	if got, want := Emit(document), joinLines(sharedCase.Document, false); got != want {
		t.Fatalf("introspected document differs from shared case: got %q, want %q", got, want)
	}
	if len(unsupported) != len(sharedCase.Unsupported) {
		t.Fatalf("unsupported objects: got %+v, want %v", unsupported, sharedCase.Unsupported)
	}
	for i, expected := range sharedCase.Unsupported {
		item := unsupported[i]
		if len(expected) < 3 || item.Kind != expected[0] || item.Table != expected[1] || item.Name != expected[2] {
			t.Fatalf("unsupported item %d: got %+v, want %v", i, item, expected)
		}
		if len(expected) == 4 && !strings.Contains(item.Reason, expected[3]) {
			t.Fatalf("unsupported item %d reason: got %q, want it to contain %q", i, item.Reason, expected[3])
		}
	}
}

// Requirements: DIA-191.
func TestSQLiteUnsupportedColumnReasonQuotesMissingCheck(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, tc := range []struct{ name, column string }{
		{name: "quoted", column: `"junk" INTEGER NULL`},
		{name: "unquoted", column: `junk INTEGER NULL`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := sql.Open("sqlite", ":memory:")
			if err != nil {
				t.Fatal(err)
			}
			statement := `CREATE TABLE "probe" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ` + tc.column + `)`
			if _, err := db.ExecContext(context.Background(), statement); err != nil {
				if closeErr := db.Close(); closeErr != nil {
					t.Errorf("close SQLite memory connection after table creation failure: %v", closeErr)
				}
				t.Fatal(err)
			}
			_, unsupported, err := Introspect(context.Background(), db, DialectSQLite, "introspected")
			closeErr := db.Close()
			if err != nil {
				t.Fatalf("introspect SQLite memory database: %v", err)
			}
			if closeErr != nil {
				t.Fatalf("close SQLite memory connection: %v", closeErr)
			}
			if len(unsupported) != 1 {
				t.Fatalf("unsupported objects = %+v, want only column junk", unsupported)
			}
			want := Unsupported{
				Kind:   "column",
				Table:  "probe",
				Name:   "junk",
				Reason: `declared type INTEGER with CHECK "" has no dbspec type`,
			}
			if unsupported[0] != want {
				t.Fatalf("unsupported object = %+v, want %+v", unsupported[0], want)
			}
		})
	}
}
