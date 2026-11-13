// Package engine is the query planner: IR in, Plan out. It is pure
// and stateless apart from the loaded runtime model; execution lives in the
// language-native executors.
package engine

import (
	"encoding/json"

	"github.com/polyspec/orm/legacy/packages/go/engine/dialect"
	"github.com/polyspec/orm/legacy/packages/go/engine/ir"
	"github.com/polyspec/orm/legacy/packages/go/engine/planner"
	"github.com/polyspec/orm/legacy/packages/go/engine/runtimemodel"
)

// Engine binds a runtime model to a dialect.
type Engine struct {
	M *runtimemodel.Model
	P *planner.Planner
}

// New builds an engine for the given dialect name; a mysql engine renders for a MySQL server.
func New(m *runtimemodel.Model, dialectName string) (*Engine, error) {
	return NewForServer(m, dialectName, "")
}

// NewForServer builds an engine for the given dialect name and the server of the connection, which a mysql connection reads
// by VERSION() (DIA-201): "mariadb" renders the clauses of MariaDB where the two servers have no common form (DIA-209), and
// any other server, the empty one among them, renders for MySQL.
func NewForServer(m *runtimemodel.Model, dialectName, server string) (*Engine, error) {
	var d dialect.Dialect
	switch dialectName {
	case "mysql":
		d = dialect.MySQL{MariaDB: server == "mariadb"}
	case "postgres":
		d = dialect.Postgres{}
	case "sqlite":
		d = dialect.SQLite{}
	default:
		return nil, &ir.Error{Code: "DIALECT_UNKNOWN", Msg: dialectName}
	}
	return &Engine{M: m, P: &planner.Planner{M: m, D: d}}, nil
}

// Load returns the dialect's engine, built as a runtime model from the manifest text and the external document text
// (runtimemodel.LoadSet; the external text is empty when the set has no external document).
// Malformed text is SCHEMA_INVALID.
func Load(manifestText, externalText, dialectName string) (*Engine, error) {
	m, invalid := runtimemodel.LoadSet(manifestText, externalText)
	if invalid != nil {
		return nil, &ir.Error{Code: invalid.Code(), Msg: invalid.Message()}
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

// Validate checks an already-built request without compiling its plan.
func (e *Engine) Validate(req *ir.Request) error {
	return ir.Validate(e.M, req)
}
