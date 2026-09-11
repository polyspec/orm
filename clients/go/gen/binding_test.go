package gen_test

import (
	"context"
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
		"get":             func() error { _, err := gen.Author().Get(); return err },
		"gets":            func() error { _, err := gen.Author().Gets(); return err },
		"count finder":    func() error { _, err := gen.Author().GetCountByServiceSeq(7); return err },
		"group count":     func() error { _, err := gen.Author().GetsCount(); return err },
		"aggregate":       func() error { _, err := gen.Author().MinSeq(); return err },
		"paginate":        func() error { _, err := gen.Author().Paginate(1, 10); return err },
		"insert":          func() error { _, err := gen.Author().SetName("unbound").Insert(); return err },
		"update":          func() error { _, err := gen.Author().SetName("unbound").Update(); return err },
		"delete":          func() error { _, err := gen.Author().Delete(); return err },
		"sql":             func() error { _, err := gen.Author().SQL(); return err },
		"row update":      func() error { return (&gen.AuthorRow{}).Update() },
		"row delete":      func() error { return (&gen.AuthorRow{}).Delete() },
		"nil context":     func() error { _, err := gen.Author().Using(nil, &orm.DB{}).Get(); return err },
		"nil database":    func() error { _, err := gen.Author().Using(context.Background(), (*orm.DB)(nil)).Get(); return err },
		"nil transaction": func() error { _, err := gen.Author().Using(context.Background(), (*orm.Tx)(nil)).Get(); return err },
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

func TestBoundContextAndRebind(t *testing.T) {
	db := open(t)
	ctx, cancel := context.WithCancel(context.Background())
	q := gen.Author().Using(ctx, db).ServiceSeq(7)
	cancel()
	if _, err := q.GetCount(); !errors.Is(err, context.Canceled) {
		t.Fatalf("bound context was not used: %v", err)
	}
	n, err := q.Using(context.Background(), db).GetCount()
	if err != nil || n != 1000 {
		t.Fatalf("rebind must preserve predicates and replace context: n=%d err=%v", n, err)
	}
}
