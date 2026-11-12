package orm

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
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
