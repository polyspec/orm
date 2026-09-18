package orm

import "github.com/polyspec/orm/engine/ir"

// NullType is the type of Null.
type NullType struct{}

// Null is the null condition value: `IS NULL`, or `IS NOT NULL` with `Ne`.
// It is accepted only for nullable columns.
var Null = NullType{}

// Func is an ORM function value. It carries the function kind and its
// arguments; the model method that receives it records the column and the
// operator, and the compiler renders SQL for the connection dialect.
type Func struct {
	name   string
	args   []any
	column bool
}

func valueFunc(name string, args ...any) Func { return Func{name: name, args: args} }

func columnFunc(name string, args ...any) Func { return Func{name: name, args: args, column: true} }

// Now is the current time of the connection.
func Now() Func { return valueFunc("now") }

// Today is the current date of the connection.
func Today() Func { return valueFunc("today") }

// SecondsAgo is the current time minus n seconds.
func SecondsAgo(n int) Func { return valueFunc("seconds_ago", n) }

// MinutesAgo is the current time minus n minutes.
func MinutesAgo(n int) Func { return valueFunc("minutes_ago", n) }

// HoursAgo is the current time minus n hours.
func HoursAgo(n int) Func { return valueFunc("hours_ago", n) }

// DaysAgo is the current time minus n days.
func DaysAgo(n int) Func { return valueFunc("days_ago", n) }

// MonthsAgo is the current time minus n months.
func MonthsAgo(n int) Func { return valueFunc("months_ago", n) }

// SecondsLater is the current time plus n seconds.
func SecondsLater(n int) Func { return valueFunc("seconds_later", n) }

// MinutesLater is the current time plus n minutes.
func MinutesLater(n int) Func { return valueFunc("minutes_later", n) }

// HoursLater is the current time plus n hours.
func HoursLater(n int) Func { return valueFunc("hours_later", n) }

// DaysLater is the current time plus n days.
func DaysLater(n int) Func { return valueFunc("days_later", n) }

// MonthsLater is the current time plus n months.
func MonthsLater(n int) Func { return valueFunc("months_later", n) }

// DayOfWeek is the weekday of a date or time column, 1 (Sunday) to 7.
func DayOfWeek() Func { return columnFunc("day_of_week") }

// Year is the year of a date or time column.
func Year() Func { return columnFunc("year") }

// Month is the month of a date or time column.
func Month() Func { return columnFunc("month") }

// Date is the date part of a date or time column.
func Date() Func { return columnFunc("date") }

// Distance is the distance in meters from a point column to the point.
func Distance(longitude, latitude float64) Func {
	return columnFunc("distance", longitude, latitude)
}

// PointX is the longitude of a point column.
func PointX() Func { return columnFunc("point_x") }

// PointY is the latitude of a point column.
func PointY() Func { return columnFunc("point_y") }

// irFunc registers the function arguments as parameters.
func (f Func) irFunc(p func(any) int) ir.Func {
	out := ir.Func{Name: f.name}
	for _, a := range f.args {
		out.Ps = append(out.Ps, p(a))
	}
	return out
}
