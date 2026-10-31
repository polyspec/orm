package orm

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// catalogTemporalDDL is a table in the SQLite form of the dbspec renderer (engine/dbspec/render.go): each TIME and
// DATETIME column has the CHECK that fixes its fraction digits.
const catalogTemporalDDL = `CREATE TABLE temporal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  d DATE NOT NULL CHECK ("d" IS date("d")),
  t0 TIME NOT NULL CHECK ("t0" IS time("t0") AND "t0" < '24:00:00'),
  t3 TIME NOT NULL CHECK (length("t3") = 12 AND substr("t3", 1, 8) IS time(substr("t3", 1, 8)) AND substr("t3", 1, 8) < '24:00:00' AND substr("t3", 9, 1) = '.' AND substr("t3", 10) GLOB '[0-9][0-9][0-9]'),
  dt0 DATETIME NOT NULL CHECK (length("dt0") = 19 AND "dt0" IS datetime("dt0") AND substr("dt0", 12, 2) < '24'),
  dt6 DATETIME NOT NULL CHECK (length("dt6") = 26 AND substr("dt6", 1, 19) IS datetime(substr("dt6", 1, 19)) AND substr("dt6", 12, 2) < '24' AND substr("dt6", 20, 1) = '.' AND substr("dt6", 21) GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]')
)`

func catalogTemporalValues() []CatalogAssignment {
	return []CatalogAssignment{
		{Name: "d", Value: "2024-02-29"},
		{Name: "t0", Value: "12:34:56"},
		{Name: "t3", Value: "12:34:56.500"},
		{Name: "dt0", Value: "2024-02-29 01:02:03"},
		{Name: "dt6", Value: "2024-02-29 01:02:03.500000"},
	}
}

// Requirements: INT-103, INT-117.
func TestCatalogDescribedReadsReturnSQLiteTemporalText(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	catalog, metadata := openCatalogSQLiteDefaultFixture(t, "temporal", catalogTemporalDDL)
	ctx := context.Background()
	want := []any{int64(1), "2024-02-29", "12:34:56", "12:34:56.500", "2024-02-29 01:02:03", "2024-02-29 01:02:03.500000"}
	inserted, err := catalog.InsertRow(ctx, metadata, catalogTemporalValues())
	if err != nil {
		t.Fatalf("InsertRow: %v", err)
	}
	requireCatalogInsertedRow(t, inserted, want)
	page, err := catalog.TablePage(ctx, metadata.Table, 10, 0)
	if err != nil {
		t.Fatalf("TablePage: %v", err)
	}
	if len(page.Result.Rows) != 1 || !reflect.DeepEqual(page.Result.Rows[0], want) {
		t.Fatalf("TablePage rows = %#v, want [%#v]", page.Result.Rows, want)
	}
	original, err := CatalogSnapshotFromPage(page, 0)
	if err != nil {
		t.Fatalf("CatalogSnapshotFromPage: %v", err)
	}
	updated, err := catalog.UpdateRow(ctx, original, []CatalogAssignment{{Name: "dt6", Value: "2024-03-01 00:00:00.000001"}})
	if err != nil {
		t.Fatalf("UpdateRow: %v", err)
	}
	want[5] = "2024-03-01 00:00:00.000001"
	requireCatalogInsertedRow(t, updated, want)
	page, err = catalog.TablePage(ctx, metadata.Table, 10, 0)
	if err != nil {
		t.Fatalf("TablePage after the update: %v", err)
	}
	current, err := CatalogSnapshotFromPage(page, 0)
	if err != nil {
		t.Fatalf("CatalogSnapshotFromPage after the update: %v", err)
	}
	deleted, err := catalog.DeleteRow(ctx, current)
	if err != nil || deleted != 1 {
		t.Fatalf("DeleteRow = %d, %v; want 1", deleted, err)
	}
}

// Requirements: INT-103.
func TestCatalogDescribedTemporalRefusesSQLiteTextOutsideCheck(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	ctx := context.Background()
	for _, test := range []struct {
		name string
		ddl  string
		code string
	}{
		{name: "loose", ddl: "CREATE TABLE loose (id INTEGER PRIMARY KEY, dt DATETIME); INSERT INTO loose VALUES (1, '2024-02-29 01:02:03')", code: "GRID_TEMPORAL_PRECISION"},
		{name: "wrong", ddl: "CREATE TABLE wrong (id INTEGER PRIMARY KEY, d DATE); INSERT INTO wrong VALUES (1, 'not a date')", code: "GRID_TEMPORAL_VALUE"},
	} {
		t.Run(test.name, func(t *testing.T) {
			catalog, metadata := openCatalogSQLiteDefaultFixture(t, test.name, test.ddl)
			page, err := catalog.TablePage(ctx, metadata.Table, 10, 0)
			if ErrorCode(err) != test.code {
				t.Fatalf("TablePage = %#v, %v; want %s", page.Result.Rows, err, test.code)
			}
		})
	}
}

// Requirements: INT-111, INT-123.
func TestCatalogWriteRefusesTimeValueForTemporalColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	catalog, metadata := openCatalogSQLiteDefaultFixture(t, "temporal", catalogTemporalDDL)
	ctx := context.Background()
	values := catalogTemporalValues()
	values[3].Value = time.Date(2024, time.February, 29, 1, 2, 3, 0, time.UTC)
	if _, err := catalog.InsertRow(ctx, metadata, values); ErrorCode(err) != "ROW_INSERT_INVALID" {
		t.Fatalf("InsertRow with a time.Time datetime = %v, want ROW_INSERT_INVALID", err)
	}
	if _, err := catalog.InsertRow(ctx, metadata, catalogTemporalValues()); err != nil {
		t.Fatalf("InsertRow: %v", err)
	}
	page, err := catalog.TablePage(ctx, metadata.Table, 10, 0)
	if err != nil {
		t.Fatalf("TablePage: %v", err)
	}
	original, err := CatalogSnapshotFromPage(page, 0)
	if err != nil {
		t.Fatalf("CatalogSnapshotFromPage: %v", err)
	}
	for _, name := range []string{"d", "t3", "dt6"} {
		_, err := catalog.UpdateRow(ctx, original, []CatalogAssignment{{Name: name, Value: time.Date(2024, time.March, 1, 0, 0, 0, 0, time.UTC)}})
		if ErrorCode(err) != "ROW_UPDATE_INVALID" {
			t.Fatalf("UpdateRow of %s with a time.Time = %v, want ROW_UPDATE_INVALID", name, err)
		}
	}
}

// Requirements: INT-101, INT-103.
func TestCatalogDescribedTemporalText(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	stamp := time.Date(2026, time.January, 2, 3, 4, 5, 123000000, time.UTC)
	whole := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	date := time.Date(2024, time.February, 29, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name    string
		value   any
		native  string
		dialect string
		want    any
		code    string
	}{
		{name: "MySQL datetime of default precision", value: whole, native: "datetime", dialect: "mysql", want: "2026-01-02 03:04:05"},
		{name: "MySQL datetime(3)", value: stamp, native: "datetime(3)", dialect: "mysql", want: "2026-01-02 03:04:05.123"},
		{name: "MySQL datetime(6)", value: stamp, native: "datetime(6)", dialect: "mysql", want: "2026-01-02 03:04:05.123000"},
		{name: "MySQL date", value: date, native: "date", dialect: "mysql", want: "2024-02-29"},
		{name: "MySQL time(3)", value: "12:34:56.500", native: "time(3)", dialect: "mysql", want: "12:34:56.500"},
		{name: "MySQL time", value: "12:34:56", native: "time", dialect: "mysql", want: "12:34:56"},
		{name: "PostgreSQL timestamp of default precision", value: stamp, native: "timestamp without time zone", dialect: "postgres", want: "2026-01-02 03:04:05.123000"},
		{name: "PostgreSQL timestamp(3)", value: stamp, native: "timestamp(3) without time zone", dialect: "postgres", want: "2026-01-02 03:04:05.123"},
		{name: "PostgreSQL date", value: date, native: "date", dialect: "postgres", want: "2024-02-29"},
		{name: "PostgreSQL time(3) without trailing zeros", value: "12:34:56.5", native: "time(3) without time zone", dialect: "postgres", want: "12:34:56.500"},
		{name: "PostgreSQL time of default precision", value: "12:34:56", native: "time without time zone", dialect: "postgres", want: "12:34:56.000000"},
		{name: "NULL", value: nil, native: "datetime(3)", dialect: "mysql", want: nil},
		{name: "not a dbspec type", value: whole, native: "timestamp with time zone", dialect: "postgres", want: whole},
		{name: "MySQL TIMESTAMP is not a dbspec type", value: whole, native: "timestamp", dialect: "mysql", want: whole},
		{name: "digit past the declared precision", value: stamp, native: "datetime(2)", dialect: "mysql", code: "GRID_TEMPORAL_PRECISION"},
		{name: "time digit past the declared precision", value: "12:34:56.5", native: "time", dialect: "mysql", code: "GRID_TEMPORAL_PRECISION"},
		{name: "time outside a day", value: "25:00:00", native: "time", dialect: "mysql", code: "GRID_TEMPORAL_VALUE"},
		{name: "SQLite text of its CHECK precision", value: "12:34:56.500", native: "TIME", dialect: "sqlite", want: "12:34:56.500"},
		{name: "SQLite date", value: "2024-02-29", native: "DATE", dialect: "sqlite", want: "2024-02-29"},
		{name: "SQLite TIME(3) is not a dbspec declaration", value: "12:34:56.5", native: "TIME(3)", dialect: "sqlite", want: "12:34:56.5"},
		{name: "SQLite text of other digits than its CHECK", value: "12:34:56.5", native: "TIME", dialect: "sqlite", code: "GRID_TEMPORAL_PRECISION"},
	} {
		t.Run(test.name, func(t *testing.T) {
			column := CatalogColumn{Name: "c", NativeType: test.native}
			if test.dialect == "sqlite" && test.native == "TIME" {
				precision := 3
				column.checkPrecision = &precision
			}
			got, err := catalogDescribedTemporal(test.value, column, test.dialect)
			if test.code != "" {
				if ErrorCode(err) != test.code {
					t.Fatalf("catalogDescribedTemporal = %#v, %v; want %s", got, err, test.code)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("catalogDescribedTemporal = %#v, %v; want %#v", got, err, test.want)
			}
		})
	}
}
