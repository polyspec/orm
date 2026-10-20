package orm

import (
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestFuncIR checks the IR function name and the parameters of every value and column function of the DSL
// (docs/spec/dsl.md section 10): a value function binds its arguments as parameters, and a column function
// applies to the compared column and binds none.
func TestFuncIR(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, c := range []struct {
		fn     Func
		name   string
		args   []any
		column bool
	}{
		{Now(), "now", nil, false},
		{Today(), "today", nil, false},
		{SecondsAgo(1), "seconds_ago", []any{1}, false},
		{MinutesAgo(2), "minutes_ago", []any{2}, false},
		{HoursAgo(3), "hours_ago", []any{3}, false},
		{DaysAgo(4), "days_ago", []any{4}, false},
		{MonthsAgo(5), "months_ago", []any{5}, false},
		{SecondsLater(6), "seconds_later", []any{6}, false},
		{MinutesLater(7), "minutes_later", []any{7}, false},
		{HoursLater(8), "hours_later", []any{8}, false},
		{DaysLater(9), "days_later", []any{9}, false},
		{MonthsLater(10), "months_later", []any{10}, false},
		{DayOfWeek(), "day_of_week", nil, true},
		{Year(), "year", nil, true},
		{Month(), "month", nil, true},
		{Date(), "date", nil, true},
	} {
		var bound []any
		got := c.fn.irFunc(func(v any) int {
			bound = append(bound, v)
			return len(bound) - 1
		})
		if got.Name != c.name || c.fn.column != c.column || !slices.Equal(bound, c.args) || len(got.Ps) != len(c.args) {
			t.Errorf("%s: IR %+v binds %v (column %v), want %s binding %v (column %v)", c.name, got, bound, c.fn.column, c.name, c.args, c.column)
		}
	}
}
