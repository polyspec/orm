package orm

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// catalogWriters inserts rows and reads which server connection wrote each, through a column whose default is the id of that
// connection.
func catalogWriters(t *testing.T, dsn, create, table string) []int64 {
	t.Helper()
	ctx := context.Background()
	catalog, err := ConnectCatalog(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, catalog) })
	pool := catalog.db.sql
	if _, err := pool.ExecContext(ctx, "DROP TABLE IF EXISTS "+table); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.ExecContext(ctx, create); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.ExecContext(ctx, "DROP TABLE "+table); err != nil {
			t.Error(err)
		}
	})
	namespace, err := catalog.CurrentNamespace(ctx)
	if err != nil {
		t.Fatal(err)
	}
	declared, err := catalog.DescribeTable(ctx, CatalogTableRef{Namespace: namespace, Name: table})
	if err != nil {
		t.Fatal(err)
	}
	insert := func(id int64) error {
		_, err := catalog.InsertRow(ctx, declared, []CatalogAssignment{{Name: "id", Value: id}})
		return err
	}
	for id := int64(1); id <= 5; id++ {
		if err := insert(id); err != nil {
			t.Fatal(err)
		}
	}
	// A refused insert rolls back and discards its connection, and the next one still writes in a transaction of its own.
	if err := insert(1); err == nil || !strings.Contains(err.Error(), "ROW_CONFLICT") {
		t.Fatalf("the repeated key: %v", err)
	}
	if err := insert(7); err != nil {
		t.Fatal(err)
	}
	var committed int
	if err := pool.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&committed); err != nil {
		t.Fatal(err)
	}
	if committed != 6 {
		t.Fatalf("committed rows: %d", committed)
	}
	rows, err := pool.QueryContext(ctx, "SELECT backend FROM "+table+" WHERE id < 7")
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, rows)
	var writers []int64
	for rows.Next() {
		var writer int64
		if err := rows.Scan(&writer); err != nil {
			t.Fatal(err)
		}
		writers = append(writers, writer)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return writers
}

// Requirements: INT-106c.
// Runtime-unique (FCV-14): which connection a mutation takes is a choice of each runtime's pool, and the spec names only its fresh transaction.
func TestCommittedCatalogMutationsShareOneConnection(t *testing.T) {
	testcase.Start(t, testcase.Database)
	table := fmt.Sprintf("orm_mutation_connection_%d", os.Getpid())
	for _, database := range []struct{ name, dsn, create string }{
		{"postgres", os.Getenv("ORM_TEST_POSTGRES_DSN"), "CREATE TABLE " + table + "(id BIGINT PRIMARY KEY, backend INTEGER NOT NULL DEFAULT pg_backend_pid())"},
		{"mysql", os.Getenv("ORM_TEST_MYSQL_DSN"), "CREATE TABLE " + table + "(id BIGINT PRIMARY KEY, backend BIGINT NOT NULL DEFAULT (CONNECTION_ID())) ENGINE=InnoDB"},
	} {
		if database.dsn == "" {
			t.Fatalf("the DSN of %s is required; run make orm-test-servers", database.name)
		}
		writers := catalogWriters(t, database.dsn, database.create, table)
		if len(writers) != 5 {
			t.Fatalf("%s writers: %v", database.name, writers)
		}
		for _, writer := range writers {
			if writer != writers[0] {
				t.Errorf("%s writers: %v", database.name, writers)
				break
			}
		}
	}
}
