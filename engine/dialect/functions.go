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
		return "NOW()", true
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
	return fn + "(NOW(), INTERVAL " + arg() + " " + strings.ToUpper(unit) + ")", true
}

func (MySQL) TupleIn(cols []string, rows [][]string, negate bool) string {
	return tupleIn(cols, rows, negate, false)
}

func (MySQL) Random() string { return "RAND()" }

func (MySQL) ContainsBinary(col string, value func(string) string) string {
	return col + " LIKE BINARY " + value("like_contains")
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

func (Postgres) ValueFunction(name string, arg, _ func() string) (string, bool) {
	switch name {
	case "now":
		return "now()", true
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
	value := "CAST(" + arg() + " AS " + cast + ")"
	return "(now()" + op + "make_interval(" + field + " => " + value + "))", true
}

func (Postgres) TupleIn(cols []string, rows [][]string, negate bool) string {
	return tupleIn(cols, rows, negate, false)
}

func (Postgres) Random() string { return "random()" }

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
	clock := now()
	modifier := sign + " || CAST(" + arg() + " AS TEXT) || ' " + unit + "s'"
	if unit == "month" {
		return "datetime(" + clock + ", " + modifier + ", 'floor')", true
	}
	return "datetime(" + clock + ", " + modifier + ")", true
}

func (SQLite) TupleIn(cols []string, rows [][]string, negate bool) string {
	return tupleIn(cols, rows, negate, true)
}

func (SQLite) Random() string { return "random()" }

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
