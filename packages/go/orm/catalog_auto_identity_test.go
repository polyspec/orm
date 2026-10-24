package orm

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestCatalogInsertReturnsSQLiteAutomaticPrimaryKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	catalog, metadata := openCatalogSQLiteDefaultFixture(t, "sample", "CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)")
	ctx := context.Background()
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
	want := [][]any{{int64(1), "generated"}, {int64(2), "second"}, {int64(20), "explicit"}}
	requireCatalogRows(t, catalog, `SELECT id,payload FROM sample ORDER BY id`, nil, want)
}

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

func TestCatalogInsertRequiresIdentityWithoutDatabaseGeneration(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	catalog, metadata := openCatalogSQLiteDefaultFixture(t, "required_identity", "CREATE TABLE required_identity (id TEXT NOT NULL PRIMARY KEY, payload TEXT NOT NULL)")
	_, err := catalog.InsertRow(context.Background(), metadata, []CatalogAssignment{{Name: "payload", Value: "missing-key"}})
	if err == nil || ErrorCode(err) != "ROW_INSERT_IDENTITY_REQUIRED" {
		t.Fatalf("InsertRow without a supplied or generated key error = %v, want ROW_INSERT_IDENTITY_REQUIRED", err)
	}
	stored, err := catalog.ReadOnlyQuery(context.Background(), "SELECT id,payload FROM required_identity", nil, CatalogQueryLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.Rows) != 0 {
		t.Fatalf("rows after rejected insert = %#v, want none", stored.Rows)
	}
}

func TestCatalogInsertReturnsSQLiteLiteralDefaultCompositePrimaryKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	catalog, metadata := openCatalogSQLiteDefaultFixture(t, "generated_default", "CREATE TABLE generated_default (tenant BIGINT NOT NULL, seq VARCHAR(30) NOT NULL DEFAULT 'generated', n BIGINT NOT NULL, PRIMARY KEY(tenant,seq))")
	if !reflect.DeepEqual(metadata.PrimaryKey, []string{"tenant", "seq"}) || metadata.Columns[1].DefaultExpression == nil || metadata.Columns[1].AutomaticKey {
		t.Fatalf("literal default descriptor = %+v, want composite key with a nonautomatic literal default", metadata)
	}
	ctx := context.Background()
	values := []CatalogAssignment{{Name: "tenant", Value: int64(2)}, {Name: "n", Value: int64(50)}}
	inserted, err := catalog.InsertRow(ctx, metadata, values)
	if err != nil {
		t.Fatalf("InsertRow with omitted literal-default key: %v", err)
	}
	want := []any{int64(2), "generated", int64(50)}
	requireCatalogInsertedRow(t, inserted, want)
	requireCatalogRows(t, catalog, "SELECT tenant,seq,n FROM generated_default WHERE tenant=?", []any{int64(2)}, [][]any{want})
	duplicate, err := catalog.InsertRow(ctx, metadata, []CatalogAssignment{{Name: "tenant", Value: int64(2)}, {Name: "n", Value: int64(51)}})
	if err == nil || ErrorCode(err) != CodeDuplicateKey {
		t.Fatalf("repeated default primary key error = %v, want %s", err, CodeDuplicateKey)
	}
	after, err := catalog.ReadOnlyQuery(ctx, "SELECT tenant,seq,n FROM generated_default WHERE tenant=?", []any{int64(2)}, CatalogQueryLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if len(duplicate.Rows) != 0 || !reflect.DeepEqual(after.Rows, [][]any{want}) {
		t.Fatalf("duplicate result = %+v, stored rows after duplicate = %#v", duplicate, after.Rows)
	}
}

func TestCatalogInsertReturnsSQLiteExpressionDefaultPrimaryKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	catalog, metadata := openCatalogSQLiteDefaultFixture(t, "generated_expression", "CREATE TABLE generated_expression (seq TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), n BIGINT NOT NULL UNIQUE, label VARCHAR(20) NULL)")
	if !reflect.DeepEqual(metadata.PrimaryKey, []string{"seq"}) || metadata.Columns[0].DefaultExpression == nil || !metadata.Columns[0].ExpressionDefault {
		t.Fatalf("expression default descriptor = %+v, want expression-generated primary key", metadata)
	}
	ctx := context.Background()
	values := []CatalogAssignment{{Name: "n", Value: int64(1)}, {Name: "label", Value: nil}}
	inserted, err := catalog.InsertRow(ctx, metadata, values)
	if err != nil {
		t.Fatalf("InsertRow with omitted expression-default key: %v", err)
	}
	if len(inserted.Rows) != 1 || len(inserted.Rows[0]) != 3 {
		t.Fatalf("inserted row = %+v, want one three-column row", inserted.Rows)
	}
	key, ok := inserted.Rows[0][0].(string)
	if !ok || len(key) != 32 {
		t.Fatalf("returned expression key = %#v, want 32 lowercase hexadecimal characters", inserted.Rows[0][0])
	}
	for _, character := range key {
		if !strings.ContainsRune("0123456789abcdef", character) {
			t.Fatalf("returned expression key = %q, want 32 lowercase hexadecimal characters", key)
		}
	}
	if !reflect.DeepEqual(inserted.Rows[0][1:], []any{int64(1), nil}) {
		t.Fatalf("inserted row values = %#v, want n=1 and SQL NULL label", inserted.Rows[0])
	}
	stored, err := catalog.ReadOnlyQuery(ctx, "SELECT seq,n,label FROM generated_expression WHERE n=?", []any{int64(1)}, CatalogQueryLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stored.Rows, inserted.Rows) {
		t.Fatalf("stored rows = %#v, want returned row %#v", stored.Rows, inserted.Rows)
	}
	duplicate, err := catalog.InsertRow(ctx, metadata, values)
	if err == nil || ErrorCode(err) != CodeDuplicateKey {
		t.Fatalf("repeated expression primary key error = %v, want %s", err, CodeDuplicateKey)
	}
	after, err := catalog.ReadOnlyQuery(ctx, "SELECT seq,n,label FROM generated_expression WHERE n=?", []any{int64(1)}, CatalogQueryLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if len(duplicate.Rows) != 0 || !reflect.DeepEqual(after.Rows, inserted.Rows) {
		t.Fatalf("duplicate result = %+v, stored rows after duplicate = %#v", duplicate, after.Rows)
	}
}

func TestCatalogInsertReturnsSQLiteDefaultOnlyCompositePrimaryKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	catalog, metadata := openCatalogSQLiteDefaultFixture(t, "generated_defaults_only", "CREATE TABLE generated_defaults_only (tenant BIGINT NOT NULL DEFAULT 2, seq VARCHAR(30) NOT NULL DEFAULT 'generated', n BIGINT NOT NULL DEFAULT 50, PRIMARY KEY(tenant,seq))")
	inserted, err := catalog.InsertRow(context.Background(), metadata, nil)
	if err != nil {
		t.Fatalf("InsertRow with database-only defaults: %v", err)
	}
	want := []any{int64(2), "generated", int64(50)}
	requireCatalogInsertedRow(t, inserted, want)
	stored, err := catalog.ReadOnlyQuery(context.Background(), "SELECT tenant,seq,n FROM generated_defaults_only", nil, CatalogQueryLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stored.Rows, [][]any{want}) {
		t.Fatalf("stored rows = %#v, want %#v", stored.Rows, [][]any{want})
	}
}
