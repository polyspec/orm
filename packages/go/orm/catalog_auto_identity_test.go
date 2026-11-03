package orm

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func openCatalogSQLiteDefaultFixture(t *testing.T, name, ddl string) (*CatalogConnection, CatalogTableMetadata) {
	t.Helper()
	path := filepath.Join(t.TempDir(), name+".sqlite")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := raw.Close(); err != nil {
			t.Errorf("close raw sqlite connection: %v", err)
		}
	})
	if _, err := raw.Exec(ddl); err != nil {
		t.Fatal(err)
	}
	catalog, err := ConnectCatalog("sqlite://" + path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := catalog.Close(); err != nil {
			t.Errorf("close catalog: %v", err)
		}
	})
	metadata, err := catalog.DescribeTable(context.Background(), CatalogTableRef{Namespace: "main", Name: name})
	if err != nil {
		t.Fatal(err)
	}
	return catalog, metadata
}

func requireCatalogRows(t *testing.T, catalog *CatalogConnection, query string, args []any, want [][]any) {
	t.Helper()
	result, err := catalog.ReadOnlyQuery(context.Background(), query, args, CatalogQueryLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Rows, want) {
		t.Fatalf("stored rows = %#v, want %#v", result.Rows, want)
	}
}

func requireCatalogInsertedRow(t *testing.T, result CatalogMutationResult, want []any) {
	t.Helper()
	if len(result.Rows) != 1 || !reflect.DeepEqual(result.Rows[0], want) {
		t.Fatalf("inserted row = %+v, want %v", result.Rows, want)
	}
}

