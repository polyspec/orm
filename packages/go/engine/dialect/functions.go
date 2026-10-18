package dialect

import "strings"

// ColumnFunctionTypes lists the column types each ORM column function accepts.
var ColumnFunctionTypes = map[string][]string{
	"day_of_week": {"date", "datetime"},
	"year":        {"date", "datetime"},
	"month":       {"date", "datetime"},
	"date":        {"date", "datetime"},
}

// ColumnFunctionArity is the number of function arguments (not counting the
// compared value) each column function takes.
var ColumnFunctionArity = map[string]int{
	"day_of_week": 0, "year": 0, "month": 0, "date": 0,
}

// ValueFunctionUnits maps relative value functions to their interval unit.
var ValueFunctionUnits = map[string]string{
	"seconds_ago": "second", "minutes_ago": "minute", "hours_ago": "hour", "days_ago": "day", "months_ago": "month",
	"seconds_later": "second", "minutes_later": "minute", "hours_later": "hour", "days_later": "day", "months_later": "month",
}

// intervalBounds is the largest interval of each unit that stays inside orm's range, 0001-01-01 to 9999-12-31
// (3652059 days): a relative time function whose interval exceeds it is NULL, so no database computes it and
// PostgreSQL never fails with interval out of range (postgres.relative.interval_out_of_range).
var intervalBounds = map[string]string{"second": "315537897600", "minute": "5258964960", "hour": "87649416", "day": "3652059", "month": "119988"}

// guardInterval renders the interval argument of a relative time function, NULL past its bound. The guard sits inside
// the argument, not around the function, so a database that folds constants never evaluates an out-of-range interval.
func guardInterval(unit, operandCast string, arg func() string) string {
	// A typed placeholder needs its cast on both sides: PostgreSQL infers an uncast THEN placeholder as text.
	cast := func(placeholder string) string {
		if operandCast == "" {
			return placeholder
		}
		return "CAST(" + placeholder + " AS " + operandCast + ")"
	}
	operand := cast(arg())
	bound := intervalBounds[unit]
	return "CASE WHEN " + operand + " BETWEEN -" + bound + " AND " + bound + " THEN " + cast(arg()) + " END"
}

// guardResult renders a relative time value as NULL outside 0001-01-01 00:00:00 to 9999-12-31 23:59:59.999999: past
// the range MySQL and SQLite give NULL, below it they give the year 0000 (mysql.relative.out_of_range_null,
// sqlite.relative.out_of_range_null), and PostgreSQL gives the year 10000 or later.
func guardResult(value func() string) string {
	return "CASE WHEN " + value() + " BETWEEN '0001-01-01 00:00:00' AND '9999-12-31 23:59:59.999999' THEN " + value() + " END"
}

// IsValueFunction reports whether name is a value function.
func IsValueFunction(name string) bool {
	_, relative := ValueFunctionUnits[name]
	return relative || name == "now" || name == "today"
}

func (MySQL) ColumnFunction(name, col string, arg func(int) string) (string, bool) {
	switch name {
	case "day_of_week":
		return "DAYOFWEEK(" + col + ")", true
	case "year":
		return "YEAR(" + col + ")", true
	case "month":
		return "MONTH(" + col + ")", true
	case "date":
		return "DATE(" + col + ")", true
	}
	return "", false
}

func (MySQL) ValueFunction(name string, arg, _ func() string) (string, bool) {
	switch name {
	case "now":
		return "NOW(6)", true
	case "today":
		return "CURDATE()", true
	}
	unit, ok := ValueFunctionUnits[name]
	if !ok {
		return "", false
	}
	fn := "DATE_SUB"
	if strings.HasSuffix(name, "_later") {
		fn = "DATE_ADD"
	}
	return guardResult(func() string {
		return fn + "(NOW(6), INTERVAL " + guardInterval(unit, "", arg) + " " + strings.ToUpper(unit) + ")"
	}), true
}

func (MySQL) TupleIn(cols []string, rows [][]string, negate bool) string {
	return tupleIn(cols, rows, negate, false)
}

func (MySQL) Random() string { return "RAND()" }

func (MySQL) NullsOrder(bool) string { return "" }

// ContainsBinary renders plain LIKE: every orm character column is utf8mb4_0900_bin, under which LIKE compares
// code points (probe mysql.like.binary_collation_code_point), and LIKE BINARY is deprecated since MySQL 8.0.27.
func (MySQL) ContainsBinary(col string, value func(string) string) string {
	return col + " LIKE " + value("like_contains")
}

func (Postgres) ColumnFunction(name, col string, arg func(int) string) (string, bool) {
	switch name {
	case "day_of_week":
		return "(EXTRACT(DOW FROM " + col + ")::int + 1)", true
	case "year":
		return "EXTRACT(YEAR FROM " + col + ")::int", true
	case "month":
		return "EXTRACT(MONTH FROM " + col + ")::int", true
	case "date":
		return "CAST(" + col + " AS date)", true
	}
	return "", false
}

// ValueFunction binds the executor clock on PostgreSQL, so one statement has one
// clock: now() is the transaction start and statement_timestamp() the statement
// start (postgres.now.transaction_start).
func (Postgres) ValueFunction(name string, arg, now func() string) (string, bool) {
	switch name {
	case "now":
		return "CAST(" + now() + " AS timestamp(6))", true
	case "today":
		return "CURRENT_DATE", true
	}
	unit, ok := ValueFunctionUnits[name]
	if !ok {
		return "", false
	}
	op := " - "
	if strings.HasSuffix(name, "_later") {
		op = " + "
	}
	field := map[string]string{"second": "secs", "minute": "mins", "hour": "hours", "day": "days", "month": "months"}[unit]
	cast := "integer"
	if field == "secs" {
		cast = "double precision"
	}
	operandCast := "bigint"
	if cast == "double precision" {
		operandCast = cast
	}
	return guardResult(func() string {
		clock := "CAST(" + now() + " AS timestamp(6))"
		value := "CAST(" + guardInterval(unit, operandCast, arg) + " AS " + cast + ")"
		return "(" + clock + op + "make_interval(" + field + " => " + value + "))"
	}), true
}

func (Postgres) TupleIn(cols []string, rows [][]string, negate bool) string {
	return tupleIn(cols, rows, negate, false)
}

func (Postgres) Random() string { return "random()" }

func (Postgres) NullsOrder(desc bool) string {
	if desc {
		return " NULLS LAST"
	}
	return " NULLS FIRST"
}

func (Postgres) ContainsBinary(col string, value func(string) string) string {
	return col + " LIKE " + value("like_contains")
}

func (SQLite) ColumnFunction(name, col string, arg func(int) string) (string, bool) {
	switch name {
	case "day_of_week":
		return "(CAST(strftime('%w', " + col + ") AS INTEGER) + 1)", true
	case "year":
		return "CAST(strftime('%Y', " + col + ") AS INTEGER)", true
	case "month":
		return "CAST(strftime('%m', " + col + ") AS INTEGER)", true
	case "date":
		return "date(" + col + ")", true
	}
	return "", false
}

// ValueFunction binds the executor clock on SQLite and applies the interval
// with datetime modifiers; `floor` keeps the last valid day of the month.
// datetime returns seconds, so the relative form appends six fractional digits from the second clock slot.
// Within one statement the two slots are equal.
func (SQLite) ValueFunction(name string, arg, now func() string) (string, bool) {
	switch name {
	case "now":
		return now(), true
	case "today":
		return "date(" + now() + ")", true
	}
	unit, ok := ValueFunctionUnits[name]
	if !ok {
		return "", false
	}
	sign := "'-'"
	if strings.HasSuffix(name, "_later") {
		sign = "'+'"
	}
	return guardResult(func() string {
		clock := now()
		modifier := sign + " || CAST(" + arg() + " AS TEXT) || ' " + unit + "s'"
		if unit == "month" {
			modifier += ", 'floor'"
		}
		return "(datetime(" + clock + ", " + modifier + ") || substr(" + now() + ", 20))"
	}), true
}

func (SQLite) TupleIn(cols []string, rows [][]string, negate bool) string {
	return tupleIn(cols, rows, negate, true)
}

func (SQLite) Random() string { return "random()" }

func (SQLite) NullsOrder(bool) string { return "" }

// ContainsBinary uses instr because SQLite LIKE ignores case for ASCII.
func (SQLite) ContainsBinary(col string, value func(string) string) string {
	return "instr(" + col + ", " + value("") + ") > 0"
}

func tupleIn(cols []string, rows [][]string, negate, values bool) string {
	parts := make([]string, len(rows))
	for i, row := range rows {
		parts[i] = "(" + strings.Join(row, ", ") + ")"
	}
	op := " IN "
	if negate {
		op = " NOT IN "
	}
	list := strings.Join(parts, ", ")
	if values {
		list = "VALUES " + list
	}
	return "(" + strings.Join(cols, ", ") + ")" + op + "(" + list + ")"
}
