package orm

import (
	"regexp"
	"strconv"
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
	catalogMySQLPrecisionType = regexp.MustCompile(`^(?:time|datetime)\((.*)\)$`)
	catalogPostgresPrecision  = regexp.MustCompile(`^(?:time|timestamp)\((.*)\) without time zone$`)
	catalogDescribedDateText  = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})$`)
	catalogDescribedTimeText  = regexp.MustCompile(`^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?$`)
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

// catalogNativePrecisionRule refuses the native type of a MySQL or PostgreSQL time or datetime column that declares a
// precision above 6 or one that is not a number (INT-181); no database declares one, and p is read from the type.
func catalogNativePrecisionRule(column CatalogColumn, dialect string) *catalogRule {
	native := strings.ToLower(strings.TrimSpace(column.NativeType))
	pattern := catalogMySQLPrecisionType
	if dialect == "postgres" {
		pattern = catalogPostgresPrecision
	}
	match := pattern.FindStringSubmatch(native)
	if match == nil {
		return nil
	}
	if p, err := strconv.Atoi(match[1]); err != nil || p < 0 || p > 6 || strconv.Itoa(p) != match[1] {
		return catalogRuleNativePrecision
	}
	return nil
}

// catalogDescribedPrecision is the dbspec text of a time or datetime cell, which has six fraction digits, with exactly the
// p digits of its column; a non-zero digit past p fails (INT-180).
func catalogDescribedPrecision(text string, precision int) (string, *catalogRule) {
	dot := strings.LastIndexByte(text, '.')
	if strings.Trim(text[dot+1+precision:], "0") != "" {
		return "", catalogRulePastPrecision
	}
	if precision == 0 {
		return text[:dot], nil
	}
	return text[:dot+1+precision], nil
}

// convertDescribed converts the raw result of a read of a described table, a page or a row that a change reads back, by
// the catalog value rules: each value takes the cell of the native type that its driver reports, and a value of the 1-based
// column n among the described columns that a rule refuses fails with CODE: column n: text. The Go value of a cell is that
// of catalogCellValue, a float a float32 or a float64 by its width (INT-183); a date, time or datetime is its dbspec text
// with the declared precision p of its column, and a boolean column a bool.
func (s *catalogSession) convertDescribed(raw catalogRaw, metadata CatalogTableMetadata) ([][]any, error) {
	if len(raw.types) != len(metadata.Columns) {
		return nil, catalogErr(catalogCodeMetadata, "%d native types for %d columns", len(raw.types), len(metadata.Columns))
	}
	cells := newCatalogCells(s)
	out := make([][]any, 0, len(raw.rows))
	for _, row := range raw.rows {
		converted := make([]any, len(row))
		for i, value := range row {
			column := metadata.Columns[i]
			var v any
			var rule *catalogRule
			if s.dialect == "sqlite" {
				v, rule = catalogSQLiteDescribed(value, column)
			} else {
				cell, err := cells.cell(value, raw.types[i], i+1)
				if err != nil {
					return nil, err
				}
				v, rule = catalogDescribedCell(cell, column, s.dialect)
			}
			if rule != nil {
				return nil, rule.at(i + 1)
			}
			converted[i] = v
		}
		out = append(out, converted)
	}
	return out, nil
}

// catalogBooleanColumn reports a boolean column (DIA-29): MySQL tinyint(1), and PostgreSQL and SQLite boolean.
func catalogBooleanColumn(column CatalogColumn, dialect string) bool {
	native := strings.TrimSpace(column.NativeType)
	if dialect == "mysql" {
		return strings.EqualFold(native, "tinyint(1)")
	}
	return strings.EqualFold(native, "boolean")
}

// catalogBooleanValue is the bool of a value of a boolean column: a bool, or the integer 0 or 1 that MySQL and SQLite store
// (INT-182).
func catalogBooleanValue(value any) (any, *catalogRule) {
	switch v := value.(type) {
	case bool:
		return v, nil
	case int64:
		if v == 0 || v == 1 {
			return v == 1, nil
		}
	}
	return nil, catalogRuleBooleanValue
}

// catalogDescribedCell is the Go value of a MySQL or PostgreSQL cell of a described column.
func catalogDescribedCell(cell CatalogGridCell, column CatalogColumn, dialect string) (any, *catalogRule) {
	if cell.Kind == CatalogGridNull {
		return nil, nil
	}
	if catalogBooleanColumn(column, dialect) {
		return catalogBooleanValue(cell.Value)
	}
	switch cell.Kind {
	case CatalogGridTime, CatalogGridDateTime:
		if rule := catalogNativePrecisionRule(column, dialect); rule != nil {
			return nil, rule
		}
		precision := 6
		if dialect == "mysql" {
			precision = 0
		}
		if _, p, _, ok := catalogTemporalKind(column, dialect); ok {
			precision = p
		}
		text, isText := cell.Value.(string)
		if !isText {
			return nil, catalogRuleDriverValue
		}
		return catalogDescribedPrecision(text, precision)
	}
	return catalogCellValue(cell), nil
}

// catalogSQLiteDescribed is the Go value of a SQLite value of a described column: the value of its storage class, since no
// conversion refuses a value for the type that its column declares (INT-184), except that the stored value of a dbspec
// date, time or datetime column must be its dbspec text (INT-176 to INT-179), and that of a boolean column 0 or 1.
func catalogSQLiteDescribed(value any, column CatalogColumn) (any, *catalogRule) {
	if value == nil {
		return nil, nil
	}
	if kind, precision, declared, ok := catalogTemporalKind(column, "sqlite"); ok {
		text, isText := value.(string)
		if !isText {
			return nil, catalogRuleStoredValue[kind]
		}
		digits, rule := catalogSQLiteTemporalText(text, kind)
		if rule != nil {
			return nil, rule
		}
		if !declared {
			// INT-103 and DIA-24: a SQLite DATETIME or TIME with no CHECK has precision 0.
			precision = 0
		}
		if kind != "date" && digits != precision {
			return nil, catalogRuleCheckDigits
		}
		return text, nil
	}
	if catalogBooleanColumn(column, "sqlite") {
		return catalogBooleanValue(value)
	}
	cell, rule := catalogSQLiteCell(value)
	if rule != nil {
		return nil, rule
	}
	return catalogCellValue(cell), nil
}

// catalogSQLiteTemporalText checks that a SQLite text is in the dbspec form of its kind (INT-176 to INT-178), then that its
// date is in range and of the calendar and its time within a day (INT-173 to INT-175), and returns its number of fraction
// digits.
func catalogSQLiteTemporalText(text, kind string) (int, *catalogRule) {
	form := catalogRuleStoredValue[kind]
	date, clock := text, text
	switch kind {
	case "date":
		clock = ""
	case "time":
		date = ""
	default:
		match := catalogDescribedStampText.FindStringSubmatch(text)
		if match == nil {
			return 0, form
		}
		date, clock = match[1], match[2]
	}
	var dateMatch, clockMatch []string
	if date != "" {
		if dateMatch = catalogDescribedDateText.FindStringSubmatch(date); dateMatch == nil {
			return 0, form
		}
	}
	if clock != "" {
		if clockMatch = catalogDescribedTimeText.FindStringSubmatch(clock); clockMatch == nil {
			return 0, form
		}
	}
	if dateMatch != nil {
		if _, rule := catalogDateCell(catalogDigits(dateMatch[1]), catalogDigits(dateMatch[2]), catalogDigits(dateMatch[3])); rule != nil {
			return 0, rule
		}
	}
	if clockMatch == nil {
		return 0, nil
	}
	hour, minute, second := catalogDigits(clockMatch[1]), catalogDigits(clockMatch[2]), catalogDigits(clockMatch[3])
	if hour > 23 || minute > 59 || second > 59 {
		return 0, catalogRuleTimeRange
	}
	return len(clockMatch[4]), nil
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
