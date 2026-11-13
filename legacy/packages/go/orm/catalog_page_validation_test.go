package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// Requirements: INT-121.
// TestCatalogPagePreparedColumnsDifferFromTheDescriptor holds what no server can answer (INT-121): a statement names its
// columns in the select list, and a server answers with those names.
func TestCatalogPagePreparedColumnsDifferFromTheDescriptor(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	columns := []CatalogColumn{{Name: "id", NativeType: "INTEGER"}}
	if err := catalogSameNames([]string{"renamed"}, columns); ErrorCode(err) != catalogCodePageChanged {
		t.Fatalf("prepared column name mismatch error = %v, want %s", err, catalogCodePageChanged)
	}
	if err := catalogSameNames([]string{"id", "extra"}, columns); ErrorCode(err) != catalogCodePageChanged {
		t.Fatalf("prepared column count mismatch error = %v, want %s", err, catalogCodePageChanged)
	}
	if err := catalogSameNames([]string{"id"}, columns); err != nil {
		t.Fatalf("the same names were refused: %v", err)
	}
}

// catalogAnswerDriver is a driver whose connection answers the catalog queries with fixed rows, as the fake drivers of the
// other runtimes do: a statement succeeds, and a query answers the rows of the first prefix that it starts with. Its connection
// is a pointer, as a connection of a real driver is, and answers the connection id that a MySQL session reads (CFG-35).
type catalogAnswerDriver struct{ answers []catalogAnswer }

// catalogAnswer is the result of the queries that start with prefix: its column names, native types and rows.
type catalogAnswer struct {
	prefix string
	names  []string
	types  []string
	rows   [][]driver.Value
}

func (d catalogAnswerDriver) Open(string) (driver.Conn, error) {
	conn := catalogAnswerConn(d)
	return &conn, nil
}

type catalogAnswerConn catalogAnswerDriver

func (c catalogAnswerConn) Prepare(query string) (driver.Stmt, error) {
	return nil, fmt.Errorf("the answer driver prepares no statement: %s", query)
}
func (c catalogAnswerConn) Close() error { return nil }
func (c catalogAnswerConn) Begin() (driver.Tx, error) {
	return nil, errors.New("the answer driver begins no transaction")
}

func (c catalogAnswerConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (c catalogAnswerConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if query == "SELECT CONNECTION_ID()" {
		return &catalogAnswerRows{answer: catalogAnswer{names: []string{"CONNECTION_ID()"}, types: []string{"BIGINT"}, rows: [][]driver.Value{{int64(1)}}}}, nil
	}
	for _, answer := range c.answers {
		if strings.HasPrefix(query, answer.prefix) {
			return &catalogAnswerRows{answer: answer}, nil
		}
	}
	return nil, fmt.Errorf("the answer driver has no answer to %s", query)
}

type catalogAnswerRows struct {
	answer catalogAnswer
	next   int
}

func (r *catalogAnswerRows) Columns() []string                       { return r.answer.names }
func (r *catalogAnswerRows) Close() error                            { return nil }
func (r *catalogAnswerRows) ColumnTypeDatabaseTypeName(i int) string { return r.answer.types[i] }

func (r *catalogAnswerRows) Next(dest []driver.Value) error {
	if r.next == len(r.answer.rows) {
		return io.EOF
	}
	copy(dest, r.answer.rows[r.next])
	r.next++
	return nil
}

func (d catalogAnswerDriver) Connect(context.Context) (driver.Conn, error) { return d.Open("") }
func (d catalogAnswerDriver) Driver() driver.Driver                        { return d }

// catalogAnswering is a MariaDB catalog connection whose table app.defaults has the column broken with the default text.
func catalogAnswering(t *testing.T, text string) *CatalogConnection {
	t.Helper()
	pool := sql.OpenDB(catalogAnswerDriver{answers: []catalogAnswer{
		{prefix: "SELECT TABLE_TYPE", names: []string{"TABLE_TYPE"}, types: []string{"VARCHAR"}, rows: [][]driver.Value{{"BASE TABLE"}}},
		{
			prefix: "SELECT c.COLUMN_NAME",
			names:  []string{"COLUMN_NAME", "COLUMN_TYPE", "IS_NULLABLE", "GENERATED", "ORDINAL_POSITION", "AUTO_KEY", "COLUMN_DEFAULT", "EXPRESSION_DEFAULT"},
			types:  []string{"VARCHAR", "VARCHAR", "BIGINT", "BIGINT", "BIGINT", "BIGINT", "VARCHAR", "BIGINT"},
			rows: [][]driver.Value{
				{"id", "int", int64(0), int64(0), int64(1), int64(0), nil, int64(0)},
				{"broken", "varchar(40)", int64(1), int64(0), int64(0), int64(0), text, int64(0)},
			},
		},
	}})
	t.Cleanup(func() { testcase.Close(t, pool) })
	return &CatalogConnection{db: &DB{sql: pool, driver: "mysql", server: serverMariaDB}, dialect: "mysql"}
}

// Requirements: DIA-205.
// TestCatalogMariadbDefaultThatIsNotOneLiteralIsMetadataInvalid holds a quoted MariaDB default that is not one whole
// literal, which no server writes, so the recipes cannot hold it (FCV-2).
func TestCatalogMariadbDefaultThatIsNotOneLiteralIsMetadataInvalid(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, text := range []string{"'a' 'b'", "'unterminated", "'a'x"} {
		_, err := catalogAnswering(t, text).DescribeTable(context.Background(), CatalogTableRef{Namespace: "app", Name: "defaults"})
		want := "TABLE_METADATA_INVALID: column \"broken\": default " + text + " is not one string literal"
		if err == nil || err.Error() != want {
			t.Errorf("%s: error = %v, want %s", text, err, want)
		}
	}
}
