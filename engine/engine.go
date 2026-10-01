// Package engine is the query planner: IR in, Plan out. It is pure
// and stateless apart from the loaded runtime model; execution lives in the
// language-native executors.
package engine

import (
	"encoding/json"

	"github.com/polyspec/orm/engine/dialect"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/planner"
	"github.com/polyspec/orm/engine/runtimemodel"
)

// Engine binds a runtime model to a dialect.
type Engine struct {
	M *runtimemodel.Model
	P *planner.Planner
}

// New builds an engine for the given dialect name.
func New(m *runtimemodel.Model, dialectName string) (*Engine, error) {
	var d dialect.Dialect
	switch dialectName {
	case "mysql":
		d = dialect.MySQL{}
	case "postgres":
		d = dialect.Postgres{}
	case "sqlite":
		d = dialect.SQLite{}
	default:
		return nil, &ir.Error{Code: "DIALECT_UNKNOWN", Msg: dialectName}
	}
	return &Engine{M: m, P: &planner.Planner{M: m, D: d}}, nil
}

// Load은 manifest text로 runtime model을 만들어 dialect의 engine을 반환한다.
// 잘못된 manifest text는 SCHEMA_INVALID다.
func Load(manifestText, dialectName string) (*Engine, error) {
	m, diagnostics := runtimemodel.Load(manifestText)
	if len(diagnostics) > 0 {
		return nil, &ir.Error{Code: "SCHEMA_INVALID", Msg: runtimemodel.DiagnosticsError(diagnostics)}
	}
	return New(m, dialectName)
}

// Compile validates the IR and returns the plan as JSON.
func (e *Engine) Compile(irJSON []byte) ([]byte, error) {
	req, err := ir.Decode(e.M, irJSON)
	if err != nil {
		return nil, err
	}
	pl, err := e.P.Compile(req)
	if err != nil {
		return nil, err
	}
	out, err := json.Marshal(pl)
	if err != nil {
		return nil, &ir.Error{Code: "INTERNAL", Msg: err.Error()}
	}
	return out, nil
}
