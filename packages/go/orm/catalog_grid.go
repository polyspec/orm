package orm

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
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

// ReadOnlyGridQuery runs one read query like ReadOnlyQuery and returns typed grid cells instead of catalog values. A value
// of a native type that has no grid cell, a MySQL TIMESTAMP, a PostgreSQL timestamptz or timetz, a time outside
// 00:00:00 to 23:59:59.999999, a date outside 0001-01-01 to 9999-12-31 and a PostgreSQL infinity fail with CATALOG_VALUE.
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
		raw, err := s.queryRaw(statement, args, maxRows, maxBytes)
		if err != nil {
			return CatalogGridResult{}, err
		}
		rows := make([][]CatalogGridCell, 0, len(raw.rows))
		for _, row := range raw.rows {
			cells := make([]CatalogGridCell, len(row))
			for i, value := range row {
				cell, err := catalogGridCell(value, raw.types[i], c.dialect)
				if err != nil {
					return CatalogGridResult{}, err
				}
				cells[i] = cell
			}
			rows = append(rows, cells)
		}
		if columns == nil {
			columns = raw.names
		}
		return CatalogGridResult{Columns: columns, Rows: rows}, nil
	})
}

// columnNames returns the column names of a query as the driver reports them for the query itself, without reading a row.
// A CTE would rename a duplicate name, so the names of the grid come from the query.
func (s *catalogSession) columnNames(query string, args []any) ([]string, error) {
	rows, err := s.conn.QueryContext(s.ctx, query, args...)
	if err != nil {
		return nil, mapDriverErr(err)
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, mapDriverErr(err)
	}
	return names, nil
}

// catalogSQLiteRawQuery wraps a read query of width columns so that each result column is the unary plus of a positionally
// renamed column: the rows keep the storage class of each value and carry no declared type.
func catalogSQLiteRawQuery(query string, width int) string {
	names := make([]string, width)
	cols := make([]string, width)
	for i := range names {
		names[i] = fmt.Sprintf(`"c%d"`, i)
		cols[i] = "+" + names[i]
	}
	return "WITH g(" + strings.Join(names, ", ") + ") AS (\n" + query + "\n) SELECT " + strings.Join(cols, ", ") + " FROM g"
}

var (
	catalogGridDateRE     = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})$`)
	catalogGridTimeRE     = regexp.MustCompile(`^([0-9]{2,3}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?$`)
	catalogGridDateTimeRE = regexp.MustCompile(`^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2,3}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?)$`)
)

// catalogGridCell is the grid cell of one driver value with the native type name that the driver reports for its column.
// SQLite has no native type names of its storage classes, so its cells follow the storage class of each value.
func catalogGridCell(value any, native string, dialect string) (CatalogGridCell, error) {
	native = strings.ToUpper(native)
	cell := func(kind CatalogGridKind, v any) (CatalogGridCell, error) {
		return CatalogGridCell{Kind: kind, Value: v}, nil
	}
	refuse := func(format string, args ...any) (CatalogGridCell, error) {
		return CatalogGridCell{}, catalogErr(catalogCodeValue, "grid value of native type %q: %s", native, fmt.Sprintf(format, args...))
	}
	if value == nil {
		return cell(CatalogGridNull, nil)
	}
	if dialect == "sqlite" {
		return catalogGridSQLite(value, refuse, cell)
	}
	switch native {
	case "TIMESTAMP":
		if dialect == "mysql" {
			return refuse("MySQL TIMESTAMP follows a time zone")
		}
	case "TIMESTAMPTZ", "TIMETZ":
		return refuse("PostgreSQL %s is unsupported", native)
	}
	switch v := value.(type) {
	case bool:
		return cell(CatalogGridBoolean, v)
	case int64:
		if strings.HasPrefix(native, "UNSIGNED ") {
			if v < 0 {
				return refuse("negative value %d", v)
			}
			return cell(CatalogGridUnsigned, uint64(v))
		}
		return cell(CatalogGridInteger, v)
	case uint64:
		return cell(CatalogGridUnsigned, v)
	case float32:
		return cell(CatalogGridFloat32, math.Float32bits(v))
	case float64:
		if native == "FLOAT4" || native == "FLOAT" {
			return cell(CatalogGridFloat32, math.Float32bits(float32(v)))
		}
		return cell(CatalogGridFloat64, math.Float64bits(v))
	case time.Time:
		return catalogGridTimeValue(v, native, dialect, refuse, cell)
	case string:
		return catalogGridTextual(v, native, dialect, refuse, cell)
	case []byte:
		if catalogGridBinaryName(native) {
			return cell(CatalogGridBinary, append([]byte(nil), v...))
		}
		return catalogGridTextual(string(v), native, dialect, refuse, cell)
	default:
		return refuse("driver value %T", value)
	}
}

// catalogGridSQLite is the grid cell of a SQLite value by its storage class.
func catalogGridSQLite(value any, refuse func(string, ...any) (CatalogGridCell, error), cell func(CatalogGridKind, any) (CatalogGridCell, error)) (CatalogGridCell, error) {
	switch v := value.(type) {
	case int64:
		return cell(CatalogGridInteger, v)
	case float64:
		return cell(CatalogGridFloat64, math.Float64bits(v))
	case string:
		if !utf8.ValidString(v) {
			return refuse("text is not valid UTF-8")
		}
		return cell(CatalogGridText, v)
	case []byte:
		return cell(CatalogGridBinary, append([]byte(nil), v...))
	default:
		return refuse("driver value %T", value)
	}
}

// catalogGridTimeValue is the grid cell of a driver time value: a MySQL DATE, DATETIME or a PostgreSQL DATE, TIMESTAMP. The
// wall clock of the value is the dbspec text, in UTC for the connection time zone of the driver.
func catalogGridTimeValue(v time.Time, native, dialect string, refuse func(string, ...any) (CatalogGridCell, error), cell func(CatalogGridKind, any) (CatalogGridCell, error)) (CatalogGridCell, error) {
	date, err := catalogGridDate(v.Year(), int(v.Month()), v.Day())
	if err != nil {
		return refuse("%v", err)
	}
	switch {
	case native == "DATE":
		return cell(CatalogGridDate, date)
	case native == "DATETIME" && dialect == "mysql", native == "TIMESTAMP" && dialect == "postgres":
		return cell(CatalogGridDateTime, fmt.Sprintf("%s %02d:%02d:%02d.%06d", date, v.Hour(), v.Minute(), v.Second(), v.Nanosecond()/1000))
	default:
		return refuse("a time value has no grid cell in %s", dialect)
	}
}

// catalogGridTextual is the grid cell of a value that the driver returns as text: a decimal, a time, a date, a datetime,
// an unsigned, a float or a character value. Binary columns are handled before it.
func catalogGridTextual(text string, native, dialect string, refuse func(string, ...any) (CatalogGridCell, error), cell func(CatalogGridKind, any) (CatalogGridCell, error)) (CatalogGridCell, error) {
	if dialect == "mysql" && strings.HasPrefix(native, "UNSIGNED ") {
		u, err := strconv.ParseUint(text, 10, 64)
		if err != nil {
			return refuse("unsigned integer %q: %v", text, err)
		}
		return cell(CatalogGridUnsigned, u)
	}
	base := strings.TrimPrefix(native, "UNSIGNED ")
	switch base {
	case "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT":
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return refuse("integer %q: %v", text, err)
		}
		return cell(CatalogGridInteger, n)
	case "FLOAT":
		f, err := strconv.ParseFloat(text, 32)
		if err != nil {
			return refuse("float %q: %v", text, err)
		}
		return cell(CatalogGridFloat32, math.Float32bits(float32(f)))
	case "DOUBLE":
		f, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return refuse("float %q: %v", text, err)
		}
		return cell(CatalogGridFloat64, math.Float64bits(f))
	case "DECIMAL", "NUMERIC":
		if !catalogGridFiniteDecimal(text) {
			return refuse("nonfinite decimal %q", text)
		}
		return cell(CatalogGridDecimal, text)
	case "TIME":
		clock, err := catalogGridClock(text)
		if err != nil {
			return refuse("%v", err)
		}
		return cell(CatalogGridTime, clock)
	case "DATE":
		date, err := catalogGridDateText(text)
		if err != nil {
			return refuse("%v", err)
		}
		return cell(CatalogGridDate, date)
	case "DATETIME", "TIMESTAMP":
		match := catalogGridDateTimeRE.FindStringSubmatch(text)
		if match == nil {
			return refuse("datetime text %q", text)
		}
		date, err := catalogGridDateText(match[1])
		if err != nil {
			return refuse("%v", err)
		}
		clock, err := catalogGridClock(match[2])
		if err != nil {
			return refuse("%v", err)
		}
		return cell(CatalogGridDateTime, date+" "+clock)
	}
	if catalogGridTextName(native) {
		if !utf8.ValidString(text) {
			return refuse("text is not valid UTF-8")
		}
		return cell(CatalogGridText, text)
	}
	return refuse("unsupported native type %q", native)
}

// catalogGridBinaryName reports the native types of binary columns: MySQL BINARY, VARBINARY and the BLOB family, and
// PostgreSQL bytea.
func catalogGridBinaryName(native string) bool {
	switch native {
	case "BINARY", "VARBINARY", "BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB", "BYTEA":
		return true
	}
	return false
}

// catalogGridTextName reports the native types whose values are text, as catalogBytesValue reads them.
func catalogGridTextName(native string) bool {
	return strings.Contains(native, "CHAR") || strings.Contains(native, "TEXT") || strings.Contains(native, "JSON") ||
		strings.Contains(native, "ENUM") || native == "SET" || strings.Contains(native, "UUID") ||
		strings.Contains(native, "XML") || strings.Contains(native, "NAME")
}

// catalogGridFiniteDecimal reports whether a decimal text is a finite plain number; PostgreSQL writes NaN and the
// infinities of numeric as text.
func catalogGridFiniteDecimal(text string) bool {
	return text != "" && text != "NaN" && !strings.Contains(text, "Infinity")
}

// catalogGridDate is the dbspec text YYYY-MM-DD of a calendar date from 0001-01-01 to 9999-12-31.
func catalogGridDate(year, month, day int) (string, error) {
	if year < 1 || year > 9999 {
		return "", fmt.Errorf("date outside 0001-01-01 to 9999-12-31")
	}
	if t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC); t.Year() != year || int(t.Month()) != month || t.Day() != day {
		return "", fmt.Errorf("date %04d-%02d-%02d is not a calendar date", year, month, day)
	}
	return fmt.Sprintf("%04d-%02d-%02d", year, month, day), nil
}

// catalogGridDateText checks a date text YYYY-MM-DD and returns it.
func catalogGridDateText(text string) (string, error) {
	match := catalogGridDateRE.FindStringSubmatch(text)
	if match == nil {
		return "", fmt.Errorf("date text %q", text)
	}
	year, _ := strconv.Atoi(match[1])
	month, _ := strconv.Atoi(match[2])
	day, _ := strconv.Atoi(match[3])
	return catalogGridDate(year, month, day)
}

// catalogGridClock checks a time text HH:MM:SS with up to six fraction digits, and returns it with six fraction digits.
// A time outside 00:00:00 to 23:59:59.999999 fails, which includes a negative MySQL TIME and PostgreSQL 24:00:00.
func catalogGridClock(text string) (string, error) {
	match := catalogGridTimeRE.FindStringSubmatch(text)
	if match == nil {
		return "", fmt.Errorf("time text %q", text)
	}
	hour, _ := strconv.Atoi(match[1])
	minute, _ := strconv.Atoi(match[2])
	second, _ := strconv.Atoi(match[3])
	if hour > 23 || minute > 59 || second > 59 {
		return "", fmt.Errorf("time outside 00:00:00 to 23:59:59.999999")
	}
	fraction := match[4] + strings.Repeat("0", 6-len(match[4]))
	return fmt.Sprintf("%02d:%02d:%02d.%s", hour, minute, second, fraction), nil
}
