package recipe

// The table-model ops of the request hook, AES rotation and parameter chunking recipes (FCV-4, T334-3-4): the reads and
// writes of a table model beyond create, get_by, update, delete and count (statement.go), the request hook of a
// connection, and the AES status and rotation. Each op calls the public API of the orm package; the hook is the
// declarative form of orm.RequestHook that the hook.install actions name.

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"sync/atomic"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/internal/irwhere"
	"github.com/polyspec/orm/packages/go/orm"
)

// hookRecord is one request that a record action of an installed hook saw (FCV-4, hook.records).
type hookRecord struct {
	kind   string
	entity string
	// param is the wrapper of the bound value of a record_param action, or nil.
	param any
}

// auditSourceSpec is the audit_source of a model.connect (FCV-4, CFG-8): the values that the source returns, or a source
// whose own error fails the transaction.
type auditSourceSpec struct {
	Values json.RawMessage `json:"values"`
	Fail   bool            `json:"fail"`
}

// auditValues is an object of audit column names and their values as a map; an empty object is no value.
func auditValues(raw json.RawMessage, c *databaseContext) (map[string]any, error) {
	assigned, err := assignments(raw, c)
	if err != nil {
		return nil, err
	}
	if len(assigned) == 0 {
		return nil, nil
	}
	values := make(map[string]any, len(assigned))
	for _, a := range assigned {
		values[a.Name] = a.Value
	}
	return values, nil
}

// connectConfig is the configuration of a model.connect: the keys of the bench set or the keyring of the step, and the
// audit source of the step.
func connectConfig(s databaseStep, c *databaseContext) (orm.Config, error) {
	cfg := orm.Config{PoolSize: s.k("pool_size").PoolSize, PoolIdleSize: s.k("pool_idle_size").PoolIdle, AESKey: benchAESKey, BlindIndexKey: benchBlindIndexKey, StatementTimeoutMs: s.k("statement_timeout_ms").StatementTimeoutMs}
	if s.k("audit_source").AuditSource != nil {
		var values map[string]any
		if s.k("audit_source").AuditSource.Values != nil {
			var err error
			if values, err = auditValues(s.k("audit_source").AuditSource.Values, c); err != nil {
				return orm.Config{}, err
			}
		}
		fail := s.k("audit_source").AuditSource.Fail
		cfg.AuditSource = func(context.Context) (map[string]any, error) {
			if fail {
				return nil, errCallback
			}
			return values, nil
		}
	}
	if s.k("aes_keyring").AESKeyring == nil {
		return cfg, nil
	}
	keys, err := s.k("aes_keyring").AESKeyring.keys()
	if err != nil {
		return orm.Config{}, err
	}
	cfg.AESKeys, cfg.AESVersion, cfg.AESKey = keys, s.k("aes_keyring").AESKeyring.Current, keys[s.k("aes_keyring").AESKeyring.Current]
	return cfg, nil
}

// requestOp runs the request hook and AES ops of FCV-4, or OP_UNKNOWN for an op that it does not name.
func requestOp(s databaseStep, c *databaseContext) (outcome, error) {
	switch s.k("op").Op {
	case "hook.install":
		return c.installHook(s)
	case "hook.records":
		counts := map[string]int{}
		list := []any{}
		for _, r := range c.records {
			members := []any{[]any{"kind", map[string]any{"text": r.kind}}, []any{"entity", map[string]any{"text": r.entity}}}
			if r.param != nil {
				members = append(members, []any{"param", r.param})
			}
			list = append(list, map[string]any{"object": members})
			counts[r.entity]++
		}
		return outcome{fields: map[string]any{"value": map[string]any{"array": list}, "counts": counts}}, nil
	case "utils.lock", "utils.set_local", "utils.local", "utils.was_inserted", "utils.privilege", "utils.backend_waiting_for_lock", "utils.groups", "utils.stats":
		return utilsOp(s, c)
	case "pool.transactions":
		// Count transactions in flows of their own: the first hold of them stay open until hold have begun, so the pool
		// shows the connections that they take at once (CFG-4, CFG-5).
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, err
		}
		var active, peak, open, begun atomic.Int32
		gate := make(chan struct{})
		note := func(max *atomic.Int32, value int32) {
			for {
				seen := max.Load()
				if value <= seen || max.CompareAndSwap(seen, value) {
					return
				}
			}
		}
		errs := make(chan error, s.k("transactions").Transactions)
		for range s.k("transactions").Transactions {
			go func() {
				errs <- db.Transaction(func() error {
					note(&peak, active.Add(1))
					note(&open, int32(db.Stats().OpenConnections))
					if begun.Add(1) == int32(s.k("hold").Hold) {
						close(gate)
					}
					<-gate
					active.Add(-1)
					return nil
				})
			}()
		}
		for range s.k("transactions").Transactions {
			if err := <-errs; err != nil {
				return outcome{}, err
			}
		}
		return jsonOutcome(map[string]any{"peak": peak.Load(), "open": open.Load()}), nil
	case "db.last_affected":
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: affectedFields(db)}, nil
	case "db.notify":
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{}}, db.Notify(repeated(s.k("channel").Channel, s.k("channel_repeat").ChannelRepeat), repeated(s.k("payload").Payload, s.k("payload_repeat").PayloadRepeat))
	case "utils.aes_status", "utils.aes_rotate":
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, err
		}
		table := snakeOf(s.k("model").Model)
		keyring, err := s.k("keyring").Keyring.keyring()
		if err != nil {
			return outcome{}, err
		}
		model := tableCore(db, table, c.schema).Self()
		if s.k("op").Op == "utils.aes_rotate" {
			n, err := db.Utils().Aes().Rotate(model, keyring)
			if err != nil {
				return outcome{}, err
			}
			return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.Itoa(n)}}}, nil
		}
		status, err := db.Utils().Aes().Status(model, keyring)
		if err != nil {
			return outcome{}, err
		}
		versions := []any{}
		for _, version := range keyringVersions(status.Versions) {
			versions = append(versions, []any{strconv.FormatInt(int64(version), 10),
				map[string]any{"int": strconv.FormatInt(status.Versions[version], 10)}})
		}
		value := map[string]any{"object": []any{
			[]any{"current", map[string]any{"int": strconv.FormatInt(int64(status.Current), 10)}},
			[]any{"total", map[string]any{"int": strconv.FormatInt(status.Total, 10)}},
			[]any{"pending", map[string]any{"int": strconv.FormatInt(status.Pending, 10)}},
			[]any{"versions", map[string]any{"object": versions}},
		}}
		return outcome{fields: map[string]any{"value": value}}, nil
	}
	return outcome{}, fmt.Errorf("OP_UNKNOWN %s", s.k("op").Op)
}

// hookAction is one action of hook.install, with its value converted once.
type hookAction struct {
	action string
	kinds  any
	column string
	value  any
	nested bool
	code   string
}

// installHook binds the connection of s to the connection that model.connect opened with the actions of s as its request
// hook, in order; a later hook.install on the same connection replaces the hook (FCV-4).
func (c *databaseContext) installHook(s databaseStep) (outcome, error) {
	b, ok := c.bound[s.k("connection").Connection]
	if !ok {
		return outcome{}, fmt.Errorf("hook.install: connection %q is not bound by model.connect", s.k("connection").Connection)
	}
	base, isDB := b.hookBase, b.hookBase != nil
	if !isDB {
		if base, isDB = b.api.(*orm.DB); !isDB {
			return outcome{}, fmt.Errorf("hook.install: connection %q is not a connection", s.k("connection").Connection)
		}
	}
	var actions []hookAction
	for _, raw := range s.k("hooks").Hooks {
		var h struct {
			Action string          `json:"action"`
			Kinds  json.RawMessage `json:"kinds"`
			Column string          `json:"column"`
			Value  json.RawMessage `json:"value"`
			Nested bool            `json:"nested"`
			Error  string          `json:"error"`
		}
		if err := json.Unmarshal(raw, &h); err != nil {
			return outcome{}, err
		}
		a := hookAction{action: h.Action, column: h.Column, nested: h.Nested, code: h.Error}
		if err := json.Unmarshal(h.Kinds, &a.kinds); err != nil {
			return outcome{}, err
		}
		if len(h.Value) > 0 {
			v, err := assignmentValue(h.Value, c)
			if err != nil {
				return outcome{}, err
			}
			a.value = v
		}
		actions = append(actions, a)
	}
	c.records = nil
	hooked := base.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
		for _, a := range actions {
			if !kindMatches(a.kinds, r.Kind) {
				continue
			}
			switch a.action {
			case "scope":
				if a.nested {
					scopeTree(&r.Query, a.column, a.value, addParam)
				} else {
					irwhere.And(&r.Query, equalPred(addParam, a.column, a.value))
				}
			case "assign":
				p := addParam(a.value)
				r.Set = append(r.Set, ir.Assign{Column: a.column, P: &p})
				for i := range r.Rows {
					r.Rows[i] = append(r.Rows[i], addParam(a.value))
				}
			case "assign_first":
				p := addParam(a.value)
				r.Set = append([]ir.Assign{{Column: a.column, P: &p}}, r.Set...)
			case "rewrite":
				for i := range r.Set {
					if r.Set[i].Column == a.column {
						p := addParam(a.value)
						r.Set[i].P = &p
					}
				}
			case "invalid_param":
				p := r.NParams + 5
				irwhere.And(&r.Query, ir.Pred{Column: a.column, Op: "eq", P: &p})
			case "record":
				c.records = append(c.records, hookRecord{kind: r.Kind, entity: r.Entity})
			case "record_param":
				for _, assignment := range r.Set {
					if assignment.Column != a.column || assignment.P == nil {
						continue
					}
					w, err := plain(params[*assignment.P], "", c.database)
					if err != nil {
						return err
					}
					c.records = append(c.records, hookRecord{kind: r.Kind, entity: r.Entity, param: w})
				}
			case "fail":
				return &ir.Error{Code: a.code, Msg: "request hook refused " + r.Kind}
			}
		}
		return nil
	})
	// With as, the hooked handle takes that name and the connection keeps its name, unhooked (INT-78).
	if s.k("as").As != "" {
		out := okOutcome()
		out.api = hooked
		return out, nil
	}
	c.bound[s.k("connection").Connection] = bound{api: hooked, fields: b.fields, hookBase: base}
	return okOutcome(), nil
}

// kindMatches reports whether a kind list (or one of the names reads, reads+restore, every) holds kind.
func kindMatches(kinds any, kind string) bool {
	switch k := kinds.(type) {
	case string:
		switch k {
		case "every":
			return true
		case "reads":
			return slices.Contains(readKinds, kind)
		case "reads+restore":
			return slices.Contains(readKinds, kind) || kind == "restore"
		}
		return false
	case []any:
		for _, item := range k {
			if s, ok := item.(string); ok && s == kind {
				return true
			}
		}
	}
	return false
}

// readKinds are the request kinds that the name reads covers.
var readKinds = []string{"one", "all", "count", "group_count", "sum", "avg", "paginate"}

// equalPred is the predicate column = value with the value bound through addParam.
func equalPred(addParam func(any) int, column string, value any) ir.Pred {
	p := addParam(value)
	return ir.Pred{Column: column, Op: "eq", P: &p}
}

// scopeTree adds column = value to the where of q and of each of its relation queries, nested ones included.
func scopeTree(q *ir.Query, column string, value any, addParam func(any) int) {
	irwhere.And(q, equalPred(addParam, column, value))
	for _, rel := range q.Relations {
		scopeTree(rel.Query, column, value, addParam)
	}
}

// aesKeyringSpec is the keyring of the recipe (scripts/features/schema/recipe.schema.json, $defs/aesKeyring): the key text of
// each declared version, and the current version that new writes use.
type aesKeyringSpec struct {
	Keys    map[string]string `json:"versions"`
	Current int32             `json:"current"`
}

// keys returns the keys by their version number.
func (k *aesKeyringSpec) keys() (map[int32]string, error) {
	out := make(map[int32]string, len(k.Keys))
	for text, key := range k.Keys {
		version, err := strconv.ParseInt(text, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("aes key version %s: %w", text, err)
		}
		out[int32(version)] = key
	}
	return out, nil
}

// keyring is the public keyring of the spec, which validates it as orm.NewAESKeyring does.
func (k *aesKeyringSpec) keyring() (orm.AESKeyring, error) {
	if k == nil {
		return orm.AESKeyring{}, fmt.Errorf("the op needs a keyring")
	}
	keys, err := k.keys()
	if err != nil {
		return orm.AESKeyring{}, err
	}
	return orm.NewAESKeyring(keys, k.Current)
}

// keyringVersions returns the versions of a status in ascending order.
func keyringVersions(versions map[int32]int64) []int32 {
	out := make([]int32, 0, len(versions))
	for version := range versions {
		out = append(out, version)
	}
	slices.Sort(out)
	return out
}
