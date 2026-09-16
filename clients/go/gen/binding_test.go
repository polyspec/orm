package gen_test

import (
	"errors"
	"testing"

	"github.com/polyspec/orm/clients/go/gen"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine/ir"
)

func TestUnboundExecution(t *testing.T) {
	if err := gen.Init(loadEngine(t)); err != nil {
		t.Fatal(err)
	}
	checks := map[string]func() error{
		"get":             func() error { _, err := gen.Battle().Get(); return err },
		"gets":            func() error { _, err := gen.Battle().Gets(); return err },
		"stream":          func() error { _, err := gen.Battle().Stream(func(*gen.BattleRow) bool { return true }); return err },
		"count finder":    func() error { _, err := gen.Battle().GetCountByServiceSeq(7); return err },
		"group count":     func() error { _, err := gen.Battle().GetsCount(); return err },
		"aggregate":       func() error { _, err := gen.Battle().MinSeq(); return err },
		"paginate":        func() error { _, err := gen.Battle().Paginate(1, 10); return err },
		"insert":          func() error { _, err := gen.Battle().SetName("unbound").Insert(); return err },
		"update":          func() error { _, err := gen.Battle().SetName("unbound").Update(); return err },
		"delete":          func() error { _, err := gen.Battle().Delete(); return err },
		"sql":             func() error { _, err := gen.Battle().SQL(); return err },
		"row update":      func() error { return (&gen.BattleRow{}).Update() },
		"row delete":      func() error { return (&gen.BattleRow{}).Delete() },
		"nil database":    func() error { _, err := gen.Battle().Using((*orm.DB)(nil)).Get(); return err },
		"nil transaction": func() error { _, err := gen.Battle().Using((*orm.Tx)(nil)).Get(); return err },
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			var coded *ir.Error
			err := check()
			if !errors.As(err, &coded) || coded.Code != orm.CodeConfig {
				t.Fatalf("want CONFIG before execution, got %v", err)
			}
		})
	}
}

func TestBoundExecutor(t *testing.T) {
	db := open(t)
	q := gen.Battle().Using(db).ServiceSeq(7)
	n, err := q.Using(db).GetCount()
	if err != nil || n != 1000 {
		t.Fatalf("rebind must preserve predicates: n=%d err=%v", n, err)
	}
}
