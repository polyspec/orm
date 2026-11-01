// Requirements: INT-102, INT-104, INT-112, INT-113, INT-114, INT-115, INT-117, INT-123, INT-136, INT-4, INT-8, INT-97, SCH-3
//go:build featurecoverage

// Catalog parity cases that the shared recipe contracts/fixtures/catalog_connection/catalog_connection.json does not cover
// (FCV-2). The recipe runs on mysql, postgres and sqlite; the cases here keep only what it does not assert.

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

// catalog_connection coverage: runs against the feature database that the feature check selected (ORM_FEATURE_DATABASE and
// ORM_FEATURE_DSN).

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

// Requirements: INT-101.
func TestCoverageCatalogRead(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)
	_, dsn := featureDatabase(t)
	catalogTemporalDefaultPrecisionCheck(t, driver, dsn)
}

// catalogTemporalDefaultPrecisionCheck is the one rule of INT-101 that the recipe cannot state: the MySQL server refuses a
// TIME(7). The recipe's temporal_default_precision case asserts the rest, and its sql.exec step cannot assert a server error,
// since the runner matches only errors that carry an engine code.
func catalogTemporalDefaultPrecisionCheck(t *testing.T, driver, dsn string) {
	t.Helper()
	if driver != "mysql" {
		return
	}
	raw := openRaw(t, driver, dsn)
	defer testcase.Close(t, raw)
	_, err := raw.Exec("CREATE TABLE catalog_precision_invalid (id BIGINT PRIMARY KEY, t TIME(7))")
	if err == nil {
		if _, dropErr := raw.Exec("DROP TABLE catalog_precision_invalid"); dropErr != nil {
			t.Errorf("%s: drop unexpectedly accepted precision table: %v", driver, dropErr)
		}
		t.Fatalf("%s: accepted temporal precision 7", driver)
	}
	if !strings.Contains(strings.ToLower(err.Error()), "precision") {
		t.Fatalf("%s: precision 7 failed for another reason: %v", driver, err)
	}
}

// Requirements: SCH-5, SCH-6a, DBS-113, INT-34, INT-106, INT-108, INT-109, INT-110, INT-111.
// The recipe's row_mutation case asserts the row operations, the update rules and the stale-update conflict. Two things are
// not in it: a snapshot whose page projection names a column other than the descriptor's (the recipe varies only the order_by),
// and the key rules of the generated-key helper below.
func TestCoverageCatalogRowMutation(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)
	_, dsn := featureDatabase(t)
	engine := ""
	if driver == "mysql" {
		engine = " ENGINE=InnoDB"
	}
	catalogProbe(t, driver, dsn, "catalog_projection",
		"CREATE TABLE catalog_projection (id BIGINT NOT NULL PRIMARY KEY, name VARCHAR(20) NOT NULL)"+engine,
		"INSERT INTO catalog_projection VALUES (1, 'projection')")
	table := orm.CatalogTableRef{Namespace: mustCatalogNamespace(t, ctx, c), Name: "catalog_projection"}
	page, err := c.TablePage(ctx, table, 1000, 0)
	if err != nil {
		t.Fatalf("%s: projection page: %v", driver, err)
	}
	page.Result.Columns[0].Name = "changed"
	if _, err := orm.CatalogSnapshotFromPage(page, 0); orm.ErrorCode(err) != orm.CodeRowSnapshotInvalid {
		t.Fatalf("%s: snapshot with a projection that differs from the descriptor error = %v, want %s", driver, err, orm.CodeRowSnapshotInvalid)
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

// Requirements: SCH-6a, INT-103. The recipe's grid cases and refusals cover these dialects, except two refusals that its
// cases do not state: a MySQL TIME outside 00:00:00 to 23:59:59.999999 (the recipe has only a negative TIME), and a
// PostgreSQL infinity date (the recipe has only an infinity timestamp).
func TestCoverageCatalogGridCells(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	defer testcase.Close(t, c)
	var refused []string
	switch driver {
	case "mysql":
		refused = []string{"SELECT CAST('24:00:00' AS TIME(6)) AS t"}
	case "postgres":
		refused = []string{"SELECT 'infinity'::date AS t"}
	}
	for _, query := range refused {
		_, err := c.ReadOnlyGridQuery(ctx, query, nil, orm.CatalogQueryLimits{})
		if err == nil || !strings.Contains(err.Error(), "CATALOG_VALUE") {
			t.Fatalf("%s: %s returned %v, want CATALOG_VALUE", driver, query, err)
		}
	}
}

// Requirements: SCH-6a. The recipe's sqlite grid_declared_columns case has no REAL value in a declared DATETIME column; here
// a float keeps its storage class as a Float64 cell.
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
		"CREATE TABLE grid_probe (seq INTEGER PRIMARY KEY, n DATETIME)",
		"INSERT INTO grid_probe VALUES (1, 1.5)")
	result, err := c.ReadOnlyGridQuery(ctx, "SELECT n FROM grid_probe ORDER BY seq", nil, orm.CatalogQueryLimits{})
	if err != nil {
		t.Fatalf("%s: declared grid query: %v", driver, err)
	}
	want := [][]orm.CatalogGridCell{{{Kind: orm.CatalogGridFloat64, Value: uint64(0x3FF8000000000000)}}}
	if !reflect.DeepEqual(result.Rows, want) {
		t.Fatalf("%s: declared float cells\n got %#v\nwant %#v", driver, result.Rows, want)
	}
}

// Requirements: SCH-6a. An operation on a catalog connection after its Close fails with CATALOG_CLOSED. The recipe's
// catalog_lifecycle case asserts that for every operation except the grid query, which is asserted here.
func TestCoverageCatalogClosed(t *testing.T) {
	testcase.Start(t, testcase.Database)
	ctx := context.Background()
	driver, c := catalogConnect(t)
	if err := c.Close(); err != nil {
		t.Fatalf("%s: close: %v", driver, err)
	}
	_, err := c.ReadOnlyGridQuery(ctx, "SELECT 1", nil, orm.CatalogQueryLimits{})
	if got := orm.ErrorCode(err); got != orm.CodeCatalogClosed {
		t.Errorf("%s: ReadOnlyGridQuery after Close: got code %q (%v), want %s", driver, got, err, orm.CodeCatalogClosed)
	}
}

// Requirements: COD-31. The recipe's catalog_null_and_empty_text case asserts the NULL and the empty text of the bind_cell
// rows. This check is the empty-text refusal of ordered_json, which that case does not contain.
func TestCoverageModelReadNullAndEmptyText(t *testing.T) {
	testcase.Start(t, testcase.Database)
	if _, err := orm.Decode([]string{"ordered_json"}, ""); orm.ErrorCode(err) != orm.CodeCodecDecode {
		t.Errorf("empty text with ordered_json: got %v, want %s", err, orm.CodeCodecDecode)
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
