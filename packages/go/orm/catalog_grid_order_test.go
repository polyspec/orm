//go:build featurecoverage

package orm

import (
	"context"
	"database/sql"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: SCH-6a.
// TestCoverageCatalogGridOrder guards the row order of the SQLite grid read (catalogSQLiteRawQuery). The order of the rows of
// the wrapper rests on the query flattener of SQLite, so the test asserts the plan: the CTE g must not be materialized or run
// as a co-routine, and the rows of an ORDER BY DESC query must come back in descending order.
func TestCoverageCatalogGridOrder(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, dsn := testdb.FeatureDatabase(t)
	if driver != "sqlite" {
		t.Skip("the wrapper of the grid read is the SQLite form")
	}
	raw, err := sql.Open("sqlite", strings.TrimPrefix(dsn, "sqlite://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := raw.Exec("DROP TABLE IF EXISTS grid_order"); err != nil {
			t.Errorf("drop grid_order: %v", err)
		}
		if err := raw.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	if _, err := raw.Exec("DROP TABLE IF EXISTS grid_order"); err != nil {
		t.Fatal(err)
	}
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

	result, err := c.ReadOnlyGridQuery(context.Background(), query, nil, CatalogQueryLimits{})
	if err != nil {
		t.Fatalf("grid query: %v", err)
	}
	var seqs []any
	for _, row := range result.Rows {
		seqs = append(seqs, row[0].Value)
	}
	want := []any{int64(4), int64(3), int64(2), int64(1)}
	if !reflect.DeepEqual(seqs, want) {
		t.Fatalf("ORDER BY DESC rows %v, want %v", seqs, want)
	}
}
