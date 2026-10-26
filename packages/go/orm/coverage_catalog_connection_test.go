//go:build featurecoverage

// Catalog parity cases: SCH-5, SCH-6a, INT-109, INT-113, INT-114, INT-123, INT-136.

package orm_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// catalog_connection coverage: runs the two shared cases against the bench database that the feature check selected
// (ORM_FEATURE_DATABASE and ORM_FEATURE_DSN). The read case only reads; the mutation case inserts, updates and deletes
// one row of composite_account in tenant 990005 and ends in the state it started in.
const catalogTenant = 990005

func catalogConnect(t *testing.T) (string, *orm.CatalogConnection) {
	t.Helper()
	driver := os.Getenv("ORM_FEATURE_DATABASE")
	if !slices.Contains([]string{"mysql", "postgres", "sqlite"}, driver) {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check, which sets it for each coverage case")
	}
	dsn := os.Getenv("ORM_FEATURE_DSN")
	c, err := orm.ConnectCatalog(dsn)
	if err != nil {
		t.Fatalf("%s: catalog connection: %v", driver, err)
	}
	if c.Dialect() != driver {
		t.Fatalf("ORM_FEATURE_DSN selects %s, not %s", c.Dialect(), driver)
	}
	return driver, c
}

func catalogCurrentTable(
	t *testing.T,
	ctx context.Context,
	driver string,
	c *orm.CatalogConnection,
	name string,
	describeFailure string,
) (orm.CatalogTableRef, orm.CatalogTableMetadata) {
	t.Helper()
	namespace, err := c.CurrentNamespace(ctx)
	if err != nil {
		t.Fatalf("%s: current namespace: %v", driver, err)
	}
	table := orm.CatalogTableRef{Namespace: namespace, Name: name}
	metadata, err := c.DescribeTable(ctx, table)
	if err != nil {
		t.Fatalf("%s: %s: %v", driver, describeFailure, err)
	}
	return table, metadata
}

func catalogQuote(name, driver string) string {
	if driver == "mysql" {
		return "`" + name + "`"
	}
	return `"` + name + `"`
}

// Requirements: SCH-3, SCH-5, SCH-6, SCH-6a, INT-97, INT-101, INT-102, INT-103, INT-104, INT-112, INT-113, INT-114, INT-115, INT-121, INT-136, INT-117.
func TestCoverageCatalogRead(t *testing.T) {
	testcase.Start(t, testcase.Database)
	if _, err := orm.ConnectCatalog("unsupported://host/database"); err == nil {
		t.Fatal("catalog connection accepted an unsupported DSN")
	}
	missing := filepath.Join(t.TempDir(), "missing.sqlite")
	if catalog, err := orm.ConnectCatalog("sqlite://" + missing); err == nil {
		catalog.Close()
		t.Fatal("catalog connection created a missing SQLite database")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("catalog connection left a missing SQLite database at %s: %v", missing, err)
	}
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)

	author, meta := catalogCurrentTable(t, ctx, driver, c, "author", "author metadata")
	if !slices.Equal(meta.PrimaryKey, []string{"seq"}) || !meta.ReliableRowIdentity {
		t.Fatalf("%s: author key %v reliable %v", driver, meta.PrimaryKey, meta.ReliableRowIdentity)
	}
	names := make([]string, 0, len(meta.Columns))
	for _, column := range meta.Columns {
		names = append(names, column.Name)
	}
	if !slices.Contains(names, "start_dt") {
		t.Fatalf("%s: author columns %v lack start_dt", driver, names)
	}
	_, dsn := featureDatabase(t)
	metadataName := fmt.Sprintf("catalog_metadata_%d", os.Getpid())
	metadataRaw := catalogProbe(t, driver, dsn, metadataName,
		"CREATE TABLE "+metadataName+" (a BIGINT NOT NULL, b BIGINT NOT NULL, note VARCHAR(50), g BIGINT GENERATED ALWAYS AS (a+1) STORED, PRIMARY KEY (b,a))")
	metadata, err := c.DescribeTable(ctx, orm.CatalogTableRef{Namespace: meta.Table.Namespace, Name: metadataName})
	if err != nil {
		t.Fatalf("%s: qualified metadata fixture: %v", driver, err)
	}
	wantNativeTypes := []string{"bigint", "bigint", "varchar(50)", "bigint"}
	if driver == "postgres" {
		wantNativeTypes[2] = "character varying(50)"
	} else if driver == "sqlite" {
		wantNativeTypes = []string{"BIGINT", "BIGINT", "VARCHAR(50)", "BIGINT"}
	}
	gotNames := make([]string, len(metadata.Columns))
	gotNativeTypes := make([]string, len(metadata.Columns))
	for i, column := range metadata.Columns {
		gotNames[i], gotNativeTypes[i] = column.Name, column.NativeType
	}
	if !slices.Equal(gotNames, []string{"a", "b", "note", "g"}) || !slices.Equal(gotNativeTypes, wantNativeTypes) ||
		!slices.Equal(metadata.PrimaryKey, []string{"b", "a"}) || !metadata.Columns[2].Nullable ||
		!metadata.Columns[3].Generated || !metadata.ReliableRowIdentity {
		t.Fatalf("%s: qualified metadata = %+v, want native types %v, key [b a], nullable note, generated g and reliable identity", driver, metadata, wantNativeTypes)
	}
	if driver == "mysql" {
		systemView, err := c.ReadOnlyQuery(ctx, "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'information_schema' AND TABLE_NAME = 'TABLES'", nil, orm.CatalogQueryLimits{})
		if err != nil || len(systemView.Rows) != 1 || systemView.Rows[0][0] != "SYSTEM VIEW" {
			t.Fatalf("MySQL information_schema.TABLES fixture is not a SYSTEM VIEW: rows %v, error %v", systemView.Rows, err)
		}
		metadata, err := c.DescribeTable(ctx, orm.CatalogTableRef{Namespace: "information_schema", Name: "TABLES"})
		if err != nil || metadata.Kind != orm.CatalogKindView || len(metadata.Columns) == 0 || len(metadata.PrimaryKey) != 0 || metadata.ReliableRowIdentity {
			t.Fatalf("MySQL SYSTEM VIEW descriptor = %+v, error %v", metadata, err)
		}
	}

	page, err := c.TablePage(ctx, author, 3, 0)
	if err != nil {
		t.Fatalf("%s: author page: %v", driver, err)
	}
	if !slices.Equal(page.OrderBy, []string{"seq"}) || !page.HasMore {
		t.Fatalf("%s: author page order %v has_more %v", driver, page.OrderBy, page.HasMore)
	}
	if len(page.Result.Rows) != 3 {
		t.Fatalf("%s: author page rows %d, want 3", driver, len(page.Result.Rows))
	}
	if !slices.Equal(page.Result.Columns, names) {
		t.Fatalf("%s: page columns %v do not match descriptor order %v", driver, page.Result.Columns, names)
	}
	for _, bounds := range []struct {
		limit  int
		offset int64
	}{{limit: 0}, {limit: 1001}, {limit: 1, offset: 1000001}} {
		if _, err := c.TablePage(ctx, author, bounds.limit, bounds.offset); err == nil {
			t.Fatalf("%s: table page accepted limit %d offset %d", driver, bounds.limit, bounds.offset)
		}
	}
	catalogTemporalDefaultPrecisionCheck(t, driver, c)

	count, err := c.ReadOnlyQuery(ctx, "SELECT COUNT(*) FROM "+catalogQuote("user", driver), nil, orm.CatalogQueryLimits{})
	if err != nil {
		t.Fatalf("%s: user count: %v", driver, err)
	}
	if got := count.Rows[0][0]; got != int64(5000) {
		t.Fatalf("%s: user count %v, want 5000", driver, got)
	}
	if driver == "mysql" {
		_, dsn := featureDatabase(t)
		table := fmt.Sprintf("catalog_readonly_%d", os.Getpid())
		function := fmt.Sprintf("catalog_readonly_fn_%d", os.Getpid())
		raw := catalogProbe(t, driver, dsn, table, "CREATE TABLE "+table+" (n INTEGER NOT NULL)", "INSERT INTO "+table+" VALUES (7)")
		if _, err := raw.Exec("CREATE FUNCTION " + function + "() RETURNS INTEGER DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE " + table + " SET n=n+1; RETURN 1; END"); err != nil {
			t.Fatalf("%s: create read-only scope probe function: %v", driver, err)
		}
		t.Cleanup(func() {
			if _, err := raw.Exec("DROP FUNCTION IF EXISTS " + function); err != nil {
				t.Errorf("%s: drop read-only scope probe function: %v", driver, err)
			}
		})
		if _, err := c.ReadOnlyGridQuery(ctx, "SELECT "+function+"()", nil, orm.CatalogQueryLimits{}); err == nil {
			t.Fatalf("%s: database read-only scope allowed a function to write", driver)
		}
	} else {
		readOnlySQL := "SELECT current_setting('transaction_read_only')"
		wantReadOnly := any("on")
		if driver == "sqlite" {
			readOnlySQL = "SELECT query_only FROM pragma_query_only"
			wantReadOnly = int64(1)
		}
		readOnlyState, err := c.ReadOnlyQuery(ctx, readOnlySQL, nil, orm.CatalogQueryLimits{})
		if err != nil || len(readOnlyState.Rows) != 1 || readOnlyState.Rows[0][0] != wantReadOnly {
			t.Fatalf("%s: database read-only state = %v, error %v, want %v", driver, readOnlyState.Rows, err, wantReadOnly)
		}
	}
	for _, limits := range []orm.CatalogQueryLimits{
		{MaxRows: 1, MaxBytes: 1024},
		{MaxRows: 2, MaxBytes: 2},
	} {
		_, err := c.ReadOnlyGridQuery(ctx, "SELECT 'abc' AS value UNION ALL SELECT 'def'", nil, limits)
		var coded *ir.Error
		if !errors.As(err, &coded) || coded.Code != orm.CodeCatalogLimit {
			t.Fatalf("%s: grid query with limits %+v returned %v, want coded CATALOG_LIMIT", driver, limits, err)
		}
	}
	_, err = c.ReadOnlyQuery(ctx, "UPDATE "+catalogQuote("user", driver)+" SET name = name WHERE seq = 1", nil, orm.CatalogQueryLimits{})
	if err == nil || !strings.Contains(err.Error(), "QUERY_READ_ONLY") {
		t.Fatalf("%s: a write through ReadOnlyQuery returned %v, want QUERY_READ_ONLY", driver, err)
	}
	for _, sql := range []string{"SELECT ';' AS value /* ; */", "WITH values_cte AS (SELECT 1 AS value) SELECT value FROM values_cte"} {
		if _, err := c.ReadOnlyGridQuery(ctx, sql, nil, orm.CatalogQueryLimits{}); err != nil {
			t.Fatalf("%s: supported read-only grid query %q: %v", driver, sql, err)
		}
	}
	readOnlyRefusals := []string{
		"COMMIT",
		"CALL missing_catalog_procedure()",
		"SELECT 1 INTO catalog_forbidden",
		"SELECT 1 FOR UPDATE",
		"SELECT 1; SELECT 2",
		"WITH changed AS (UPDATE user SET name=name WHERE seq=1 RETURNING seq) SELECT seq FROM changed",
	}
	if driver == "postgres" {
		readOnlyRefusals = append(readOnlyRefusals,
			"SELECT "+strings.TrimSuffix(strings.Repeat("1 UNION ALL ", 200), " UNION ALL "),
			"SELECT "+strings.TrimSuffix(strings.Repeat("1+", 200), "+"),
		)
	}
	for _, sql := range readOnlyRefusals {
		_, err := c.ReadOnlyGridQuery(ctx, sql, nil, orm.CatalogQueryLimits{})
		var coded *ir.Error
		if !errors.As(err, &coded) || coded.Code != orm.CodeQueryReadOnly {
			t.Fatalf("%s: read-only grid query %q returned %v, want QUERY_READ_ONLY", driver, sql, err)
		}
	}
	catalogGridCellsCheck(t, ctx, driver, c)
}

// Requirements: INT-101, INT-117.
func catalogTemporalDefaultPrecisionCheck(t *testing.T, driver string, c *orm.CatalogConnection) {
	t.Helper()
	_, dsn := featureDatabase(t)
	table := fmt.Sprintf("catalog_temporal_precision_%d", time.Now().UnixNano())
	columns := "id BIGINT NOT NULL PRIMARY KEY, t0 TIME NULL, dt0 DATETIME NULL, t3 TIME(3) NULL, dt3 DATETIME(3) NULL"
	if driver == "sqlite" {
		columns = `id INTEGER NOT NULL PRIMARY KEY,
			t0 TIME NOT NULL CHECK (length("t0") = 8 AND "t0" IS time("t0") AND "t0" < '24:00:00'),
			dt0 DATETIME NOT NULL CHECK (length("dt0") = 19 AND "dt0" IS datetime("dt0") AND substr("dt0", 12, 2) < '24'),
			t3 TIME NOT NULL CHECK (length("t3") = 12 AND substr("t3", 1, 8) IS time(substr("t3", 1, 8)) AND "t3" < '24:00:00' AND substr("t3", 9, 1) = '.' AND substr("t3", 10) GLOB '[0-9][0-9][0-9]'),
			dt3 DATETIME NOT NULL CHECK (length("dt3") = 23 AND substr("dt3", 1, 19) IS datetime(substr("dt3", 1, 19)) AND substr("dt3", 12, 2) < '24' AND substr("dt3", 20, 1) = '.' AND substr("dt3", 21) GLOB '[0-9][0-9][0-9]')`
	} else if driver == "postgres" {
		columns = "id BIGINT NOT NULL PRIMARY KEY, t0 TIME WITHOUT TIME ZONE NULL, dt0 TIMESTAMP WITHOUT TIME ZONE NULL, t3 TIME(3) WITHOUT TIME ZONE NULL, dt3 TIMESTAMP(3) WITHOUT TIME ZONE NULL"
	}
	raw := catalogProbe(t, driver, dsn, table, "CREATE TABLE "+table+" ("+columns+")")
	if driver == "mysql" {
		_, err := raw.Exec("CREATE TABLE " + table + "_invalid (id BIGINT PRIMARY KEY, t TIME(7))")
		if err == nil {
			if _, dropErr := raw.Exec("DROP TABLE " + table + "_invalid"); dropErr != nil {
				t.Errorf("%s: drop unexpectedly accepted precision table: %v", driver, dropErr)
			}
			t.Fatalf("%s: accepted temporal precision 7", driver)
		}
		if !strings.Contains(strings.ToLower(err.Error()), "precision") {
			t.Fatalf("%s: precision 7 failed for another reason: %v", driver, err)
		}
	}
	namespace, err := c.CurrentNamespace(context.Background())
	if err != nil {
		t.Fatalf("%s: temporal precision namespace: %v", driver, err)
	}
	metadata, err := c.DescribeTable(context.Background(), orm.CatalogTableRef{Namespace: namespace, Name: table})
	if err != nil {
		t.Fatalf("%s: temporal precision metadata: %v", driver, err)
	}
	t0Value, dt0Value, t3Value, dt3Value := catalogTemporalWriteValues(driver)
	invalidT3, invalidDT3 := any(time.Date(2026, time.January, 2, 12, 34, 56, 123400000, time.UTC)),
		time.Date(2026, time.January, 2, 3, 4, 5, 123400000, time.UTC)
	if driver == "sqlite" {
		invalidT3, invalidDT3 = "12:34:56.1234", "2026-01-02 03:04:05.1234"
	}
	_, err = c.InsertRow(context.Background(), metadata, []orm.CatalogAssignment{
		{Name: "id", Value: int64(2)},
		{Name: "t0", Value: t0Value},
		{Name: "dt0", Value: dt0Value},
		{Name: "t3", Value: invalidT3},
		{Name: "dt3", Value: invalidDT3},
	})
	if err == nil {
		t.Fatalf("%s: typed temporal catalog insert accepted values beyond declared precision", driver)
	}
	unchanged, err := c.ReadOnlyQuery(context.Background(), "SELECT COUNT(*) FROM "+catalogQuote(table, driver)+" WHERE id=2", nil, orm.CatalogQueryLimits{})
	if err != nil || unchanged.Rows[0][0] != int64(0) {
		t.Fatalf("%s: rejected typed temporal insert left a row: rows %v, error %v", driver, unchanged.Rows, err)
	}
	inserted, err := c.InsertRow(context.Background(), metadata, []orm.CatalogAssignment{
		{Name: "id", Value: int64(1)},
		{Name: "t0", Value: t0Value},
		{Name: "dt0", Value: dt0Value},
		{Name: "t3", Value: t3Value},
		{Name: "dt3", Value: dt3Value},
	})
	if err != nil || len(inserted.Rows) != 1 {
		t.Fatalf("%s: typed temporal catalog insert rows %v, error %v", driver, inserted.Rows, err)
	}
	got := make([]int, 4)
	for i, name := range []string{"t0", "dt0", "t3", "dt3"} {
		column := slices.IndexFunc(metadata.Columns, func(column orm.CatalogColumn) bool { return column.Name == name })
		value := inserted.Rows[0][column]
		if driver == "sqlite" {
			text, ok := value.(string)
			want := []string{"12:34:56", "2026-01-02 03:04:05", "12:34:56.123", "2026-01-02 03:04:05.123"}[i]
			if !ok || text != want {
				t.Fatalf("sqlite: typed temporal Catalog insert %s = %T(%v), want %q", name, value, value, want)
			}
			if dot := strings.IndexByte(text, '.'); dot >= 0 {
				got[i] = len(text) - dot - 1
			}
			continue
		}
		timestamp, ok := value.(time.Time)
		if !ok {
			t.Fatalf("%s: %s has type %T, want time.Time", driver, name, value)
		}
		got[i] = timestamp.Nanosecond()
	}
	want := []int{0, 0, 123000000, 123000000}
	if driver == "postgres" {
		want[0], want[1] = 123456000, 123456000
	} else if driver == "sqlite" {
		want[2], want[3] = 3, 3
	}
	if !slices.Equal(got, want) {
		t.Fatalf("%s: temporal precision nanos %v, want %v", driver, got, want)
	}
}

func catalogTemporalWriteValues(driver string) (any, any, any, any) {
	if driver == "sqlite" {
		return "12:34:56", "2026-01-02 03:04:05", "12:34:56.123", "2026-01-02 03:04:05.123"
	}
	defaultNanos := 0
	if driver == "postgres" {
		defaultNanos = 123456000
	}
	return time.Date(2026, time.January, 2, 12, 34, 56, defaultNanos, time.UTC),
		time.Date(2026, time.January, 2, 3, 4, 5, defaultNanos, time.UTC),
		time.Date(2026, time.January, 2, 12, 34, 56, 123000000, time.UTC),
		time.Date(2026, time.January, 2, 3, 4, 5, 123000000, time.UTC)
}

// Requirements: INT-115.
func TestCoverageCatalogReadOnlyQueryBudgets(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)

	rowsSQL := "SELECT 'alpha' AS value UNION ALL SELECT 'beta' AS value"
	_, err := c.ReadOnlyQuery(ctx, rowsSQL, nil, orm.CatalogQueryLimits{MaxRows: 1, MaxBytes: 128})
	var coded *ir.Error
	if !errors.As(err, &coded) || coded.Code != orm.CodeCatalogLimit {
		t.Fatalf("%s: plain query with a 1-row limit returned %v, want CATALOG_LIMIT", driver, err)
	}
	result, err := c.ReadOnlyQuery(ctx, rowsSQL, nil, orm.CatalogQueryLimits{MaxRows: 2, MaxBytes: 128})
	if err != nil {
		t.Fatalf("%s: plain query at its exact 2-row limit: %v", driver, err)
	}
	wantRows := [][]any{{"alpha"}, {"beta"}}
	if !reflect.DeepEqual(result.Rows, wantRows) {
		t.Fatalf("%s: plain rows at exact row limit = %#v, want %#v", driver, result.Rows, wantRows)
	}

	textSQL := "SELECT 'abc' AS value"
	_, err = c.ReadOnlyQuery(ctx, textSQL, nil, orm.CatalogQueryLimits{MaxRows: 2, MaxBytes: 2})
	coded = nil
	if !errors.As(err, &coded) || coded.Code != orm.CodeCatalogLimit {
		t.Fatalf("%s: plain query with a 2-byte limit returned %v, want CATALOG_LIMIT", driver, err)
	}
	result, err = c.ReadOnlyQuery(ctx, textSQL, nil, orm.CatalogQueryLimits{MaxRows: 2, MaxBytes: 3})
	if err != nil {
		t.Fatalf("%s: plain query at its exact 3-byte limit: %v", driver, err)
	}
	if !reflect.DeepEqual(result.Rows, [][]any{{"abc"}}) {
		t.Fatalf("%s: plain row at exact byte limit = %#v, want [[\"abc\"]]", driver, result.Rows)
	}
}

// Requirements: SCH-6a.
func TestCoverageCatalogGridColumnAndRowOrder(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)

	query := "SELECT 1 AS seq, 'a' AS label UNION ALL SELECT 2, 'b' UNION ALL SELECT 3, 'c' UNION ALL SELECT 4, 'd' ORDER BY seq DESC"
	result, err := c.ReadOnlyGridQuery(ctx, query, nil, orm.CatalogQueryLimits{})
	if err != nil {
		t.Fatalf("%s: grid query: %v", driver, err)
	}
	wantColumns := []string{"seq", "label"}
	if !reflect.DeepEqual(result.Columns, wantColumns) {
		t.Fatalf("%s: grid columns %v, want %v", driver, result.Columns, wantColumns)
	}
	wantRows := [][]orm.CatalogGridCell{
		{{Kind: orm.CatalogGridInteger, Value: int64(4)}, {Kind: orm.CatalogGridText, Value: "d"}},
		{{Kind: orm.CatalogGridInteger, Value: int64(3)}, {Kind: orm.CatalogGridText, Value: "c"}},
		{{Kind: orm.CatalogGridInteger, Value: int64(2)}, {Kind: orm.CatalogGridText, Value: "b"}},
		{{Kind: orm.CatalogGridInteger, Value: int64(1)}, {Kind: orm.CatalogGridText, Value: "a"}},
	}
	if !reflect.DeepEqual(result.Rows, wantRows) {
		t.Fatalf("%s: grid rows\n got %#v\nwant %#v", driver, result.Rows, wantRows)
	}
}

// Requirements: SCH-5, SCH-6a, DBS-113, INT-34, INT-106, INT-108, INT-109, INT-110, INT-111.
func TestCoverageCatalogRowMutation(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)

	account := catalogQuote("composite_account", driver)
	countSQL := "SELECT COUNT(*) FROM " + account + " WHERE tenant_id = 990005"
	tenantRows := func() any {
		result, err := c.ReadOnlyQuery(ctx, countSQL, nil, orm.CatalogQueryLimits{})
		if err != nil {
			t.Fatalf("%s: tenant count: %v", driver, err)
		}
		return result.Rows[0][0]
	}
	if got := tenantRows(); got != int64(0) {
		t.Fatalf("%s: a composite_account row of tenant %d already exists: %v", driver, catalogTenant, got)
	}

	namespace, err := c.CurrentNamespace(ctx)
	if err != nil {
		t.Fatalf("%s: current namespace: %v", driver, err)
	}
	table := orm.CatalogTableRef{Namespace: namespace, Name: "composite_account"}
	meta, err := c.DescribeTable(ctx, table)
	if err != nil {
		t.Fatalf("%s: composite_account metadata: %v", driver, err)
	}

	inserted, err := c.InsertRow(ctx, meta, []orm.CatalogAssignment{
		{Name: "tenant_id", Value: int64(catalogTenant)},
		{Name: "account_id", Value: int64(1)},
		{Name: "name", Value: "catalog"},
	})
	if err != nil || len(inserted.Rows) != 1 {
		t.Fatalf("%s: insert: rows %v, err %v", driver, inserted, err)
	}

	snapshot := catalogFindTenantRow(t, ctx, c, table, driver, "catalog")
	if !slices.Equal(meta.PrimaryKey, []string{"tenant_id", "account_id"}) {
		t.Fatalf("composite_account primary key order = %v", meta.PrimaryKey)
	}
	originalRevision := snapshot.Revision()
	for _, values := range [][]orm.CatalogAssignment{
		{{Name: "name", Value: "first"}, {Name: "name", Value: "second"}},
		{{Name: "absent", Value: "value"}},
		{{Name: "name", Value: nil}},
		{{Name: "name", Value: strings.Repeat("x", 192)}},
	} {
		if _, err := c.UpdateRow(ctx, snapshot, values); orm.ErrorCode(err) != orm.CodeRowUpdateInvalid {
			t.Fatalf("invalid update %v error = %v, want %s", values, err, orm.CodeRowUpdateInvalid)
		}
	}
	if got := catalogFindTenantRow(t, ctx, c, table, driver, "catalog").Revision(); got != originalRevision {
		t.Fatalf("invalid assignments changed the row revision: got %s, want %s", got, originalRevision)
	}
	page, err := c.TablePage(ctx, table, 1000, 0)
	if err != nil {
		t.Fatalf("page before update: %v", err)
	}
	page.Result.Columns[0].Name = "changed"
	if _, err := orm.CatalogSnapshotFromPage(page, 0); orm.ErrorCode(err) != orm.CodeRowSnapshotInvalid {
		t.Fatalf("snapshot with a projection that differs from the descriptor error = %v, want %s", err, orm.CodeRowSnapshotInvalid)
	}
	updated, err := c.UpdateRow(ctx, snapshot, []orm.CatalogAssignment{{Name: "name", Value: "catalog-updated"}})
	if err != nil || len(updated.Rows) != 1 {
		t.Fatalf("%s: update: rows %v, err %v", driver, updated, err)
	}
	if snapshot.Revision() != originalRevision {
		t.Fatalf("captured row revision changed after the source page was updated")
	}
	if _, err := c.UpdateRow(ctx, snapshot, []orm.CatalogAssignment{{Name: "name", Value: "stale"}}); orm.ErrorCode(err) != orm.CodeRowConflict {
		t.Fatalf("stale update error = %v, want %s", err, orm.CodeRowConflict)
	}
	catalogFindTenantRow(t, ctx, c, table, driver, "catalog-updated")

	snapshot = catalogFindTenantRow(t, ctx, c, table, driver, "catalog-updated")
	deleted, err := c.DeleteRow(ctx, snapshot)
	if err != nil || deleted != 1 {
		t.Fatalf("%s: delete: %d rows, err %v", driver, deleted, err)
	}
	if got := tenantRows(); got != int64(0) {
		t.Fatalf("%s: rows left after delete: %v", driver, got)
	}
	catalogGeneratedKeyMutations(t, ctx, c, driver)
}

// Requirements: DBS-113, INT-34.
func catalogGeneratedKeyMutations(t *testing.T, ctx context.Context, c *orm.CatalogConnection, driver string) {
	dsn := os.Getenv("ORM_FEATURE_DSN")
	engine := ""
	if driver == "mysql" {
		engine = " ENGINE=InnoDB"
	}

	catalogProbe(t, driver, dsn, "catalog_required_identity",
		"CREATE TABLE catalog_required_identity (id BIGINT NOT NULL PRIMARY KEY, payload TEXT NOT NULL)"+engine)
	requiredTable := orm.CatalogTableRef{Namespace: mustCatalogNamespace(t, ctx, c), Name: "catalog_required_identity"}
	requiredMetadata, err := c.DescribeTable(ctx, requiredTable)
	if err != nil {
		t.Fatalf("%s: required-key descriptor: %v", driver, err)
	}
	_, err = c.InsertRow(ctx, requiredMetadata, []orm.CatalogAssignment{{Name: "payload", Value: "missing-key"}})
	if orm.ErrorCode(err) != "ROW_INSERT_IDENTITY_REQUIRED" {
		t.Fatalf("%s: insert without a supplied or generated key error = %v, want ROW_INSERT_IDENTITY_REQUIRED", driver, err)
	}
	requiredPage, err := c.TablePage(ctx, requiredTable, 2, 0)
	if err != nil || len(requiredPage.Result.Rows) != 0 {
		t.Fatalf("%s: rows after rejected keyless insert = %+v, err %v", driver, requiredPage.Result.Rows, err)
	}

	autoKeyType := "INTEGER PRIMARY KEY AUTOINCREMENT"
	switch driver {
	case "mysql":
		autoKeyType = "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY"
	case "postgres":
		autoKeyType = "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
	}
	catalogProbe(t, driver, dsn, "catalog_generated", "CREATE TABLE catalog_generated (id "+autoKeyType+", payload TEXT NOT NULL)"+engine)
	autoTable := orm.CatalogTableRef{Namespace: mustCatalogNamespace(t, ctx, c), Name: "catalog_generated"}
	autoMetadata, err := c.DescribeTable(ctx, autoTable)
	if err != nil {
		t.Fatalf("%s: generated-key descriptor: %v", driver, err)
	}
	if !slices.Equal(autoMetadata.PrimaryKey, []string{"id"}) || !autoMetadata.Columns[0].AutomaticKey || autoMetadata.Columns[0].DefaultExpression != nil {
		t.Fatalf("%s: generated-key metadata = %+v, want automatic id with no default expression", driver, autoMetadata)
	}
	auto, err := c.InsertRow(ctx, autoMetadata, []orm.CatalogAssignment{{Name: "payload", Value: "generated"}})
	if err != nil || len(auto.Rows) != 1 || len(auto.Rows[0]) != 2 || auto.Rows[0][0] != int64(1) || auto.Rows[0][1] != "generated" {
		t.Fatalf("%s: automatic-key insert = %+v, err %v", driver, auto, err)
	}
	autoPage, err := c.TablePage(ctx, autoTable, 2, 0)
	if err != nil || !reflect.DeepEqual(autoPage.Result.Rows, auto.Rows) {
		t.Fatalf("%s: automatic-key stored row = %+v, err %v; returned %+v", driver, autoPage.Result.Rows, err, auto.Rows)
	}

	catalogProbe(t, driver, dsn, "catalog_generated_default",
		"CREATE TABLE catalog_generated_default (tenant BIGINT NOT NULL, seq VARCHAR(30) NOT NULL DEFAULT 'generated', n BIGINT NOT NULL, PRIMARY KEY(tenant,seq))"+engine)
	defaultTable := orm.CatalogTableRef{Namespace: autoTable.Namespace, Name: "catalog_generated_default"}
	defaultMetadata, err := c.DescribeTable(ctx, defaultTable)
	if err != nil {
		t.Fatalf("%s: literal-default descriptor: %v", driver, err)
	}
	if !slices.Equal(defaultMetadata.PrimaryKey, []string{"tenant", "seq"}) || defaultMetadata.Columns[1].DefaultExpression == nil || defaultMetadata.Columns[1].AutomaticKey {
		t.Fatalf("%s: literal-default metadata = %+v", driver, defaultMetadata)
	}
	literal, err := c.InsertRow(ctx, defaultMetadata, []orm.CatalogAssignment{{Name: "tenant", Value: int64(2)}, {Name: "n", Value: int64(50)}})
	literalWant := []any{int64(2), "generated", int64(50)}
	if err != nil || len(literal.Rows) != 1 || !reflect.DeepEqual(literal.Rows[0], literalWant) {
		t.Fatalf("%s: literal-default insert = %+v, err %v", driver, literal, err)
	}
	literalPage, err := c.TablePage(ctx, defaultTable, 2, 0)
	if err != nil || !reflect.DeepEqual(literalPage.Result.Rows, literal.Rows) {
		t.Fatalf("%s: literal-default stored row = %+v, err %v; returned %+v", driver, literalPage.Result.Rows, err, literal.Rows)
	}
	if _, err := c.InsertRow(ctx, defaultMetadata, []orm.CatalogAssignment{{Name: "tenant", Value: int64(2)}, {Name: "n", Value: int64(51)}}); orm.ErrorCode(err) != orm.CodeDuplicateKey {
		t.Fatalf("%s: repeated literal-default key error = %v, want %s", driver, err, orm.CodeDuplicateKey)
	}
	literalAfter, err := c.TablePage(ctx, defaultTable, 2, 0)
	if err != nil || !reflect.DeepEqual(literalAfter.Result.Rows, literal.Rows) {
		t.Fatalf("%s: literal-default state after duplicate = %+v, err %v", driver, literalAfter.Result.Rows, err)
	}

	expression := "lower(hex(randomblob(16)))"
	keyType := "TEXT"
	switch driver {
	case "mysql":
		expression, keyType = "UUID()", "VARCHAR(36)"
	case "postgres":
		expression, keyType = "gen_random_uuid()::text", "VARCHAR(36)"
	}
	catalogProbe(t, driver, dsn, "catalog_generated_expression",
		"CREATE TABLE catalog_generated_expression (seq "+keyType+" NOT NULL PRIMARY KEY DEFAULT ("+expression+"), n BIGINT NOT NULL UNIQUE, label VARCHAR(20) NULL)"+engine)
	expressionTable := orm.CatalogTableRef{Namespace: autoTable.Namespace, Name: "catalog_generated_expression"}
	expressionMetadata, err := c.DescribeTable(ctx, expressionTable)
	if err != nil {
		t.Fatalf("%s: expression-default descriptor: %v", driver, err)
	}
	if !slices.Equal(expressionMetadata.PrimaryKey, []string{"seq"}) || expressionMetadata.Columns[0].DefaultExpression == nil || !expressionMetadata.Columns[0].ExpressionDefault {
		t.Fatalf("%s: expression-default metadata = %+v", driver, expressionMetadata)
	}
	expressionValues := []orm.CatalogAssignment{{Name: "n", Value: int64(1)}, {Name: "label", Value: nil}}
	expressionInsert, err := c.InsertRow(ctx, expressionMetadata, expressionValues)
	if err != nil || len(expressionInsert.Rows) != 1 || len(expressionInsert.Rows[0]) != 3 {
		t.Fatalf("%s: expression-default insert = %+v, err %v", driver, expressionInsert, err)
	}
	key, ok := expressionInsert.Rows[0][0].(string)
	wantLength := 32
	if driver != "sqlite" {
		wantLength = 36
	}
	if !ok || !validCatalogGeneratedKey(driver, key, wantLength) || !reflect.DeepEqual(expressionInsert.Rows[0][1:], []any{int64(1), nil}) {
		t.Fatalf("%s: expression-default returned row = %#v, want formatted database key, n=1, NULL", driver, expressionInsert.Rows[0])
	}
	expressionPage, err := c.TablePage(ctx, expressionTable, 2, 0)
	if err != nil || !reflect.DeepEqual(expressionPage.Result.Rows, expressionInsert.Rows) {
		t.Fatalf("%s: expression-default stored row = %+v, err %v; returned %+v", driver, expressionPage.Result.Rows, err, expressionInsert.Rows)
	}
	_, duplicateErr := c.InsertRow(ctx, expressionMetadata, expressionValues)
	wantDuplicateCode := orm.CodeDuplicateKey
	if driver == "mysql" {
		wantDuplicateCode = "ROW_IDENTITY_AMBIGUOUS"
	}
	if orm.ErrorCode(duplicateErr) != wantDuplicateCode {
		t.Fatalf("%s: repeated expression locator error = %v, want %s", driver, duplicateErr, wantDuplicateCode)
	}
	expressionAfter, err := c.TablePage(ctx, expressionTable, 2, 0)
	if err != nil || !reflect.DeepEqual(expressionAfter.Result.Rows, expressionInsert.Rows) {
		t.Fatalf("%s: expression-default state after duplicate = %+v, err %v", driver, expressionAfter.Result.Rows, err)
	}
}

func mustCatalogNamespace(t *testing.T, ctx context.Context, c *orm.CatalogConnection) string {
	t.Helper()
	namespace, err := c.CurrentNamespace(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return namespace
}

func validCatalogGeneratedKey(driver, value string, length int) bool {
	if len(value) != length {
		return false
	}
	for i, character := range value {
		if driver != "sqlite" && (i == 8 || i == 13 || i == 18 || i == 23) {
			if character != '-' {
				return false
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}

// catalogFindTenantRow reads the page of composite_account, finds the one row of the test tenant and returns its snapshot
// with its name, which must be wantName.
func catalogFindTenantRow(t *testing.T, ctx context.Context, c *orm.CatalogConnection, table orm.CatalogTableRef, driver, wantName string) orm.CatalogRowSnapshot {
	t.Helper()
	page, err := c.TablePage(ctx, table, 1000, 0)
	if err != nil {
		t.Fatalf("%s: composite_account page: %v", driver, err)
	}
	if page.HasMore {
		t.Fatalf("%s: composite_account has more rows than one page", driver)
	}
	found := -1
	for i, row := range page.Result.Rows {
		if page.Column(row, "tenant_id") == int64(catalogTenant) {
			if found >= 0 {
				t.Fatalf("%s: more than one row of tenant %d", driver, catalogTenant)
			}
			found = i
		}
	}
	if found < 0 {
		t.Fatalf("%s: no row of tenant %d", driver, catalogTenant)
	}
	if got := page.Column(page.Result.Rows[found], "name"); got != wantName {
		t.Fatalf("%s: name %v, want %s", driver, got, wantName)
	}
	snapshot, err := orm.CatalogSnapshotFromPage(page, found)
	if err != nil {
		t.Fatalf("%s: row snapshot: %v", driver, err)
	}
	return snapshot
}

// catalogGridCells returns the query of one row of typed grid cells for the dialect and the cells it must read back
// (docs/spec/interfaces.md, "Rust native grid query specification"): float cells hold their IEEE-754 bits, UNSIGNED
// integers are unsigned cells, DECIMAL is plain text, and date, time and datetime cells hold dbspec text.
func catalogGridCells(driver string) (string, []orm.CatalogGridCell) {
	cell := func(kind orm.CatalogGridKind, value any) orm.CatalogGridCell {
		return orm.CatalogGridCell{Kind: kind, Value: value}
	}
	switch driver {
	case "mysql":
		return "SELECT CAST(1.5 AS FLOAT) AS f, CAST(1.5 AS DOUBLE) AS d, CAST(18446744073709551615 AS UNSIGNED) AS u, " +
				"CAST(-7 AS SIGNED) AS i, CAST(1.50 AS DECIMAL(10,2)) AS dv, CAST('ab' AS BINARY) AS b, CAST(NULL AS DATE) AS n, " +
				"CAST('2024-02-29' AS DATE) AS dt, CAST('12:34:56.5' AS TIME(6)) AS tm, " +
				"CAST('2024-02-29 01:02:03.5' AS DATETIME(6)) AS dtm",
			append([]orm.CatalogGridCell{
				cell(orm.CatalogGridFloat32, uint32(0x3FC00000)),
				cell(orm.CatalogGridFloat64, uint64(0x3FF8000000000000)),
				cell(orm.CatalogGridUnsigned, uint64(1<<64-1)),
				cell(orm.CatalogGridInteger, int64(-7)),
				cell(orm.CatalogGridDecimal, "1.50"),
			}, catalogGridSharedTailCells()...)
	case "postgres":
		return "SELECT 1.5::real AS f, 1.5::double precision AS d, 'NaN'::double precision AS nan, 'NaN'::real AS nanf, " +
				"9223372036854775807::bigint AS i, 2.50::numeric(10,2) AS dec, '\\x6162'::bytea AS b, NULL::date AS n, " +
				"'2024-02-29'::date AS dt, '12:34:56.5'::time AS tm, '2024-02-29 01:02:03.5'::timestamp AS dtm",
			append([]orm.CatalogGridCell{
				cell(orm.CatalogGridFloat32, uint32(0x3FC00000)),
				cell(orm.CatalogGridFloat64, uint64(0x3FF8000000000000)),
				cell(orm.CatalogGridFloat64, uint64(0x7FF8000000000000)),
				cell(orm.CatalogGridFloat32, uint32(0x7FC00000)),
				cell(orm.CatalogGridInteger, int64(9223372036854775807)),
				cell(orm.CatalogGridDecimal, "2.50"),
			}, catalogGridSharedTailCells()...)
	default:
		return "SELECT 1.5 AS d, 7 AS i, 'x' AS t, X'6162' AS b, NULL AS n",
			[]orm.CatalogGridCell{
				cell(orm.CatalogGridFloat64, uint64(0x3FF8000000000000)),
				cell(orm.CatalogGridInteger, int64(7)),
				cell(orm.CatalogGridText, "x"),
				cell(orm.CatalogGridBinary, []byte("ab")),
				cell(orm.CatalogGridNull, nil),
			}
	}
}

func catalogGridSharedTailCells() []orm.CatalogGridCell {
	return []orm.CatalogGridCell{
		{Kind: orm.CatalogGridBinary, Value: []byte("ab")},
		{Kind: orm.CatalogGridNull, Value: nil},
		{Kind: orm.CatalogGridDate, Value: "2024-02-29"},
		{Kind: orm.CatalogGridTime, Value: "12:34:56.500000"},
		{Kind: orm.CatalogGridDateTime, Value: "2024-02-29 01:02:03.500000"},
	}
}

// catalogGridRefused returns the queries that the grid refuses with CATALOG_VALUE in the dialect.
func catalogGridRefused(driver string) []string {
	switch driver {
	case "mysql":
		return []string{"SELECT CAST('-01:00:00' AS TIME(6)) AS t", "SELECT CAST('24:00:00' AS TIME(6)) AS t"}
	case "postgres":
		return []string{
			"SELECT '2024-01-01 00:00:00+00'::timestamptz AS t",
			"SELECT '00:00:00+00'::timetz AS t",
			"SELECT '24:00:00'::time AS t",
			"SELECT 'infinity'::date AS t",
		}
	default:
		return nil
	}
}

// catalogGridCellsCheck is the shared grid assertion body used by both the selected catalog_read case and its standalone owner test.
func catalogGridCellsCheck(t *testing.T, ctx context.Context, driver string, c *orm.CatalogConnection) {
	t.Helper()
	sql, want := catalogGridCells(driver)
	result, err := c.ReadOnlyGridQuery(ctx, sql, nil, orm.CatalogQueryLimits{})
	if err != nil {
		t.Fatalf("%s: grid query: %v", driver, err)
	}
	if len(result.Rows) != 1 {
		t.Fatalf("%s: grid rows %d, want 1", driver, len(result.Rows))
	}
	if !reflect.DeepEqual(result.Rows[0], want) {
		t.Fatalf("%s: grid cells\n got %#v\nwant %#v", driver, result.Rows[0], want)
	}
	for _, refused := range catalogGridRefused(driver) {
		_, err := c.ReadOnlyGridQuery(ctx, refused, nil, orm.CatalogQueryLimits{})
		if err == nil || !strings.Contains(err.Error(), "CATALOG_VALUE") {
			t.Fatalf("%s: %s returned %v, want CATALOG_VALUE", driver, refused, err)
		}
	}
}

// Requirements: SCH-3, SCH-6a, INT-103.
func TestCoverageCatalogGridCells(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)
	catalogGridCellsCheck(t, ctx, driver, c)
}

// catalogProbe creates a table of the feature database for the cases of declared types and drops it at the end of the test.
func catalogProbe(t *testing.T, driver, dsn, table, create string, rows ...string) *sql.DB {
	t.Helper()
	raw := openRaw(t, driver, dsn)
	t.Cleanup(func() {
		if _, err := raw.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			t.Errorf("%s: drop %s: %v", driver, table, err)
		}
		if err := raw.Close(); err != nil {
			t.Errorf("%s: close: %v", driver, err)
		}
	})
	if _, err := raw.Exec("DROP TABLE IF EXISTS " + table); err != nil {
		t.Fatalf("%s: drop %s: %v", driver, table, err)
	}
	if _, err := raw.Exec(create); err != nil {
		t.Fatalf("%s: create %s: %v", driver, table, err)
	}
	for _, row := range rows {
		if _, err := raw.Exec(row); err != nil {
			t.Fatalf("%s: insert into %s: %v", driver, table, err)
		}
	}
	return raw
}

// Requirements: SCH-6a.
func TestCoverageCatalogGridDeclared(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)
	if driver != "sqlite" {
		t.Fatalf("catalog grid declared-type cases require SQLite, got %s", driver)
	}
	_, dsn := featureDatabase(t)
	catalogProbe(t, driver, dsn, "grid_probe",
		"CREATE TABLE grid_probe (seq INTEGER PRIMARY KEY, d DATE, dt DATETIME, n DATETIME, b DATETIME)",
		"INSERT INTO grid_probe VALUES (1, '2026-10-22', '2026-10-22 01:02:03.5', 42, X'6162')",
		"INSERT INTO grid_probe VALUES (2, NULL, 'abc', 1.5, NULL)")

	// A declared DATE or DATETIME column keeps the stored text, as the Rust grid does, and an integer or blob keeps its storage class.
	result, err := c.ReadOnlyGridQuery(ctx, "SELECT d, dt, n, b, d FROM grid_probe ORDER BY seq", nil, orm.CatalogQueryLimits{})
	if err != nil {
		t.Fatalf("%s: declared grid query: %v", driver, err)
	}
	wantColumns := []string{"d", "dt", "n", "b", "d"}
	if !reflect.DeepEqual(result.Columns, wantColumns) {
		t.Fatalf("%s: columns %v, want %v", driver, result.Columns, wantColumns)
	}
	want := [][]orm.CatalogGridCell{
		{
			{Kind: orm.CatalogGridText, Value: "2026-10-22"},
			{Kind: orm.CatalogGridText, Value: "2026-10-22 01:02:03.5"},
			{Kind: orm.CatalogGridInteger, Value: int64(42)},
			{Kind: orm.CatalogGridBinary, Value: []byte("ab")},
			{Kind: orm.CatalogGridText, Value: "2026-10-22"},
		},
		{
			{Kind: orm.CatalogGridNull, Value: nil},
			{Kind: orm.CatalogGridText, Value: "abc"},
			{Kind: orm.CatalogGridFloat64, Value: uint64(0x3FF8000000000000)},
			{Kind: orm.CatalogGridNull, Value: nil},
			{Kind: orm.CatalogGridNull, Value: nil},
		},
	}
	if !reflect.DeepEqual(result.Rows, want) {
		t.Fatalf("%s: declared cells\n got %#v\nwant %#v", driver, result.Rows, want)
	}
}

// Requirements: SCH-6a.
func TestCoverageCatalogGridTimestamp(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)
	_, dsn := featureDatabase(t)

	var refused []string
	switch driver {
	case "mysql":
		catalogProbe(t, driver, dsn, "grid_probe",
			"CREATE TABLE grid_probe (seq INT PRIMARY KEY, ts TIMESTAMP NULL)",
			"INSERT INTO grid_probe VALUES (1, '2026-10-22 01:02:03')",
			"INSERT INTO grid_probe VALUES (2, NULL)")
		refused = []string{"SELECT ts FROM grid_probe WHERE seq = 1"}
		// A NULL timestamp is a null cell, not a refusal.
		result, err := c.ReadOnlyGridQuery(ctx, "SELECT ts FROM grid_probe WHERE seq = 2", nil, orm.CatalogQueryLimits{})
		if err != nil {
			t.Fatalf("%s: NULL timestamp: %v", driver, err)
		}
		if want := [][]orm.CatalogGridCell{{{Kind: orm.CatalogGridNull, Value: nil}}}; !reflect.DeepEqual(result.Rows, want) {
			t.Fatalf("%s: NULL timestamp cells %#v", driver, result.Rows)
		}
	case "postgres":
		catalogProbe(t, driver, dsn, "grid_probe",
			"CREATE TABLE grid_probe (seq INT PRIMARY KEY, tz TIMESTAMPTZ NULL, tt TIMETZ NULL)",
			"INSERT INTO grid_probe VALUES (1, '2026-10-22 01:02:03+00', '01:02:03+00')")
		refused = []string{"SELECT tz FROM grid_probe WHERE seq = 1", "SELECT tt FROM grid_probe WHERE seq = 1"}
	default:
		t.Fatalf("catalog grid timestamp refusal cases require MySQL or PostgreSQL, got %s", driver)
	}
	for _, query := range refused {
		_, err := c.ReadOnlyGridQuery(ctx, query, nil, orm.CatalogQueryLimits{})
		if err == nil || !strings.Contains(err.Error(), "CATALOG_VALUE") {
			t.Fatalf("%s: %s returned %v, want CATALOG_VALUE", driver, query, err)
		}
	}
}

// Requirements: SCH-6a. An operation on a catalog connection after its Close fails with CATALOG_CLOSED and sends no
// statement. The writes use a key that exists, so a missing check would report a conflict or write the same value back.
func TestCoverageCatalogClosed(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	author, meta := catalogCurrentTable(t, ctx, driver, c, "author", "describe author")
	page, err := c.TablePage(ctx, author, 1, 0)
	if err != nil {
		t.Fatalf("%s: author page: %v", driver, err)
	}
	snapshot, err := orm.CatalogSnapshotFromPage(page, 0)
	if err != nil {
		t.Fatalf("%s: snapshot: %v", driver, err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("%s: close: %v", driver, err)
	}

	checks := map[string]error{}
	_, checks["CurrentNamespace"] = c.CurrentNamespace(ctx)
	_, checks["DescribeTable"] = c.DescribeTable(ctx, author)
	_, checks["TablePage"] = c.TablePage(ctx, author, 1, 0)
	_, checks["ReadOnlyQuery"] = c.ReadOnlyQuery(ctx, "SELECT 1", nil, orm.CatalogQueryLimits{})
	_, checks["ReadOnlyGridQuery"] = c.ReadOnlyGridQuery(ctx, "SELECT 1", nil, orm.CatalogQueryLimits{})
	_, checks["InsertRow"] = c.InsertRow(ctx, meta, []orm.CatalogAssignment{{Name: "seq", Value: page.Result.Rows[0][0]}})
	_, checks["UpdateRow"] = c.UpdateRow(ctx, snapshot, []orm.CatalogAssignment{{Name: "seq", Value: page.Result.Rows[0][0]}})
	_, checks["DeleteRow"] = c.DeleteRow(ctx, snapshot)
	for name, err := range checks {
		if got := orm.ErrorCode(err); got != orm.CodeCatalogClosed {
			t.Errorf("%s: %s after Close: got code %q (%v), want %s", driver, name, got, err, orm.CodeCatalogClosed)
		}
	}
	// Nothing was destroyed: a reopened connection still reads the first author row, which DeleteRow was given.
	reopened, err := orm.ConnectCatalog(os.Getenv("ORM_FEATURE_DSN"))
	if err != nil {
		t.Fatalf("%s: reopen: %v", driver, err)
	}
	defer testcase.Close(t, reopened)
	after, err := reopened.TablePage(ctx, author, 1, 0)
	if err != nil || len(after.Result.Rows) != 1 || !reflect.DeepEqual(after.Result.Rows[0][0], page.Result.Rows[0][0]) {
		t.Fatalf("%s: the first author row changed or is gone after DeleteRow on a closed connection: %v", driver, err)
	}
}

// Requirements: COD-31, INT-4, INT-8.
func TestCoverageModelReadNullAndEmptyText(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver := os.Getenv("ORM_FEATURE_DATABASE")
	if !slices.Contains([]string{"mysql", "postgres", "sqlite"}, driver) {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check")
	}
	c, err := orm.ConnectCatalog(os.Getenv("ORM_FEATURE_DSN"))
	if err != nil {
		t.Fatalf("%s: catalog connection: %v", driver, err)
	}
	defer testcase.Close(t, c)
	if c.Dialect() != driver {
		t.Fatalf("ORM_FEATURE_DSN selects %s, not %s", c.Dialect(), driver)
	}
	ref, metadata := catalogCurrentTable(t, ctx, driver, c, "bind_cell", "bind_cell metadata")
	seq := -1_000_000_000_000 - time.Now().UnixNano()%1_000_000_000
	targets := []int64{seq, seq - 1}
	defer func() {
		var snapshots []orm.CatalogRowSnapshot
		for offset := 0; ; {
			page, err := c.TablePage(ctx, ref, 1000, int64(offset))
			if err != nil {
				t.Errorf("%s: locate fixture rows for cleanup: %v", driver, err)
				return
			}
			key := slices.IndexFunc(page.Metadata.Columns, func(column orm.CatalogColumn) bool { return column.Name == "seq" })
			for index, row := range page.Result.Rows {
				if key < 0 {
					continue
				}
				seqValue, ok := row[key].(int64)
				if ok && slices.Contains(targets, seqValue) {
					snapshot, err := orm.CatalogSnapshotFromPage(page, index)
					if err != nil {
						t.Errorf("%s: capture fixture row for cleanup: %v", driver, err)
						return
					}
					snapshots = append(snapshots, snapshot)
				}
			}
			if !page.HasMore {
				break
			}
			offset += len(page.Result.Rows)
		}
		for _, snapshot := range snapshots {
			if _, err := c.DeleteRow(ctx, snapshot); err != nil {
				t.Errorf("%s: delete fixture row %v: %v", driver, snapshot, err)
			}
		}
	}()

	if _, err := c.InsertRow(ctx, metadata, []orm.CatalogAssignment{{Name: "seq", Value: seq}, {Name: "label", Value: "null-v"}, {Name: "body", Value: nil}}); err != nil {
		t.Fatalf("%s: insert SQL NULL fixture row: %v", driver, err)
	}
	if _, err := c.InsertRow(ctx, metadata, []orm.CatalogAssignment{{Name: "seq", Value: seq - 1}, {Name: "label", Value: "empty"}, {Name: "body", Value: ""}}); err != nil {
		t.Fatalf("%s: insert empty-text fixture row: %v", driver, err)
	}

	db, err := model.Connect(os.Getenv("ORM_FEATURE_DSN"), orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		t.Fatalf("%s: model connection: %v", driver, err)
	}
	defer testcase.Close(t, db)
	if db.Driver() != driver {
		t.Fatalf("ORM_FEATURE_DSN selects %s, not %s", db.Driver(), driver)
	}

	for _, want := range []struct {
		seq  int64
		body *string
	}{{seq, nil}, {seq - 1, new(string)}} {
		got, err := model.BindCell().Connect(db).Seq(want.seq).Get()
		if err != nil {
			t.Fatalf("%s: read row %d: %v", driver, want.seq, err)
		}
		body, err := got.GetBody()
		if err != nil {
			t.Fatalf("%s: read body %d: %v", driver, want.seq, err)
		}
		if body == nil != (want.body == nil) || body != nil && *body != *want.body {
			t.Fatalf("%s: row %d body = %v, want %v", driver, want.seq, body, want.body)
		}
	}
	if _, err := orm.Decode([]string{"ordered_json"}, ""); orm.ErrorCode(err) != orm.CodeCodecDecode {
		t.Errorf("%s: empty text with ordered_json: got %v, want %s", driver, err, orm.CodeCodecDecode)
	}
}
