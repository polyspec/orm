// Package engine is the query compiler: JSON IR in, Plan JSON out. It is pure
// and stateless apart from the loaded manifest; execution lives in the
// language-native executors.
package engine

import (
	"encoding/json"
	"errors"
	"sync/atomic"

	"github.com/maxkwon/orm/engine/dialect"
	"github.com/maxkwon/orm/engine/ir"
	"github.com/maxkwon/orm/engine/planner"
	"github.com/maxkwon/orm/engine/schema"
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

// ErrorJSON renders an error as the wire envelope {"error":{code,msg}}.
func ErrorJSON(err error) []byte {
	var e *ir.Error
	if !errors.As(err, &e) {
		e = &ir.Error{Code: "INTERNAL", Msg: err.Error()}
	}
	b, _ := json.Marshal(struct {
		Error *ir.Error `json:"error"`
	}{e})
	return b
}

// Global engine for the FFI/wasm/ormd entry points, set once by orm_load.
var global atomic.Pointer[Engine]

func SetGlobal(e *Engine) { global.Store(e) }

func Global() (*Engine, error) {
	e := global.Load()
	if e == nil {
		return nil, &ir.Error{Code: "SCHEMA_NOT_LOADED", Msg: "call orm_load with schema.json first"}
	}
	return e, nil
}
