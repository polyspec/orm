package dialect

import "strings"

// EarthRadiusMeters is the sphere radius used by MySQL ST_Distance_Sphere and
// by the portable haversine rendering.
const EarthRadiusMeters = "6370986"

// ColumnFunctionTypes lists the column types each ORM column function accepts.
var ColumnFunctionTypes = map[string][]string{
	"day_of_week": {"date", "datetime"},
	"year":        {"date", "datetime"},
	"month":       {"date", "datetime"},
	"date":        {"date", "datetime"},
	"distance":    {"point"},
	"point_x":     {"point"},
	"point_y":     {"point"},
}

// ColumnFunctionArity is the number of function arguments (not counting the
// compared value) each column function takes.
var ColumnFunctionArity = map[string]int{
	"day_of_week": 0, "year": 0, "month": 0, "date": 0,
	"distance": 2, "point_x": 0, "point_y": 0,
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

// haversine renders the great-circle distance. x2 and y2 are called once per
// occurrence so positional placeholders receive one bind each.
func haversine(x1, y1 string, x2, y2 func() string) string {
	rad := func(v string) string { return "RADIANS(" + v + ")" }
	return "(2 * " + EarthRadiusMeters + " * ASIN(SQRT(POWER(SIN((" + rad(y2()) + " - " + rad(y1) + ") / 2), 2) + COS(" + rad(y1) + ") * COS(" + rad(y2()) + ") * POWER(SIN((" + rad(x2()) + " - " + rad(x1) + ") / 2), 2))))"
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
	case "distance":
		return "ST_Distance_Sphere(" + col + ", POINT(" + arg(0) + ", " + arg(1) + "))", true
	case "point_x":
		return "ST_X(" + col + ")", true
	case "point_y":
		return "ST_Y(" + col + ")", true
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
	case "distance":
		return haversine(col+"[0]", col+"[1]", func() string { return "CAST(" + arg(0) + " AS double precision)" }, func() string { return "CAST(" + arg(1) + " AS double precision)" }), true
	case "point_x":
		return col + "[0]", true
	case "point_y":
		return col + "[1]", true
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

// sqlitePointCoordinate reads one coordinate of the stored `POINT(x y)` text.
func sqlitePointCoordinate(col string, second bool) string {
	space := "instr(" + col + ", ' ')"
	if second {
		return "CAST(substr(" + col + ", " + space + " + 1, length(" + col + ") - " + space + " - 1) AS REAL)"
	}
	return "CAST(substr(" + col + ", 7, " + space + " - 7) AS REAL)"
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
	case "distance":
		return haversine(sqlitePointCoordinate(col, false), sqlitePointCoordinate(col, true), func() string { return arg(0) }, func() string { return arg(1) }), true
	case "point_x":
		return sqlitePointCoordinate(col, false), true
	case "point_y":
		return sqlitePointCoordinate(col, true), true
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
