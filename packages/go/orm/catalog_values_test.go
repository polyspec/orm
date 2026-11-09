package orm

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCatalogValueUnsupportedDriverValue injects driver values that are not the host form of a value of their column type,
// which no database sends (INT-171, FCV-2): each fails with CATALOG_VALUE and the text of its rule at its column.
//
// Requirements: INT-171.
func TestCatalogValueUnsupportedDriverValue(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, test := range []struct {
		name    string
		dialect string
		native  string
		value   any
	}{
		{name: "a host type that the conversion does not take", dialect: "mysql", native: "INT", value: int32(7)},
		{name: "a time object of another kind", dialect: "postgres", native: "TIME", value: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)},
		{name: "a SQLite value of no storage class", dialect: "sqlite", native: "", value: true},
		{name: "integer text that is not digits", dialect: "mysql", native: "UNSIGNED BIGINT", value: []byte("18446744073709551616x")},
		{name: "integer text of the other sign", dialect: "mysql", native: "UNSIGNED BIGINT", value: []byte("-1")},
		{name: "a negative value of an unsigned column", dialect: "mysql", native: "UNSIGNED INT", value: int64(-1)},
		{name: "a float that a 4-byte float does not hold", dialect: "postgres", native: "FLOAT4", value: 0.1},
		{name: "decimal text that is not a number", dialect: "mysql", native: "DECIMAL", value: []byte("1.5e3")},
		{name: "a driver date with a time of day", dialect: "postgres", native: "DATE", value: time.Date(2026, 1, 2, 3, 0, 0, 0, time.UTC)},
		{name: "a driver datetime with a digit past six fraction digits", dialect: "postgres", native: "TIMESTAMP", value: time.Date(2026, 1, 2, 3, 4, 5, 1, time.UTC)},
		{name: "a driver time with a digit past six fraction digits", dialect: "mysql", native: "TIME", value: []byte("12:34:56.1234567")},
		{name: "date text that is not a date", dialect: "mysql", native: "DATE", value: []byte("2026-1-2")},
	} {
		t.Run(test.name, func(t *testing.T) {
			convert := &catalogCells{ctx: context.Background(), dialect: test.dialect, postgres: map[uint32]catalogType{}}
			cell, err := convert.cell(test.value, test.native, 3)
			if ErrorCode(err) != CodeCatalogValue || err.Error() != "CATALOG_VALUE: column 3: unsupported driver value" {
				t.Fatalf("cell(%#v) = %#v, %v; want CATALOG_VALUE: column 3: unsupported driver value", test.value, cell, err)
			}
		})
	}
}

// TestCatalogValueDriverDecodeFailure injects a value that the driver fails to decode, which no database sends for a
// supported type (INT-172, FCV-2): the driver fails the scan of its column, as pgx's ScanColumn does, and the read fails with
// CATALOG_VALUE and no column, the failure kept as its cause.
//
// Requirements: INT-172.
func TestCatalogValueDriverDecodeFailure(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	useFailingDriver(t, "sqlite")
	pool, err := sql.Open("orm-failing-sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, pool) })
	ctx := context.Background()
	conn, err := pool.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(); err != nil && !errors.Is(err, sql.ErrConnDone) {
			t.Errorf("close *sql.Conn: %v", err)
		}
	})
	cause := errors.New("invalid length for int8: 3")
	inject(t, injectedFailure{rows: func(string) error { return cause }})
	session := &catalogSession{ctx: ctx, conn: conn, dialect: "postgres"}
	_, err = session.queryRaw("SELECT 1, 2", nil, 10, 1<<20)
	if ErrorCode(err) != CodeCatalogValue || err.Error() != "CATALOG_VALUE: the driver could not decode the value" {
		t.Fatalf("queryRaw = %v; want CATALOG_VALUE: the driver could not decode the value", err)
	}
	if !errors.Is(err, cause) {
		t.Fatalf("the decode failure lost its cause: %v", err)
	}
	if unwrapped := errors.Unwrap(err); unwrapped == nil || !errors.Is(unwrapped, cause) {
		t.Fatalf("errors.Unwrap = %v; want the driver failure", unwrapped)
	}
}

// TestCatalogPostgresQueryModeKeepsBinaryTemporals reads a date and a timestamp under a DateStyle that the query sets, through
// a DSN whose pgx query mode would send their text, which follows DateStyle: the catalog reads them in the binary form, so
// each keeps its cell in a plain and a grid query.
//
// Requirements: INT-153.
// Runtime-unique (FCV-14): the query mode is an option of the Go PostgreSQL driver; the recipe case
// catalog_temporal_values_under_a_query_datestyle reads the same query through the DSN of every runtime.
func TestCatalogPostgresQueryModeKeepsBinaryTemporals(t *testing.T) {
	testcase.Start(t, testcase.Database)
	dsn := os.Getenv("ORM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Fatal("ORM_TEST_POSTGRES_DSN is required; run make orm-test-servers")
	}
	query := "SELECT set_config('DateStyle', 'SQL, DMY', true) AS style, '2026-01-02'::date AS d, " +
		"'2026-01-02 03:04:05.5'::timestamp AS dt"
	for _, mode := range []string{"simple_protocol", "exec"} {
		t.Run(mode, func(t *testing.T) {
			catalog, err := ConnectCatalog(dsn + "&default_query_exec_mode=" + mode)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := catalog.Close(); err != nil {
					t.Errorf("close: %v", err)
				}
			})
			plain, err := catalog.ReadOnlyQuery(context.Background(), query, nil, CatalogQueryLimits{})
			if err != nil {
				t.Fatal(err)
			}
			if len(plain.Rows) != 1 || plain.Rows[0][1] != "2026-01-02" || plain.Rows[0][2] != "2026-01-02 03:04:05.500000" {
				t.Fatalf("ReadOnlyQuery rows = %#v", plain.Rows)
			}
			grid, err := catalog.ReadOnlyGridQuery(context.Background(), query, nil, CatalogQueryLimits{})
			if err != nil {
				t.Fatal(err)
			}
			want := []CatalogGridCell{{Kind: CatalogGridDate, Value: "2026-01-02"}, {Kind: CatalogGridDateTime, Value: "2026-01-02 03:04:05.500000"}}
			if len(grid.Rows) != 1 || grid.Rows[0][1] != want[0] || grid.Rows[0][2] != want[1] {
				t.Fatalf("ReadOnlyGridQuery rows = %#v; want the cells %#v", grid.Rows, want)
			}
		})
	}
}
