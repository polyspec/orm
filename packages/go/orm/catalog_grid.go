package orm

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// CatalogGridKind is the tag of a grid cell (docs/spec/interfaces.md, "Rust native grid query specification").
type CatalogGridKind string

// The tags of the grid cells: null, integer, unsigned, float32, float64, decimal, text, boolean, binary, date, time and
// datetime.
const (
	CatalogGridNull     CatalogGridKind = "null"
	CatalogGridInteger  CatalogGridKind = "integer"
	CatalogGridUnsigned CatalogGridKind = "unsigned"
	CatalogGridFloat32  CatalogGridKind = "float32"
	CatalogGridFloat64  CatalogGridKind = "float64"
	CatalogGridDecimal  CatalogGridKind = "decimal"
	CatalogGridText     CatalogGridKind = "text"
	CatalogGridBoolean  CatalogGridKind = "boolean"
	CatalogGridBinary   CatalogGridKind = "binary"
	CatalogGridDate     CatalogGridKind = "date"
	CatalogGridTime     CatalogGridKind = "time"
	CatalogGridDateTime CatalogGridKind = "datetime"
)

// CatalogGridCell is one typed cell of a grid query. Its Value is nil for null; an int64 for integer; a uint64 for
// unsigned; a uint32 for float32 and a uint64 for float64, both holding the IEEE-754 bits, so signed zero and nonfinite
// values are kept; a string for decimal, text, date, time and datetime (the dbspec text, with six fraction digits for
// time and datetime); a bool for boolean; and a copy of the bytes for binary.
type CatalogGridCell struct {
	Kind  CatalogGridKind
	Value any
}

// CatalogGridResult is the result of a grid query: its column names and its rows of typed cells.
type CatalogGridResult struct {
	Columns []string
	Rows    [][]CatalogGridCell
}

// ReadOnlyGridQuery runs one read query like ReadOnlyQuery and returns typed grid cells instead of catalog values. Each
// value follows the catalog value rules (docs/spec/interfaces.md, "Catalog value rules"): a value that a rule refuses fails
// with the code of the rule and the message CODE: column n: text, n the 1-based position of its column.
func (c *CatalogConnection) ReadOnlyGridQuery(ctx context.Context, query string, params []any, limits CatalogQueryLimits) (CatalogGridResult, error) {
	args, maxRows, maxBytes, err := c.readOnlyArgs(query, params, limits)
	if err != nil {
		return CatalogGridResult{}, err
	}
	return catalogRead(ctx, c, func(s *catalogSession) (CatalogGridResult, error) {
		statement := query
		var columns []string
		if c.dialect == "sqlite" {
			// The SQLite driver parses the text of a column declared DATE, DATETIME or TIMESTAMP into a time value, and
			// the grid must keep the stored text. Reading the columns through a positional CTE and unary plus removes the
			// declared type while keeping each storage class (docs/spec/interfaces.md, "Rust native grid query specification").
			names, err := s.columnNames(query, args)
			if err != nil {
				return CatalogGridResult{}, err
			}
			statement = catalogSQLiteRawQuery(query, len(names))
			columns = names
		}
		// Each value is converted to its grid cell as it is read, and the budget counts the cell (INT-115): the text of a
		// decimal or temporal cell, not the driver value it came from.
		var cells []CatalogGridCell
		convert := newCatalogCells(s)
		raw, err := s.querySized(statement, args, maxRows, maxBytes, func(value any, native string, column int) (int, error) {
			cell, err := convert.cell(value, native, column)
			if err != nil {
				return 0, err
			}
			cells = append(cells, cell)
			return catalogGridCellSize(cell), nil
		})
		if err != nil {
			return CatalogGridResult{}, err
		}
		rows := make([][]CatalogGridCell, 0, len(raw.rows))
		for i := range raw.rows {
			width := len(raw.names)
			rows = append(rows, cells[i*width:(i+1)*width])
		}
		if columns == nil {
			columns = raw.names
		}
		return CatalogGridResult{Columns: columns, Rows: rows}, nil
	})
}

// columnNames returns the column names of a query as the driver reports them for the query itself, without reading a row.
// A CTE would rename a duplicate name, so the names of the grid come from the query.
func (s *catalogSession) columnNames(query string, args []any) (names []string, err error) {
	rows, err := s.conn.QueryContext(s.ctx, query, args...)
	if err != nil {
		return nil, mapDriverErrContext(err, s.ctx)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil {
			names, err = nil, errors.Join(err, mapDriverErrContext(closeErr, s.ctx))
		}
	}()
	names, err = rows.Columns()
	if err != nil {
		return nil, mapDriverErr(err)
	}
	return names, nil
}

// catalogSQLiteRawQuery wraps a read query of width columns so that each result column is the unary plus of a positionally
// renamed column: the rows keep the storage class of each value and carry no declared type.
//
// Row order: the outer SELECT has no ORDER BY. SQLite's lang_select.html says: "If a SELECT statement that returns more than
// one row does not have an ORDER BY clause, the order in which the rows are returned is undefined." The order of the grid
// rows therefore rests on the query flattener, which folds this simple CTE into the inner query and keeps the inner ORDER BY
// (https://www.sqlite.org/optoverview.html#flattening, "Subquery Flattening"). That is SQLite's behaviour, not a documented
// promise. TestCoverageCatalogGridOrder checks the plan (no MATERIALIZE or CO-ROUTINE step for g) with an ORDER BY DESC query,
// so a SQLite that stops flattening fails the test instead of changing the order silently.
func catalogSQLiteRawQuery(query string, width int) string {
	names := make([]string, width)
	cols := make([]string, width)
	for i := range names {
		names[i] = fmt.Sprintf(`"c%d"`, i)
		cols[i] = "+" + names[i]
	}
	return "WITH g(" + strings.Join(names, ", ") + ") AS (\n" + query + "\n) SELECT " + strings.Join(cols, ", ") + " FROM g"
}

// catalogGridCellSize is the bytes that a grid cell counts against a result budget (INT-115): the UTF-8 bytes of a text,
// decimal or temporal cell, the length of a binary cell and 8 for every other cell, null included.
func catalogGridCellSize(cell CatalogGridCell) int {
	switch v := cell.Value.(type) {
	case string:
		return len(v)
	case []byte:
		return len(v)
	default:
		return 8
	}
}
