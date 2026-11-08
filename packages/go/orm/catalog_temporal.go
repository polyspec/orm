package orm

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// A read of a described table returns the dbspec text of each date, time and datetime cell with exactly the declared
// precision p of its column (INT-103): a string, never a time.Time. MySQL and PostgreSQL take p from the native type, or
// the default of INT-101 (0 on MySQL, 6 on PostgreSQL) when the type names none; SQLite keeps the stored text, whose
// fraction digits must be the p that the dbspec CHECK of the column fixes.

var (
	catalogMySQLTimeType      = regexp.MustCompile(`^time(?:\(([0-6])\))?$`)
	catalogMySQLDateTimeType  = regexp.MustCompile(`^datetime(?:\(([0-6])\))?$`)
	catalogPostgresTimeType   = regexp.MustCompile(`^time(?:\(([0-6])\))? without time zone$`)
	catalogPostgresStampType  = regexp.MustCompile(`^timestamp(?:\(([0-6])\))? without time zone$`)
	catalogMySQLZonedType     = regexp.MustCompile(`^timestamp(?:\([0-6]\))?$`)
	catalogPostgresZonedType  = regexp.MustCompile(`^(?:timestamp|time)(?:\([0-6]\))? with time zone$`)
	catalogDescribedDateText  = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	catalogDescribedTimeText  = regexp.MustCompile(`^([0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,6}))?$`)
	catalogDescribedStampText = regexp.MustCompile(`^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?)$`)
	catalogCheckOpening       = regexp.MustCompile(`(?i)CHECK\s*\(`)
	catalogCheckGlob          = regexp.MustCompile(`GLOB '((?:\[0-9\])*)'`)
	catalogCheckWholeTemporal = regexp.MustCompile(`IS (time|datetime)\(`)
)

// catalogTemporalKind is the dbspec temporal kind of a native type of a dialect, date, time or datetime, with the
// precision p of a time or datetime; ok is false for every other type. A SQLite precision is the CHECK precision of the
// column, and declared is false when no CHECK fixes it.
func catalogTemporalKind(column CatalogColumn, dialect string) (kind string, precision int, declared bool, ok bool) {
	native := strings.TrimSpace(column.NativeType)
	// The pattern of each type captures the precision as one digit from 0 to 6.
	precisionOf := func(match []string, fallback int) int {
		if match[1] == "" {
			return fallback
		}
		return int(match[1][0] - '0')
	}
	switch dialect {
	case "mysql":
		lower := strings.ToLower(native)
		switch {
		case lower == "date":
			return "date", 0, true, true
		case catalogMySQLTimeType.MatchString(lower):
			return "time", precisionOf(catalogMySQLTimeType.FindStringSubmatch(lower), 0), true, true
		case catalogMySQLDateTimeType.MatchString(lower):
			return "datetime", precisionOf(catalogMySQLDateTimeType.FindStringSubmatch(lower), 0), true, true
		}
	case "postgres":
		lower := strings.ToLower(native)
		switch {
		case lower == "date":
			return "date", 0, true, true
		case catalogPostgresTimeType.MatchString(lower):
			return "time", precisionOf(catalogPostgresTimeType.FindStringSubmatch(lower), 6), true, true
		case catalogPostgresStampType.MatchString(lower):
			return "datetime", precisionOf(catalogPostgresStampType.FindStringSubmatch(lower), 6), true, true
		}
	case "sqlite":
		switch strings.ToUpper(native) {
		case "DATE":
			return "date", 0, true, true
		case "TIME", "DATETIME":
			kind = "time"
			if strings.ToUpper(native) == "DATETIME" {
				kind = "datetime"
			}
			if column.CheckPrecision == nil {
				return kind, 0, false, true
			}
			return kind, *column.CheckPrecision, true, true
		}
	}
	return "", 0, false, false
}

// catalogDescribedTemporal is the catalog value of one driver value of a described column: the dbspec text of a date,
// time or datetime column with exactly its declared precision, and every other value as it is. A value outside the
// dbspec form fails with GRID_TEMPORAL_VALUE, and a non-zero digit past p, or on SQLite fraction digits other than the
// CHECK precision, or than 0 with no CHECK, fails with GRID_TEMPORAL_PRECISION. A value of a MySQL TIMESTAMP or a
// PostgreSQL timestamptz or timetz column follows a time zone that dbspec declares for no column, and fails with
// CATALOG_VALUE (INT-103).
func catalogDescribedTemporal(value any, column CatalogColumn, dialect string) (any, error) {
	native := strings.ToLower(strings.TrimSpace(column.NativeType))
	if value != nil && (dialect == "mysql" && catalogMySQLZonedType.MatchString(native) || dialect == "postgres" && catalogPostgresZonedType.MatchString(native)) {
		return nil, catalogErr(CodeCatalogValue, "column %q of type %s follows a time zone, which dbspec does not declare", column.Name, column.NativeType)
	}
	kind, precision, declared, ok := catalogTemporalKind(column, dialect)
	if !ok || value == nil {
		return value, nil
	}
	invalid := func(format string, args ...any) (any, error) {
		return nil, catalogErr(CodeGridTemporalValue, "column %q: %s", column.Name, fmt.Sprintf(format, args...))
	}
	if dialect == "sqlite" {
		text, isText := value.(string)
		if !isText {
			return invalid("holds a value that is not a dbspec %s", kind)
		}
		digits, err := catalogDescribedFraction(text, kind)
		if err != nil {
			return invalid("%v", err)
		}
		if kind == "date" {
			return text, nil
		}
		if !declared {
			// INT-103 and DIA-24: a SQLite DATETIME or TIME with no CHECK has precision 0.
			precision = 0
		}
		if digits != precision {
			return nil, catalogErr(CodeGridTemporalPrecision, "column %q holds a fraction whose digits are not the %d that its dbspec CHECK fixes", column.Name, precision)
		}
		return text, nil
	}
	var text string
	switch v := value.(type) {
	case time.Time:
		if dialect == "mysql" && v.IsZero() {
			// INT-103 and T334-3-3-4: the MySQL zero date 0000-00-00 is a date outside 0001-01-01 to 9999-12-31, as the grid path refuses it.
			return invalid("MySQL zero date 0000-00-00 is outside 0001-01-01 to 9999-12-31")
		}
		date, err := catalogGridDate(v.Year(), int(v.Month()), v.Day())
		if err != nil {
			return invalid("%v", err)
		}
		switch kind {
		case "date":
			if v.Hour() != 0 || v.Minute() != 0 || v.Second() != 0 || v.Nanosecond() != 0 {
				return invalid("a date value has a time of day")
			}
			return date, nil
		case "datetime":
			if v.Nanosecond()%1000 != 0 {
				return nil, catalogErr(CodeGridTemporalPrecision, "column %q: a datetime value has a digit past six fraction digits", column.Name)
			}
			text = fmt.Sprintf("%s %02d:%02d:%02d.%06d", date, v.Hour(), v.Minute(), v.Second(), v.Nanosecond()/1000)
		default:
			return invalid("a time value of a %s column", kind)
		}
	case string:
		if _, err := catalogDescribedFraction(v, kind); err != nil {
			return invalid("%v", err)
		}
		if kind == "date" {
			return v, nil
		}
		text = v
		if kind == "time" {
			clock, err := catalogGridClock(v)
			if err != nil {
				return invalid("%v", err)
			}
			text = clock
		} else {
			match := catalogDescribedStampText.FindStringSubmatch(v)
			clock, err := catalogGridClock(match[2])
			if err != nil {
				return invalid("%v", err)
			}
			text = match[1] + " " + clock
		}
	default:
		return invalid("holds a value that is not a dbspec %s", kind)
	}
	// text has six fraction digits here; it keeps exactly p of them.
	dot := strings.LastIndexByte(text, '.')
	if strings.Trim(text[dot+1+precision:], "0") != "" {
		return nil, catalogErr(CodeGridTemporalPrecision, "column %q: a %s value has a non-zero digit past its %d fraction digits", column.Name, kind, precision)
	}
	if precision == 0 {
		return text[:dot], nil
	}
	return text[:dot+1+precision], nil
}

// catalogDescribedFraction checks that text is in the dbspec form of its kind and returns its number of fraction digits.
func catalogDescribedFraction(text, kind string) (int, error) {
	switch kind {
	case "date":
		if !catalogDescribedDateText.MatchString(text) {
			return 0, fmt.Errorf("the text is not a dbspec date")
		}
		_, err := catalogGridDateText(text)
		return 0, err
	case "time":
		match := catalogDescribedTimeText.FindStringSubmatch(text)
		if match == nil {
			return 0, fmt.Errorf("the text is not a dbspec time")
		}
		_, err := catalogGridClock(text)
		return len(match[2]), err
	}
	match := catalogDescribedStampText.FindStringSubmatch(text)
	if match == nil {
		return 0, fmt.Errorf("the text is not a dbspec datetime")
	}
	if _, err := catalogGridDateText(match[1]); err != nil {
		return 0, err
	}
	return catalogDescribedFraction(match[2], "time")
}

// catalogConvertDescribed converts the raw result of a read of a described table, a page or a row that a change reads
// back, with the native types of the descriptor and the dbspec text of its temporal columns.
func catalogConvertDescribed(raw catalogRaw, metadata CatalogTableMetadata, dialect string) ([][]any, error) {
	rows, err := catalogConvert(raw, catalogNativeTypes(metadata))
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		for i, column := range metadata.Columns {
			value, err := catalogDescribedTemporal(row[i], column, dialect)
			if err != nil {
				return nil, err
			}
			value, err = catalogDescribedBool(value, column, dialect)
			if err != nil {
				return nil, err
			}
			row[i] = value
		}
	}
	return rows, nil
}

// catalogDescribedBool reads a boolean column as a bool by its column type (DIA-29): a MySQL tinyint(1) and a SQLite
// BOOLEAN come back from the driver as the integer 0 or 1, and a PostgreSQL boolean already as a bool. Any other value of
// such a column fails.
func catalogDescribedBool(value any, column CatalogColumn, dialect string) (any, error) {
	native := strings.TrimSpace(column.NativeType)
	isBool := (dialect == "mysql" && strings.EqualFold(native, "tinyint(1)")) ||
		(dialect != "mysql" && strings.EqualFold(native, "boolean"))
	if !isBool || value == nil {
		return value, nil
	}
	switch v := value.(type) {
	case bool:
		return v, nil
	case int64:
		if v == 0 || v == 1 {
			return v == 1, nil
		}
	}
	return nil, catalogErr(catalogCodeValue, "column %q holds a value that is not a boolean", column.Name)
}

// catalogSelectList is the select list of a read of a described table, in physical order. The SQLite driver parses the
// text of a column declared DATE, DATETIME or TIMESTAMP into a time value; unary plus removes the declared type of each
// column while keeping its storage class and value, so the read keeps the stored text, as the grid query does.
func catalogSelectList(metadata CatalogTableMetadata, dialect string) string {
	if dialect != "sqlite" {
		return catalogColumnList(metadata, dialect)
	}
	items := make([]string, len(metadata.Columns))
	for i, column := range metadata.Columns {
		quoted := catalogQuote(column.Name, dialect)
		items[i] = "+" + quoted + " AS " + quoted
	}
	return strings.Join(items, ",")
}

// catalogTemporalWriteValue refuses a time.Time assigned to a date, time or datetime column: a catalog write takes the
// dbspec text of the column, and a time.Time has no declared precision.
func catalogTemporalWriteValue(column CatalogColumn, value any, dialect, code string) error {
	if _, isTime := value.(time.Time); !isTime {
		return nil
	}
	if kind, _, _, ok := catalogTemporalKind(column, dialect); ok {
		return catalogErr(code, "column %q takes the dbspec text of a %s, not a time.Time", column.Name, kind)
	}
	return nil
}

// catalogCheckPrecision is the number of fraction digits that the dbspec CHECK of a SQLite TIME or DATETIME column fixes
// (engine/dbspec/render.go): the count of the `[0-9]` groups of its GLOB, or 0 for a CHECK of the whole form without a
// fraction. ok is false when no CHECK of the table definition names the column.
func catalogCheckPrecision(tableSQL, column string) (int, bool) {
	quoted := `"` + strings.ReplaceAll(column, `"`, `""`) + `"`
	for _, clause := range catalogCheckClauses(tableSQL) {
		if !strings.Contains(clause, quoted) {
			continue
		}
		if glob := catalogCheckGlob.FindStringSubmatch(clause); glob != nil {
			return len(glob[1]) / len("[0-9]"), true
		}
		if catalogCheckWholeTemporal.MatchString(clause) {
			return 0, true
		}
	}
	return 0, false
}

// catalogCheckClauses is the text inside each CHECK ( ... ) of a table definition, balanced over its parentheses.
func catalogCheckClauses(tableSQL string) []string {
	var clauses []string
	for _, at := range catalogCheckOpening.FindAllStringIndex(tableSQL, -1) {
		depth, i := 1, at[1]
		for i < len(tableSQL) && depth > 0 {
			switch tableSQL[i] {
			case '(':
				depth++
			case ')':
				depth--
			}
			i++
		}
		if depth != 0 {
			clauses = append(clauses, tableSQL[at[1]:])
			continue
		}
		clauses = append(clauses, tableSQL[at[1]:i-1])
	}
	return clauses
}
