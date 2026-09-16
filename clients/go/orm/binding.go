package orm

import (
	"context"

	"github.com/polyspec/orm/engine/ir"
)

// Binding keeps execution state on a query or loaded row, outside its IR.
// Copying a binding preserves the exact pool or transaction and context.
type Binding struct {
	ctx context.Context
	ex  Exec
}

func NewBinding(ctx context.Context, ex Exec) Binding { return Binding{ctx: ctx, ex: ex} }

// NewBindingForExecutor binds a generated query to a database or transaction.
// The executor owns the context; callers do not pair a context with each
// query, which prevents context/executor mismatches across multiple DBs.
func NewBindingForExecutor(ex Exec) Binding {
	var ctx context.Context
	switch value := ex.(type) {
	case *DB:
		if value != nil {
			ctx = value.ctx
		}
	case *Tx:
		if value != nil && value.d != nil {
			ctx = value.d.ctx
		}
	}
	return Binding{ctx: ctx, ex: ex}
}

func (b Binding) Resolve() (context.Context, Exec, error) {
	if b.ctx == nil || b.ex == nil {
		return nil, nil, &ir.Error{Code: CodeConfig, Msg: "bind a context and database or transaction before executing"}
	}
	switch ex := b.ex.(type) {
	case *DB:
		if ex == nil {
			return nil, nil, &ir.Error{Code: CodeConfig, Msg: "cannot execute with a nil database"}
		}
		if ex.Eng == nil {
			return nil, nil, &ir.Error{Code: CodeConfig, Msg: "database is not bound to a schema engine"}
		}
	case *Tx:
		if ex == nil {
			return nil, nil, &ir.Error{Code: CodeConfig, Msg: "cannot execute with a nil transaction"}
		}
		if ex.finished.Load() {
			return nil, nil, &ir.Error{Code: CodeConfig, Msg: "transaction already finished"}
		}
		if ex.d == nil || ex.d.Eng == nil {
			return nil, nil, &ir.Error{Code: CodeConfig, Msg: "transaction is not bound to a schema engine"}
		}
	}
	return b.ctx, b.ex, nil
}
