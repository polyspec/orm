package dbspec

import (
	"context"
	"database/sql"
	"strconv"
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
				_ = db.Close()
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
