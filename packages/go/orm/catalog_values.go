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

	"github.com/polyspec/orm/packages/go/engine/ir"
)

// The catalog conversion of a driver value follows the catalog value rules (docs/spec/interfaces.md, "Catalog value
// rules", INT-165 to INT-185) in a read-only grid query, a plain read-only query and every read of a described table. Each
// rule has one code and one text; a refusal names the 1-based position of its column and no value, label or type name.

// catalogRule is a refusal of one catalog value rule: its code, its text and, for a value that the driver could not decode
// (INT-172), the failure that it keeps as its cause.
type catalogRule struct {
	code  string
	text  string
	cause error
}

// at is the error of the rule for the value of the 1-based column n: CODE: column n: text.
func (r *catalogRule) at(column int) error {
	return &ir.Error{Code: r.code, Msg: fmt.Sprintf("column %d: %s", column, r.text), Cause: r.cause}
}

// The rules of the table of INT-165, by their ID.
var (
	catalogRuleYear            = &catalogRule{code: CodeCatalogValue, text: "MySQL YEAR has no grid cell"}                                                // INT-166
	catalogRuleMySQLTimestamp  = &catalogRule{code: CodeCatalogValue, text: "MySQL TIMESTAMP follows a time zone"}                                        // INT-167
	catalogRulePostgresZoned   = &catalogRule{code: CodeCatalogValue, text: "PostgreSQL timestamptz and timetz are unsupported"}                          // INT-168
	catalogRuleNumericInfinite = &catalogRule{code: CodeCatalogValue, text: "PostgreSQL numeric is not finite"}                                           // INT-169
	catalogRuleNativeType      = &catalogRule{code: CodeCatalogValue, text: "unsupported native type"}                                                    // INT-170
	catalogRuleDriverValue     = &catalogRule{code: CodeCatalogValue, text: "unsupported driver value"}                                                   // INT-171
	catalogRuleDateRange       = &catalogRule{code: CodeGridTemporalValue, text: "date outside 0001-01-01 to 9999-12-31"}                                 // INT-173
	catalogRuleCalendarDate    = &catalogRule{code: CodeGridTemporalValue, text: "date is not a calendar date"}                                           // INT-174
	catalogRuleTimeRange       = &catalogRule{code: CodeGridTemporalValue, text: "time outside 00:00:00 to 23:59:59.999999"}                              // INT-175
	catalogRuleStoredDate      = &catalogRule{code: CodeGridTemporalValue, text: "the stored value is not a dbspec date"}                                 // INT-176
	catalogRuleStoredTime      = &catalogRule{code: CodeGridTemporalValue, text: "the stored value is not a dbspec time"}                                 // INT-177
	catalogRuleStoredDateTime  = &catalogRule{code: CodeGridTemporalValue, text: "the stored value is not a dbspec datetime"}                             // INT-178
	catalogRuleCheckDigits     = &catalogRule{code: CodeGridTemporalPrecision, text: "the fraction digits are not the count that its dbspec CHECK fixes"} // INT-179
	catalogRulePastPrecision   = &catalogRule{code: CodeGridTemporalPrecision, text: "temporal value has more fraction digits than its precision"}        // INT-180
	catalogRuleNativePrecision = &catalogRule{code: CodeGridTemporalPrecision, text: "native type declares more than 6 fraction digits"}                  // INT-181
	catalogRuleBooleanValue    = &catalogRule{code: CodeCatalogValue, text: "a boolean column holds a value that is not a boolean"}                       // INT-182
	catalogTextDecodeFailure   = "the driver could not decode the value"                                                                                  // INT-172
)

// catalogRuleStoredValue is the rule of a SQLite stored value outside the dbspec form of its kind (INT-176 to INT-178).
var catalogRuleStoredValue = map[string]*catalogRule{"date": catalogRuleStoredDate, "time": catalogRuleStoredTime, "datetime": catalogRuleStoredDateTime}

// catalogDecodeRule is the refusal of a value that the driver or a library failed to decode (INT-172); it keeps the
// failure as its cause.
func catalogDecodeRule(cause error) *catalogRule {
	return &catalogRule{code: CodeCatalogValue, text: catalogTextDecodeFailure, cause: cause}
}

// catalogPgxDecode is the form in which pgx reports a value that it could not decode: its stdlib Rows.Next returns
// fmt.Errorf("convert field %d failed: %w", i, err) with the 0-based index of the field (pgx v5 stdlib/sql.go).
var catalogPgxDecode = regexp.MustCompile(`^convert field ([0-9]+) failed: `)

// catalogDecodeFailure is the catalog error of a row that the driver could not decode, or nil for any other failure of a
// read. pgx names the field of the value; go-sql-driver/mysql and the SQLite drivers decode no value that they can fail on
// without naming its column, so only a PostgreSQL failure is one.
func catalogDecodeFailure(err error, dialect string) error {
	if dialect != "postgres" {
		return nil
	}
	match := catalogPgxDecode.FindStringSubmatch(err.Error())
	if match == nil {
		return nil
	}
	return catalogDecodeRule(err).at(catalogDigits(match[1]) + 1)
}

// catalogDigits is the number that a text of decimal digits, which a pattern matched, writes; it is bounded by the pattern.
func catalogDigits(digits string) int {
	n := 0
	for i := 0; i < len(digits); i++ {
		n = n*10 + int(digits[i]-'0')
	}
	return n
}

// catalogType is what the conversion takes from the native type of a column: the cell kind of its values, or the rule
// that refuses each of its values that is not NULL. unsigned marks a MySQL UNSIGNED integer.
type catalogType struct {
	kind     CatalogGridKind
	refusal  *catalogRule
	unsigned bool
	// integerText marks a text type whose driver value is an integer: a PostgreSQL oid, whose text is its digits.
	integerText bool
}

// catalogMySQLType is the type of a column by the name that go-sql-driver/mysql reports for it (fields.go,
// typeDatabaseName). MySQL BIT and the spatial types are bytes cells, and JSON, ENUM and SET text cells (INT-185).
func catalogMySQLType(native string) catalogType {
	unsigned := strings.HasPrefix(native, "UNSIGNED ")
	switch strings.TrimPrefix(native, "UNSIGNED ") {
	case "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT":
		return catalogType{kind: CatalogGridInteger, unsigned: unsigned}
	case "FLOAT":
		return catalogType{kind: CatalogGridFloat32}
	case "DOUBLE":
		return catalogType{kind: CatalogGridFloat64}
	case "DECIMAL":
		return catalogType{kind: CatalogGridDecimal}
	case "DATE":
		return catalogType{kind: CatalogGridDate}
	case "TIME":
		return catalogType{kind: CatalogGridTime}
	case "DATETIME":
		return catalogType{kind: CatalogGridDateTime}
	case "YEAR":
		return catalogType{refusal: catalogRuleYear}
	case "TIMESTAMP":
		return catalogType{refusal: catalogRuleMySQLTimestamp}
	case "CHAR", "VARCHAR", "TINYTEXT", "TEXT", "MEDIUMTEXT", "LONGTEXT", "JSON", "ENUM", "SET":
		return catalogType{kind: CatalogGridText}
	case "BINARY", "VARBINARY", "TINYBLOB", "BLOB", "MEDIUMBLOB", "LONGBLOB", "BIT", "GEOMETRY":
		return catalogType{kind: CatalogGridBinary}
	case "NULL":
		// The type of a NULL literal holds no other value.
		return catalogType{kind: CatalogGridNull}
	}
	return catalogType{refusal: catalogRuleNativeType}
}

// catalogPostgresNamed is the type of a PostgreSQL column by the upper-case name of its type, as pgx reports a type of its
// type map and as pg_type names a built-in type; ok is false for a name that INT-185 does not name, which INT-170 refuses.
func catalogPostgresNamed(name string) (catalogType, bool) {
	switch name {
	case "BOOL":
		return catalogType{kind: CatalogGridBoolean}, true
	case "INT2", "INT4", "INT8":
		return catalogType{kind: CatalogGridInteger}, true
	case "OID":
		// An oid is a text cell (INT-185); pgx sends it as an integer.
		return catalogType{kind: CatalogGridText, integerText: true}, true
	case "FLOAT4":
		return catalogType{kind: CatalogGridFloat32}, true
	case "FLOAT8":
		return catalogType{kind: CatalogGridFloat64}, true
	case "NUMERIC":
		return catalogType{kind: CatalogGridDecimal}, true
	case "BYTEA":
		return catalogType{kind: CatalogGridBinary}, true
	case "DATE":
		return catalogType{kind: CatalogGridDate}, true
	case "TIME":
		return catalogType{kind: CatalogGridTime}, true
	case "TIMESTAMP":
		return catalogType{kind: CatalogGridDateTime}, true
	case "TIMESTAMPTZ", "TIMETZ":
		return catalogType{refusal: catalogRulePostgresZoned}, true
	case "TEXT", "VARCHAR", "BPCHAR", "NAME", "CHAR", "UUID", "JSON", "JSONB", "XML", "BIT", "VARBIT", "INET", "CIDR", "MACADDR",
		"MACADDR8", "TSVECTOR", "TSQUERY", "PG_LSN":
		// No setting changes the output of these types (INT-185). A type that INT-185 does not name is refused.
		return catalogType{kind: CatalogGridText}, true
	case "INT4RANGE", "INT8RANGE", "NUMRANGE", "INT4MULTIRANGE", "INT8MULTIRANGE", "NUMMULTIRANGE":
		// A range writes its bounds by the output of its subtype, which no setting changes.
		return catalogType{kind: CatalogGridText}, true
	}
	if element, isArray := strings.CutPrefix(name, "_"); isArray {
		// An array writes each element by the output of its type (INT-185).
		elementType, known := catalogPostgresNamed(element)
		if known && catalogFixedOutput(elementType) {
			return catalogType{kind: CatalogGridText}, true
		}
		return catalogType{refusal: catalogRuleNativeType}, true
	}
	return catalogType{}, false
}

// catalogFixedOutput reports whether the text output of a type depends on no session setting, so that an array, a range or
// a composite of it is a text cell: an integer, a decimal, a boolean and a text type. A float follows extra_float_digits,
// a date or a time DateStyle and TimeZone, and bytea bytea_output, and a refused type stays refused.
func catalogFixedOutput(t catalogType) bool {
	if t.refusal != nil {
		return false
	}
	switch t.kind {
	case CatalogGridInteger, CatalogGridDecimal, CatalogGridBoolean, CatalogGridText:
		return true
	}
	return false
}

// catalogCells converts the driver values of one read to grid cells. A PostgreSQL type that pgx does not know reaches it
// as the decimal OID of the type, and the conversion reads its kind from pg_type once per read.
type catalogCells struct {
	ctx      context.Context
	catalog  *CatalogConnection
	dialect  string
	postgres map[uint32]catalogType
}

func newCatalogCells(s *catalogSession) *catalogCells {
	return &catalogCells{ctx: s.ctx, catalog: s.catalog, dialect: s.dialect, postgres: map[uint32]catalogType{}}
}

// cell is the grid cell of the driver value of the 1-based column of the native type that the driver reports.
func (c *catalogCells) cell(value any, native string, column int) (CatalogGridCell, error) {
	if value == nil {
		return CatalogGridCell{Kind: CatalogGridNull}, nil
	}
	if c.dialect == "sqlite" {
		cell, rule := catalogSQLiteCell(value)
		if rule != nil {
			return CatalogGridCell{}, rule.at(column)
		}
		return cell, nil
	}
	t, err := c.nativeType(native)
	if err != nil {
		return CatalogGridCell{}, err
	}
	cell, rule := catalogConvertCell(t, value, c.dialect)
	if rule != nil {
		return CatalogGridCell{}, rule.at(column)
	}
	return cell, nil
}

// nativeType is the type of a MySQL or PostgreSQL column by the name that its driver reports.
func (c *catalogCells) nativeType(native string) (catalogType, error) {
	native = strings.ToUpper(native)
	if c.dialect == "mysql" {
		return catalogMySQLType(native), nil
	}
	oid, err := strconv.ParseUint(native, 10, 32)
	if err != nil {
		if t, ok := catalogPostgresNamed(native); ok {
			return t, nil
		}
		return catalogType{refusal: catalogRuleNativeType}, nil
	}
	if t, ok := c.postgres[uint32(oid)]; ok {
		return t, nil
	}
	// The read that asks may still stream its rows on its own connection, so pg_type is read in a session of its own; a type
	// that a read sees is committed, and so is one that this session sees.
	t, err := catalogRead(c.ctx, c.catalog, func(s *catalogSession) (catalogType, error) {
		return s.postgresType(uint32(oid), 0)
	})
	if err != nil {
		return catalogType{}, err
	}
	c.postgres[uint32(oid)] = t
	return t, nil
}

// catalogPostgresTypeDepth bounds the nesting of the types that postgresType follows: an array of a composite of a range,
// and so on. A deeper type is refused by INT-170.
const catalogPostgresTypeDepth = 16

// postgresType is the type of a PostgreSQL type OID by pg_type (INT-185): an enum is a text cell, a domain takes the rule
// of its base type, and an array, a range, a multirange or a composite is a text cell when every type that it writes has a
// fixed output. A built-in type is classified by its name, and any other type, the base type of an extension or of a user
// included, is refused by INT-170.
func (s *catalogSession) postgresType(oid uint32, depth int) (catalogType, error) {
	refused := catalogType{refusal: catalogRuleNativeType}
	if depth > catalogPostgresTypeDepth {
		return refused, nil
	}
	query := "SELECT n.nspname::text, t.typname::text, t.typtype::text, t.typelem::bigint, t.typbasetype::bigint, " +
		"COALESCE(r.rngsubtype, m.rngsubtype, 0)::bigint, t.typrelid::bigint FROM pg_type t " +
		"JOIN pg_namespace n ON n.oid = t.typnamespace LEFT JOIN pg_range r ON r.rngtypid = t.oid " +
		"LEFT JOIN pg_range m ON m.rngmultitypid = t.oid WHERE t.oid = $1"
	raw, err := s.queryRaw(query, []any{int64(oid)}, 2, catalogMetadataBytes)
	if err != nil {
		return catalogType{}, err
	}
	rows, err := catalogConvert(raw, raw.types)
	if err != nil {
		return catalogType{}, err
	}
	if len(rows) != 1 {
		return refused, nil
	}
	row := rows[0]
	namespace, nameOK := row[0].(string)
	name, typeOK := row[1].(string)
	kind, kindOK := row[2].(string)
	element, elementOK := row[3].(int64)
	base, baseOK := row[4].(int64)
	subtype, subtypeOK := row[5].(int64)
	relation, relationOK := row[6].(int64)
	if !nameOK || !typeOK || !kindOK || !elementOK || !baseOK || !subtypeOK || !relationOK {
		return catalogType{}, catalogErr(catalogCodeMetadata, "pg_type returned a row of other types")
	}
	fixed := func(oids ...int64) (catalogType, error) {
		for _, oid := range oids {
			t, err := s.postgresType(uint32(oid), depth+1)
			if err != nil {
				return catalogType{}, err
			}
			if !catalogFixedOutput(t) {
				return refused, nil
			}
		}
		return catalogType{kind: CatalogGridText}, nil
	}
	switch kind {
	case "e":
		return catalogType{kind: CatalogGridText}, nil
	case "d":
		return s.postgresType(uint32(base), depth+1)
	case "r", "m":
		return fixed(subtype)
	case "c":
		raw, err := s.queryRaw("SELECT atttypid::bigint FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum", []any{relation}, catalogMetadataRows, catalogMetadataBytes)
		if err != nil {
			return catalogType{}, err
		}
		fields, err := catalogConvert(raw, raw.types)
		if err != nil {
			return catalogType{}, err
		}
		oids := make([]int64, len(fields))
		for i, field := range fields {
			oid, ok := field[0].(int64)
			if !ok {
				return catalogType{}, catalogErr(catalogCodeMetadata, "pg_attribute returned a type of another kind")
			}
			oids[i] = oid
		}
		return fixed(oids...)
	case "b":
		if element != 0 && strings.HasPrefix(name, "_") {
			return fixed(element)
		}
		if namespace == "pg_catalog" {
			if t, ok := catalogPostgresNamed(strings.ToUpper(name)); ok {
				return t, nil
			}
		}
	}
	return refused, nil
}

// catalogSQLiteCell is the grid cell of a SQLite value by its storage class (INT-152, INT-184): no conversion refuses a
// value for the type that its column declares.
func catalogSQLiteCell(value any) (CatalogGridCell, *catalogRule) {
	switch v := value.(type) {
	case int64:
		return CatalogGridCell{Kind: CatalogGridInteger, Value: v}, nil
	case float64:
		return CatalogGridCell{Kind: CatalogGridFloat64, Value: math.Float64bits(v)}, nil
	case string:
		return catalogTextCell(v), nil
	case []byte:
		return CatalogGridCell{Kind: CatalogGridBinary, Value: append([]byte(nil), v...)}, nil
	}
	return CatalogGridCell{}, catalogRuleDriverValue
}

// catalogTextCell is the text cell of a text, or the binary cell of its bytes when they are not valid UTF-8 (INT-153).
func catalogTextCell(text string) CatalogGridCell {
	if !utf8.ValidString(text) {
		return CatalogGridCell{Kind: CatalogGridBinary, Value: []byte(text)}
	}
	return CatalogGridCell{Kind: CatalogGridText, Value: text}
}

// catalogDriverText is the text of a driver value that a driver sends as text or as its bytes.
func catalogDriverText(value any) (string, bool) {
	switch v := value.(type) {
	case string:
		return v, true
	case []byte:
		return string(v), true
	}
	return "", false
}

var (
	catalogDecimalText = regexp.MustCompile(`^-?[0-9]+(?:\.[0-9]+)?$`)
	catalogDateText    = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})$`)
	catalogClockText   = regexp.MustCompile(`^(-?)([0-9]{2,3}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?$`)
	catalogStampText   = regexp.MustCompile(`^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?)$`)
)

// catalogConvertCell is the grid cell of a MySQL or PostgreSQL driver value of a column of type t. A value that is not the
// host form of a value of its column type is refused by INT-171.
func catalogConvertCell(t catalogType, value any, dialect string) (CatalogGridCell, *catalogRule) {
	if t.refusal != nil {
		return CatalogGridCell{}, t.refusal
	}
	cell := func(kind CatalogGridKind, v any) (CatalogGridCell, *catalogRule) {
		return CatalogGridCell{Kind: kind, Value: v}, nil
	}
	switch t.kind {
	case CatalogGridInteger:
		return catalogIntegerCell(value, t.unsigned)
	case CatalogGridFloat32:
		switch v := value.(type) {
		case float32:
			return cell(CatalogGridFloat32, math.Float32bits(v))
		case float64:
			// pgx widens a real to a float64, which holds it exactly.
			if narrow := float32(v); float64(narrow) == v || math.IsNaN(v) {
				return cell(CatalogGridFloat32, math.Float32bits(narrow))
			}
		}
	case CatalogGridFloat64:
		if v, ok := value.(float64); ok {
			return cell(CatalogGridFloat64, math.Float64bits(v))
		}
	case CatalogGridDecimal:
		text, ok := catalogDriverText(value)
		if !ok {
			break
		}
		if dialect == "postgres" && (text == "NaN" || text == "Infinity" || text == "-Infinity") {
			return CatalogGridCell{}, catalogRuleNumericInfinite
		}
		if catalogDecimalText.MatchString(text) {
			return cell(CatalogGridDecimal, text)
		}
	case CatalogGridText:
		if n, ok := value.(int64); ok && t.integerText {
			return cell(CatalogGridText, strconv.FormatInt(n, 10))
		}
		if text, ok := catalogDriverText(value); ok && !t.integerText {
			return catalogTextCell(text), nil
		}
	case CatalogGridBinary:
		if v, ok := value.([]byte); ok {
			return cell(CatalogGridBinary, append([]byte(nil), v...))
		}
	case CatalogGridBoolean:
		if v, ok := value.(bool); ok {
			return cell(CatalogGridBoolean, v)
		}
	case CatalogGridDate, CatalogGridTime, CatalogGridDateTime:
		return catalogTemporalCell(t.kind, value)
	}
	return CatalogGridCell{}, catalogRuleDriverValue
}

// catalogIntegerCell is the integer cell of an integer value, or the unsigned cell of a value of a MySQL UNSIGNED column.
// go-sql-driver/mysql sends an unsigned value beyond the signed 64-bit range as its digits in the binary protocol.
func catalogIntegerCell(value any, unsigned bool) (CatalogGridCell, *catalogRule) {
	switch v := value.(type) {
	case int64:
		if !unsigned {
			return CatalogGridCell{Kind: CatalogGridInteger, Value: v}, nil
		}
		if v >= 0 {
			return CatalogGridCell{Kind: CatalogGridUnsigned, Value: uint64(v)}, nil
		}
	case uint64:
		if unsigned {
			return CatalogGridCell{Kind: CatalogGridUnsigned, Value: v}, nil
		}
		if v <= math.MaxInt64 {
			return CatalogGridCell{Kind: CatalogGridInteger, Value: int64(v)}, nil
		}
	case string, []byte:
		text, _ := catalogDriverText(v)
		if unsigned {
			if u, err := strconv.ParseUint(text, 10, 64); err == nil {
				return CatalogGridCell{Kind: CatalogGridUnsigned, Value: u}, nil
			}
		} else if n, err := strconv.ParseInt(text, 10, 64); err == nil {
			return CatalogGridCell{Kind: CatalogGridInteger, Value: n}, nil
		}
	}
	return CatalogGridCell{}, catalogRuleDriverValue
}

// catalogTemporalCell is the date, time or datetime cell of a driver value: its dbspec text, with six fraction digits for
// a time or a datetime (INT-103). MySQL sends the text of each value, since the catalog connection does not parse times;
// PostgreSQL sends a date and a timestamp as a time.Time, its infinities as text, and a time as text.
func catalogTemporalCell(kind CatalogGridKind, value any) (CatalogGridCell, *catalogRule) {
	if v, ok := value.(time.Time); ok {
		return catalogTimeCell(kind, v)
	}
	text, ok := catalogDriverText(value)
	if !ok {
		return CatalogGridCell{}, catalogRuleDriverValue
	}
	if kind != CatalogGridTime && (text == "infinity" || text == "-infinity") {
		// pgtype sends the PostgreSQL infinities of date and timestamp as their text (INT-173).
		return CatalogGridCell{}, catalogRuleDateRange
	}
	var out string
	var rule *catalogRule
	switch kind {
	case CatalogGridDate:
		out, rule = catalogDateTextCell(text)
	case CatalogGridTime:
		out, rule = catalogClockCell(text)
	default:
		match := catalogStampText.FindStringSubmatch(text)
		if match == nil {
			return CatalogGridCell{}, catalogRuleDriverValue
		}
		var date, clock string
		if date, rule = catalogDateTextCell(match[1]); rule == nil {
			clock, rule = catalogClockCell(match[2])
		}
		out = date + " " + clock
	}
	if rule != nil {
		return CatalogGridCell{}, rule
	}
	return CatalogGridCell{Kind: kind, Value: out}, nil
}

// catalogTimeCell is the date or datetime cell of a time.Time that pgx sends for a PostgreSQL date or timestamp; its wall
// clock is the value, in UTC. A date with a time of day and a time with a digit past six fraction digits are no host form
// of a value of their type (INT-171).
func catalogTimeCell(kind CatalogGridKind, v time.Time) (CatalogGridCell, *catalogRule) {
	if kind == CatalogGridTime || v.Nanosecond()%1000 != 0 {
		return CatalogGridCell{}, catalogRuleDriverValue
	}
	date, rule := catalogDateCell(v.Year(), int(v.Month()), v.Day())
	if rule != nil {
		return CatalogGridCell{}, rule
	}
	if kind == CatalogGridDate {
		if v.Hour() != 0 || v.Minute() != 0 || v.Second() != 0 || v.Nanosecond() != 0 {
			return CatalogGridCell{}, catalogRuleDriverValue
		}
		return CatalogGridCell{Kind: CatalogGridDate, Value: date}, nil
	}
	return CatalogGridCell{Kind: CatalogGridDateTime, Value: fmt.Sprintf("%s %02d:%02d:%02d.%06d", date, v.Hour(), v.Minute(), v.Second(), v.Nanosecond()/1000)}, nil
}

// catalogDateCell is the dbspec text YYYY-MM-DD of a date: its year must be from 1 to 9999 (INT-173), then its month and
// day must be of the calendar (INT-174), so the MySQL zero date is outside the range.
func catalogDateCell(year, month, day int) (string, *catalogRule) {
	if year < 1 || year > 9999 {
		return "", catalogRuleDateRange
	}
	if t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC); month < 1 || month > 12 || t.Year() != year || int(t.Month()) != month || t.Day() != day {
		return "", catalogRuleCalendarDate
	}
	return fmt.Sprintf("%04d-%02d-%02d", year, month, day), nil
}

// catalogDateTextCell checks the date text YYYY-MM-DD of a driver and returns it.
func catalogDateTextCell(text string) (string, *catalogRule) {
	match := catalogDateText.FindStringSubmatch(text)
	if match == nil {
		return "", catalogRuleDriverValue
	}
	return catalogDateCell(catalogDigits(match[1]), catalogDigits(match[2]), catalogDigits(match[3]))
}

// catalogClockCell checks the time text of a driver, [-][H]HH:MM:SS with up to six fraction digits, and returns it with six
// fraction digits. A time outside 00:00:00 to 23:59:59.999999 fails (INT-175): a MySQL TIME past a day, of three hour
// digits or negative, and PostgreSQL 24:00:00. A digit past six fraction digits is no host form of a time (INT-171).
func catalogClockCell(text string) (string, *catalogRule) {
	match := catalogClockText.FindStringSubmatch(text)
	if match == nil || len(match[5]) > 6 {
		return "", catalogRuleDriverValue
	}
	hour, minute, second := catalogDigits(match[2]), catalogDigits(match[3]), catalogDigits(match[4])
	if match[1] != "" || hour > 23 || minute > 59 || second > 59 {
		return "", catalogRuleTimeRange
	}
	fraction := match[5] + strings.Repeat("0", 6-len(match[5]))
	return fmt.Sprintf("%02d:%02d:%02d.%s", hour, minute, second, fraction), nil
}

// catalogCellValue is the Go value of a grid cell in a plain read-only query and a read of a described table: an int64, a
// uint64, a bool, a string (a decimal, a text and the dbspec text of a temporal cell), a copy of the bytes of a binary
// cell or nil. A float is a float32 or a float64 by its width; a plain read-only query widens it to a float64 (INT-183).
func catalogCellValue(cell CatalogGridCell) any {
	switch bits := cell.Value.(type) {
	case uint32:
		return math.Float32frombits(bits)
	case uint64:
		if cell.Kind == CatalogGridFloat64 {
			return math.Float64frombits(bits)
		}
	}
	return cell.Value
}
