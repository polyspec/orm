//go:build ormtest

package main

import (
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
)

func init() {
	affectedVectors = func(run func(string, func() (any, error)), db *orm.DB) {
		// A write counts each written row once (docs/protocol.md "Write"): an upsert is
		// 1 whether it inserts or updates, and an update counts the row it matched even
		// when the row already holds the value. The count is read through the test
		// entry point (docs/protocol.md "Test write result").
		upsertCell := func() *model.UpsertCellModel { return model.UpsertCell().Connect(db) }
		run("affected_counts", func() (any, error) {
			affected := func() any {
				n, ok := orm.LastAffected(db)
				if !ok {
					return nil
				}
				return n
			}
			out := map[string]any{}
			created, err := upsertCell().SetCode("c1").SetLabel("x").
				Duplication(model.UpsertCell().SetLabel("y")).Create()
			if err != nil {
				return nil, err
			}
			seq := created.GetSeq()
			mask([]int64{seq})
			out["upsert_inserted"] = affected()
			if _, err := upsertCell().SetCode("c1").SetLabel("x").
				Duplication(model.UpsertCell().SetLabel("y")).Create(); err != nil {
				return nil, err
			}
			out["upsert_updated"] = affected()
			row, err := upsertCell().GetBySeq(seq)
			if err != nil {
				return nil, err
			}
			if _, err := row.SetLabel("y").Update(); err != nil {
				return nil, err
			}
			out["update_unchanged"] = affected()
			if _, err := row.SetLabel("z").Update(); err != nil {
				return nil, err
			}
			out["update_changed"] = affected()
			if err := row.Delete(); err != nil {
				return nil, err
			}
			return out, nil
		})
	}
}
