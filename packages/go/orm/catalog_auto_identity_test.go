package orm

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestCatalogInsertReturnsSQLiteAutomaticPrimaryKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	path := filepath.Join(t.TempDir(), "catalog-auto-key.sqlite")
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
	if _, err := raw.Exec(`CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)`); err != nil {
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
	ctx := context.Background()
	table := CatalogTableRef{Namespace: "main", Name: "sample"}
	metadata, err := catalog.DescribeTable(ctx, table)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(metadata.PrimaryKey, []string{"id"}) || len(metadata.Columns) != 2 {
		t.Fatalf("table metadata = %+v, want sole primary key id and two columns", metadata)
	}
	id := metadata.Columns[0]
	if id.Name != "id" || id.NativeType != "INTEGER" || id.Nullable || id.Generated || !id.AutomaticKey || id.DefaultExpression != nil || id.ExpressionDefault {
		t.Fatalf("id metadata = %+v, want SQLite automatic rowid key with no default expression", id)
	}

	for i, payload := range []string{"generated", "second"} {
		inserted, err := catalog.InsertRow(ctx, metadata, []CatalogAssignment{{Name: "payload", Value: payload}})
		if err != nil {
			t.Fatalf("InsertRow(%q) without the automatic key: %v", payload, err)
		}
		wantID := int64(i + 1)
		if len(inserted.Columns) != 2 || len(inserted.Rows) != 1 || !reflect.DeepEqual(inserted.Rows[0], []any{wantID, payload}) {
			t.Fatalf("InsertRow(%q) = %+v, want returned row [%d %q]", payload, inserted, wantID, payload)
		}
	}
	explicit, err := catalog.InsertRow(ctx, metadata, []CatalogAssignment{
		{Name: "id", Value: int64(20)},
		{Name: "payload", Value: "explicit"},
	})
	if err != nil || len(explicit.Rows) != 1 || !reflect.DeepEqual(explicit.Rows[0], []any{int64(20), "explicit"}) {
		t.Fatalf("InsertRow with explicit primary key = %+v, err %v", explicit, err)
	}
	rows, err := catalog.ReadOnlyQuery(ctx, `SELECT id,payload FROM sample ORDER BY id`, nil, CatalogQueryLimits{})
	if err != nil {
		t.Fatal(err)
	}
	want := [][]any{{int64(1), "generated"}, {int64(2), "second"}, {int64(20), "explicit"}}
	if !reflect.DeepEqual(rows.Rows, want) {
		t.Fatalf("stored rows = %#v, want %#v", rows.Rows, want)
	}
}
