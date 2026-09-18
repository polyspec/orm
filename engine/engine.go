// Package engine is the query planner: IR in, Plan out. It is pure
// and stateless apart from the loaded manifest; execution lives in the
// language-native executors.
package engine

import (
	"encoding/json"

	"github.com/polyspec/orm/engine/dialect"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/planner"
	"github.com/polyspec/orm/engine/schema"
)

// Engine binds a manifest to a dialect.
type Engine struct {
	M *schema.Manifest
	P *planner.Planner
}

// New builds an engine for the given dialect name.
func New(m *schema.Manifest, dialectName string) (*Engine, error) {
	var d dialect.Dialect
	switch dialectName {
	case "mysql", "":
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

// LoadJSON builds an engine from schema.json bytes.
func LoadJSON(manifestJSON []byte, dialectName string) (*Engine, error) {
	m, err := schema.Load(manifestJSON)
	if err != nil {
		return nil, &ir.Error{Code: "SCHEMA_INVALID", Msg: err.Error()}
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
