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

// catalogDescribedTestValue converts one driver value of a described column as a read of a described table does, with the
// native type name that the driver reports for it on MySQL and PostgreSQL.
func catalogDescribedTestValue(value any, driverType string, column CatalogColumn, dialect string) (any, error) {
	if dialect == "sqlite" {
		v, rule := catalogSQLiteDescribed(value, column)
		if rule != nil {
			return nil, rule.at(2)
		}
		return v, nil
	}
	t := catalogMySQLType(driverType)
	if dialect == "postgres" {
		named, ok := catalogPostgresNamed(driverType)
		if !ok {
			named = catalogType{refusal: catalogRuleNativeType}
		}
		t = named
	}
	if value == nil {
		return nil, nil
	}
	cell, rule := catalogConvertCell(t, value, dialect)
	if rule == nil {
		var v any
		if v, rule = catalogDescribedCell(cell, column, dialect); rule == nil {
			return v, nil
		}
	}
	return nil, rule.at(2)
}

// TestCatalogDescribedBool is the table of the bool read: a boolean column is read as a bool by its column type on MySQL
// tinyint(1), on SQLite BOOLEAN and on PostgreSQL boolean; a value of any other column is left as it is, and any value
// other than 0 or 1 of a boolean column fails with INT-182.
func TestCatalogDescribedBool(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	cases := []struct {
		name       string
		dialect    string
		native     string
		driverType string
		value      any
		want       any
		fails      bool
	}{
		{"mysql tinyint(1) zero", "mysql", "tinyint(1)", "TINYINT", int64(0), false, false},
		{"mysql tinyint(1) one", "mysql", "tinyint(1)", "TINYINT", int64(1), true, false},
		{"mysql tinyint(1) null", "mysql", "tinyint(1)", "TINYINT", nil, nil, false},
		{"mysql tinyint(1) two", "mysql", "tinyint(1)", "TINYINT", int64(2), nil, true},
		{"mysql plain tinyint stays integer", "mysql", "tinyint", "TINYINT", int64(2), int64(2), false},
		{"sqlite BOOLEAN zero", "sqlite", "BOOLEAN", "", int64(0), false, false},
		{"sqlite BOOLEAN one", "sqlite", "BOOLEAN", "", int64(1), true, false},
		{"sqlite BOOLEAN minus one", "sqlite", "BOOLEAN", "", int64(-1), nil, true},
		{"sqlite BOOLEAN text", "sqlite", "BOOLEAN", "", "1", nil, true},
		{"sqlite integer stays integer", "sqlite", "INTEGER", "", int64(1), int64(1), false},
		{"postgres boolean bool", "postgres", "boolean", "BOOL", true, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			column := CatalogColumn{Name: "b", NativeType: tc.native}
			got, err := catalogDescribedTestValue(tc.value, tc.driverType, column, tc.dialect)
			if tc.fails {
				if err == nil || err.Error() != "CATALOG_VALUE: column 2: a boolean column holds a value that is not a boolean" {
					t.Fatalf("described %v = %v, %v; want the INT-182 refusal", tc.value, got, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("described %v: %v", tc.value, err)
			}
			if got != tc.want {
				t.Fatalf("described %v = %v (%T), want %v (%T)", tc.value, got, got, tc.want, tc.want)
			}
		})
	}
}

func TestCatalogDescribedTemporalText(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	stamp := time.Date(2026, time.January, 2, 3, 4, 5, 123000000, time.UTC)
	date := time.Date(2024, time.February, 29, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name       string
		value      any
		native     string
		driverType string
		dialect    string
		want       any
		message    string
	}{
		{name: "MySQL datetime of default precision", value: []byte("2026-01-02 03:04:05"), native: "datetime", driverType: "DATETIME", dialect: "mysql", want: "2026-01-02 03:04:05"},
		{name: "MySQL datetime(3)", value: []byte("2026-01-02 03:04:05.123"), native: "datetime(3)", driverType: "DATETIME", dialect: "mysql", want: "2026-01-02 03:04:05.123"},
		{name: "MySQL datetime(6)", value: []byte("2026-01-02 03:04:05.123000"), native: "datetime(6)", driverType: "DATETIME", dialect: "mysql", want: "2026-01-02 03:04:05.123000"},
		{name: "MySQL date", value: []byte("2024-02-29"), native: "date", driverType: "DATE", dialect: "mysql", want: "2024-02-29"},
		{name: "MySQL time(3)", value: []byte("12:34:56.500"), native: "time(3)", driverType: "TIME", dialect: "mysql", want: "12:34:56.500"},
		{name: "MySQL time", value: []byte("12:34:56"), native: "time", driverType: "TIME", dialect: "mysql", want: "12:34:56"},
		{name: "PostgreSQL timestamp of default precision", value: stamp, native: "timestamp without time zone", driverType: "TIMESTAMP", dialect: "postgres", want: "2026-01-02 03:04:05.123000"},
		{name: "PostgreSQL timestamp(3)", value: stamp, native: "timestamp(3) without time zone", driverType: "TIMESTAMP", dialect: "postgres", want: "2026-01-02 03:04:05.123"},
		{name: "PostgreSQL date", value: date, native: "date", driverType: "DATE", dialect: "postgres", want: "2024-02-29"},
		{name: "PostgreSQL time(3) without trailing zeros", value: "12:34:56.5", native: "time(3) without time zone", driverType: "TIME", dialect: "postgres", want: "12:34:56.500"},
		{name: "PostgreSQL time of default precision", value: "12:34:56", native: "time without time zone", driverType: "TIME", dialect: "postgres", want: "12:34:56.000000"},
		{name: "NULL", value: nil, native: "datetime(3)", driverType: "DATETIME", dialect: "mysql", want: nil},
		{name: "not a dbspec type", value: stamp, native: "timestamp with time zone", driverType: "TIMESTAMPTZ", dialect: "postgres", message: "CATALOG_VALUE: column 2: PostgreSQL timestamptz and timetz are unsupported"},
		{name: "MySQL TIMESTAMP is not a dbspec type", value: []byte("2026-01-02 03:04:05"), native: "timestamp", driverType: "TIMESTAMP", dialect: "mysql", message: "CATALOG_VALUE: column 2: MySQL TIMESTAMP follows a time zone"},
		{name: "digit past the declared precision", value: []byte("2026-01-02 03:04:05.123"), native: "datetime(2)", driverType: "DATETIME", dialect: "mysql", message: "GRID_TEMPORAL_PRECISION: column 2: temporal value has more fraction digits than its precision"},
		{name: "time digit past the declared precision", value: []byte("12:34:56.5"), native: "time", driverType: "TIME", dialect: "mysql", message: "GRID_TEMPORAL_PRECISION: column 2: temporal value has more fraction digits than its precision"},
		{name: "native type of more than 6 digits", value: "12:34:56", native: "time(7) without time zone", driverType: "TIME", dialect: "postgres", message: "GRID_TEMPORAL_PRECISION: column 2: native type declares more than 6 fraction digits"},
		{name: "native type of a precision that is no number", value: []byte("12:34:56"), native: "time(x)", driverType: "TIME", dialect: "mysql", message: "GRID_TEMPORAL_PRECISION: column 2: native type declares more than 6 fraction digits"},
		{name: "time outside a day", value: []byte("25:00:00"), native: "time", driverType: "TIME", dialect: "mysql", message: "GRID_TEMPORAL_VALUE: column 2: time outside 00:00:00 to 23:59:59.999999"},
		{name: "SQLite text of its CHECK precision", value: "12:34:56.500", native: "TIME", dialect: "sqlite", want: "12:34:56.500"},
		{name: "SQLite date", value: "2024-02-29", native: "DATE", dialect: "sqlite", want: "2024-02-29"},
		{name: "SQLite TIME(3) is not a dbspec declaration", value: "12:34:56.5", native: "TIME(3)", dialect: "sqlite", want: "12:34:56.5"},
		{name: "SQLite text of other digits than its CHECK", value: "12:34:56.5", native: "TIME", dialect: "sqlite", message: "GRID_TEMPORAL_PRECISION: column 2: the fraction digits are not the count that its dbspec CHECK fixes"},
		{name: "SQLite integer in a DATE column", value: int64(20240229), native: "DATE", dialect: "sqlite", message: "GRID_TEMPORAL_VALUE: column 2: the stored value is not a dbspec date"},
		{name: "SQLite text of the year 0", value: "0000-01-01", native: "DATE", dialect: "sqlite", message: "GRID_TEMPORAL_VALUE: column 2: date outside 0001-01-01 to 9999-12-31"},
		{name: "MySQL zero date on the described path", value: []byte("0000-00-00"), native: "date", driverType: "DATE", dialect: "mysql", message: "GRID_TEMPORAL_VALUE: column 2: date outside 0001-01-01 to 9999-12-31"},
		{name: "MySQL zero datetime on the described path", value: []byte("0000-00-00 00:00:00.000"), native: "datetime(3)", driverType: "DATETIME", dialect: "mysql", message: "GRID_TEMPORAL_VALUE: column 2: date outside 0001-01-01 to 9999-12-31"},
		{name: "MySQL date that is no calendar date", value: []byte("2024-02-30"), native: "date", driverType: "DATE", dialect: "mysql", message: "GRID_TEMPORAL_VALUE: column 2: date is not a calendar date"},
	} {
		t.Run(test.name, func(t *testing.T) {
			column := CatalogColumn{Name: "c", NativeType: test.native}
			if test.dialect == "sqlite" && test.native == "TIME" {
				precision := 3
				column.CheckPrecision = &precision
			}
			got, err := catalogDescribedTestValue(test.value, test.driverType, column, test.dialect)
			if test.message != "" {
				if err == nil || err.Error() != test.message {
					t.Fatalf("described %#v = %#v, %v; want %s", test.value, got, err, test.message)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("described %#v = %#v, %v; want %#v", test.value, got, err, test.want)
			}
		})
	}
}
