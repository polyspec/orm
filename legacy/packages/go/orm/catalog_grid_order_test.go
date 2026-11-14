package orm

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/internal/testdb"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// Runtime-unique (FCV-14): only the Go grid read wraps a query in a CTE, and no public call reads its plan; the rows it returns
// are the recipe case grid_column_and_row_order.
// Requirements: SCH-6b.
// TestCoverageCatalogGridOrder guards the row order of the SQLite grid read (catalogSQLiteRawQuery). The order of the rows of
// the wrapper rests on the query flattener of SQLite, so the test asserts the plan: the CTE g must not be materialized or run
// as a co-routine.
func TestCoverageCatalogGridOrder(t *testing.T) {
	testcase.Start(t)
	dsn := testdb.New(t, "sqlite")
	raw, err := sql.Open("sqlite", strings.TrimPrefix(dsn, "sqlite://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := raw.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	if _, err := raw.Exec("CREATE TABLE grid_order (seq INTEGER PRIMARY KEY, label TEXT)"); err != nil {
		t.Fatal(err)
	}
	for _, row := range []string{"(1, 'a')", "(2, 'b')", "(3, 'c')", "(4, 'd')"} {
		if _, err := raw.Exec("INSERT INTO grid_order VALUES " + row); err != nil {
			t.Fatal(err)
		}
	}

	query := "SELECT seq, label FROM grid_order ORDER BY seq DESC"
	c, err := ConnectCatalog(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, c)

	// The plan of the wrapper that ReadOnlyGridQuery runs: flattened, the plan reads grid_order directly.
	plan, err := c.db.sql.QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+catalogSQLiteRawQuery(query, 2))
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	var details []string
	for plan.Next() {
		var id, parent, notUsed int
		var detail string
		if err := plan.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("explain row: %v", err)
		}
		details = append(details, detail)
	}
	if err := plan.Err(); err != nil {
		t.Fatalf("explain rows: %v", err)
	}
	if err := plan.Close(); err != nil {
		t.Fatalf("explain close: %v", err)
	}
	joined := strings.Join(details, "\n")
	for _, step := range []string{"MATERIALIZE", "CO-ROUTINE"} {
		if strings.Contains(joined, step) {
			t.Fatalf("the grid wrapper is no longer flattened (plan has %s):\n%s", step, joined)
		}
	}
	if !strings.Contains(joined, "grid_order") {
		t.Fatalf("the grid wrapper plan does not read grid_order:\n%s", joined)
	}

}
