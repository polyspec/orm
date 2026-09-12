package orm

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
)

// planBundle is the stable JSON envelope emitted by ormgen precompile.
type planBundle struct {
	Version    int             `json:"version"`
	SchemaHash string          `json:"schema_hash"`
	Dialect    string          `json:"dialect"`
	RequestSHA string          `json:"request_sha256"`
	Plan       json.RawMessage `json:"plan"`
}

// LoadPlanBundle validates and registers a precompiled plan for r's request
// shape. A subsequent Plan or terminal call for the same shape uses the
// registered plan without calling the compiler.
//
// The request argument binds the bundle to the exact value-free request shape;
// request_sha256 remains an audit field from the precompile command and must
// be present in the envelope. The bundle is never accepted for another kind,
// schema, or dialect.
func (d *DB) LoadPlanBundle(bundle []byte, r *Req) error {
	if r == nil {
		return &ir.Error{Code: CodeConfig, Msg: "precompiled plan requires a request"}
	}
	if r.IR.SchemaHash != d.Eng.M.SchemaHash {
		return &ir.Error{Code: CodeSchemaHashMismatch, Msg: fmt.Sprintf("request schema %s but client schema is %s", r.IR.SchemaHash, d.Eng.M.SchemaHash)}
	}
	var envelope planBundle
	if err := json.Unmarshal(bundle, &envelope); err != nil {
		return &ir.Error{Code: CodeConfig, Msg: "precompiled plan is invalid JSON: " + err.Error()}
	}
	if envelope.Version != 1 {
		return &ir.Error{Code: CodeVersionMismatch, Msg: fmt.Sprintf("precompiled plan version %d is not supported", envelope.Version)}
	}
	if envelope.SchemaHash != d.Eng.M.SchemaHash {
		return &ir.Error{Code: CodeSchemaHashMismatch, Msg: fmt.Sprintf("precompiled plan schema %s but client schema is %s", envelope.SchemaHash, d.Eng.M.SchemaHash)}
	}
	if envelope.Dialect != d.driver {
		return &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("precompiled plan dialect %s but database driver is %s", envelope.Dialect, d.driver)}
	}
	if envelope.RequestSHA == "" || len(envelope.Plan) == 0 {
		return &ir.Error{Code: CodeConfig, Msg: "precompiled plan requires request_sha256 and plan"}
	}
	r.IR.NParams = len(r.Params)
	if got := canonicalRequestSHA(r.IR); got != envelope.RequestSHA {
		return &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("precompiled plan request hash %s does not match request shape %s", envelope.RequestSHA, got)}
	}
	var compiled plan.Plan
	if err := json.Unmarshal(envelope.Plan, &compiled); err != nil {
		return &ir.Error{Code: CodeConfig, Msg: "precompiled plan body is invalid: " + err.Error()}
	}
	if compiled.SchemaHash != envelope.SchemaHash || compiled.Kind != r.IR.Kind || len(compiled.Steps) == 0 {
		return &ir.Error{Code: CodeSchemaHashMismatch, Msg: "precompiled plan body does not match its envelope or request"}
	}
	if r.Err != nil {
		return r.Err
	}
	key := shapeKey(&r.IR)
	cachedPlan := newCached(key, &compiled)
	d.planMu.Lock()
	defer d.planMu.Unlock()
	if d.plans == nil {
		d.plans = map[uint64]*cached{}
	}
	if _, exists := d.plans[key]; !exists {
		d.plans[key] = cachedPlan
		d.planOrder = append(d.planOrder, key)
		for len(d.planOrder) > d.cfg.PlanCacheSize && len(d.planOrder) > 0 {
			oldest := d.planOrder[0]
			d.planOrder = d.planOrder[1:]
			delete(d.plans, oldest)
		}
	}
	return nil
}

func canonicalRequestSHA(request ir.Request) string {
	raw, _ := json.Marshal(request)
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	_ = decoder.Decode(&value)
	canonical, _ := json.Marshal(value)
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}
