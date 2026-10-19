//go:build ormtest

package main

import (
	"time"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
)

func init() {
	clockVectors = func(run func(string, func() (any, error)), db *orm.DB) {
		// One statement has one clock (docs/spec/protocol.md "Clock"): the columns that an
		// insert leaves to `default now` hold that clock truncated to their digits, and a
		// datetime(p) column compares with a clock at six digits. The executor clock is
		// fixed at .999999 through the test entry point, so a rounding clock shows as the
		// next second; MySQL writes its own clock, CURRENT_TIMESTAMP(p), which truncates.
		// These vectors come last because the fixed clock stays on the connection.
		clockCell := func() *model.ClockCellModel { return model.ClockCell().Connect(db) }
		run("clock_truncate_write", func() (any, error) {
			orm.FixClock(db, "2026-06-01 12:34:56.999999")
			created, err := clockCell().SetLabel("write").Create()
			if err != nil {
				return nil, err
			}
			seq := created.GetSeq()
			mask([]int64{seq})
			row, err := clockCell().GetBySeq(seq)
			if err != nil {
				return nil, err
			}
			if err := row.Delete(); err != nil {
				return nil, err
			}
			at6 := row.GetAt6()
			return map[string]any{
				"p0_truncated": row.GetAt0().Equal(at6.Truncate(time.Second)),
				"p3_truncated": row.GetAt3().Equal(at6.Truncate(time.Millisecond)),
			}, nil
		})
		run("clock_compare_six_digits", func() (any, error) {
			orm.FixClock(db, "2026-06-01 12:34:56.999999")
			created, err := clockCell().SetLabel("compare").
				SetAt0("2026-06-01 12:34:56").
				SetAt3("2026-06-01 12:34:56.999").
				SetAt6("2026-06-01 12:34:56").Create()
			if err != nil {
				return nil, err
			}
			mask([]int64{created.GetSeq()})
			geNow, err := clockCell().Label("compare").AndGeAt0(orm.Now()).GetCount()
			if err != nil {
				return nil, err
			}
			ltNow, err := clockCell().Label("compare").AndLtAt3(orm.Now()).GetCount()
			if err != nil {
				return nil, err
			}
			if err := created.Delete(); err != nil {
				return nil, err
			}
			return map[string]any{"at0_ge_now": geNow, "at3_lt_now": ltNow}, nil
		})
	}
}
