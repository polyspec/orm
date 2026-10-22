//go:build featurecoverage

package orm_test

import (
	"context"
	"database/sql"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

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

func catalogQuote(name, driver string) string {
	if driver == "mysql" {
		return "`" + name + "`"
	}
	return `"` + name + `"`
}

// Requirements: SCH-5, SCH-6a.
func TestCoverageCatalogRead(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer c.Close()

	namespace, err := c.CurrentNamespace(ctx)
	if err != nil {
		t.Fatalf("%s: current namespace: %v", driver, err)
	}
	author := orm.CatalogTableRef{Namespace: namespace, Name: "author"}
	meta, err := c.DescribeTable(ctx, author)
	if err != nil {
		t.Fatalf("%s: author metadata: %v", driver, err)
	}
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

	count, err := c.ReadOnlyQuery(ctx, "SELECT COUNT(*) FROM "+catalogQuote("user", driver), nil, orm.CatalogQueryLimits{})
	if err != nil {
		t.Fatalf("%s: user count: %v", driver, err)
	}
	if got := count.Rows[0][0]; got != int64(5000) {
		t.Fatalf("%s: user count %v, want 5000", driver, got)
	}
	_, err = c.ReadOnlyQuery(ctx, "UPDATE "+catalogQuote("user", driver)+" SET name = name WHERE seq = 1", nil, orm.CatalogQueryLimits{})
	if err == nil || !strings.Contains(err.Error(), "QUERY_READ_ONLY") {
		t.Fatalf("%s: a write through ReadOnlyQuery returned %v, want QUERY_READ_ONLY", driver, err)
	}
}

// Requirements: SCH-5, SCH-6a.
func TestCoverageCatalogRowMutation(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer c.Close()

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
	updated, err := c.UpdateRow(ctx, snapshot, []orm.CatalogAssignment{{Name: "name", Value: "catalog-updated"}})
	if err != nil || len(updated.Rows) != 1 {
		t.Fatalf("%s: update: rows %v, err %v", driver, updated, err)
	}

	snapshot = catalogFindTenantRow(t, ctx, c, table, driver, "catalog-updated")
	deleted, err := c.DeleteRow(ctx, snapshot)
	if err != nil || deleted != 1 {
		t.Fatalf("%s: delete: %d rows, err %v", driver, deleted, err)
	}
	if got := tenantRows(); got != int64(0) {
		t.Fatalf("%s: rows left after delete: %v", driver, got)
	}
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
			[]orm.CatalogGridCell{
				cell(orm.CatalogGridFloat32, uint32(0x3FC00000)),
				cell(orm.CatalogGridFloat64, uint64(0x3FF8000000000000)),
				cell(orm.CatalogGridUnsigned, uint64(1<<64-1)),
				cell(orm.CatalogGridInteger, int64(-7)),
				cell(orm.CatalogGridDecimal, "1.50"),
				cell(orm.CatalogGridBinary, []byte("ab")),
				cell(orm.CatalogGridNull, nil),
				cell(orm.CatalogGridDate, "2024-02-29"),
				cell(orm.CatalogGridTime, "12:34:56.500000"),
				cell(orm.CatalogGridDateTime, "2024-02-29 01:02:03.500000"),
			}
	case "postgres":
		return "SELECT 1.5::real AS f, 1.5::double precision AS d, 'NaN'::double precision AS nan, 'NaN'::real AS nanf, " +
				"9223372036854775807::bigint AS i, 2.50::numeric(10,2) AS dec, '\\x6162'::bytea AS b, NULL::date AS n, " +
				"'2024-02-29'::date AS dt, '12:34:56.5'::time AS tm, '2024-02-29 01:02:03.5'::timestamp AS dtm",
			[]orm.CatalogGridCell{
				cell(orm.CatalogGridFloat32, uint32(0x3FC00000)),
				cell(orm.CatalogGridFloat64, uint64(0x3FF8000000000000)),
				cell(orm.CatalogGridFloat64, uint64(0x7FF8000000000000)),
				cell(orm.CatalogGridFloat32, uint32(0x7FC00000)),
				cell(orm.CatalogGridInteger, int64(9223372036854775807)),
				cell(orm.CatalogGridDecimal, "2.50"),
				cell(orm.CatalogGridBinary, []byte("ab")),
				cell(orm.CatalogGridNull, nil),
				cell(orm.CatalogGridDate, "2024-02-29"),
				cell(orm.CatalogGridTime, "12:34:56.500000"),
				cell(orm.CatalogGridDateTime, "2024-02-29 01:02:03.500000"),
			}
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

// Requirements: SCH-6a.
func TestCoverageCatalogGridCells(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer c.Close()

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
	defer c.Close()
	if driver != "sqlite" {
		t.Skip("the declared-type cases of the grid are the SQLite storage-class cases")
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
	defer c.Close()
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
		t.Skip("the timestamp refusals are the MySQL and PostgreSQL time-zone types")
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
	namespace, err := c.CurrentNamespace(ctx)
	if err != nil {
		t.Fatalf("%s: current namespace: %v", driver, err)
	}
	author := orm.CatalogTableRef{Namespace: namespace, Name: "author"}
	meta, err := c.DescribeTable(ctx, author)
	if err != nil {
		t.Fatalf("%s: describe author: %v", driver, err)
	}
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
	for name, err := range checks {
		if got := orm.ErrorCode(err); got != orm.CodeCatalogClosed {
			t.Errorf("%s: %s after Close: got code %q (%v), want %s", driver, name, got, err, orm.CodeCatalogClosed)
		}
	}
}
