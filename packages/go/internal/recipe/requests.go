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

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/internal/irwhere"
	"github.com/polyspec/orm/packages/go/orm"
)

// hookRecord is one request that a record action of an installed hook saw (FCV-4, hook.records).
type hookRecord struct {
	kind   string
	entity string
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
	cfg := orm.Config{PoolSize: s.PoolSize, AESKey: benchAESKey, BlindIndexKey: benchBlindIndexKey}
	if s.AuditSource != nil {
		var values map[string]any
		if s.AuditSource.Values != nil {
			var err error
			if values, err = auditValues(s.AuditSource.Values, c); err != nil {
				return orm.Config{}, err
			}
		}
		fail := s.AuditSource.Fail
		cfg.AuditSource = func(context.Context) (map[string]any, error) {
			if fail {
				return nil, errCallback
			}
			return values, nil
		}
	}
	if s.AESKeyring == nil {
		return cfg, nil
	}
	keys, err := s.AESKeyring.keys()
	if err != nil {
		return orm.Config{}, err
	}
	cfg.AESKeys, cfg.AESVersion, cfg.AESKey = keys, s.AESKeyring.Current, keys[s.AESKeyring.Current]
	return cfg, nil
}

// tableModelRequest runs the table-model ops that statement.go does not: creates, duplicate_create, query, restore and a
// delete by where. It reports whether s is one of them.
func tableModelRequest(s databaseStep, c *databaseContext, db *orm.DB, table string) (outcome, bool, error) {
	core := tableCore(db, table, c.schema)
	switch s.Op {
	case "model.creates":
		var rows []json.RawMessage
		if err := json.Unmarshal(s.Rows, &rows); err != nil {
			return outcome{}, true, err
		}
		models := make([]orm.Model, 0, len(rows))
		for _, raw := range rows {
			row, err := filledCore(db, table, c, raw)
			if err != nil {
				return outcome{}, true, err
			}
			models = append(models, row.Self())
		}
		n, err := orm.Creates(core, models, s.Batch)
		if err != nil {
			return outcome{}, true, err
		}
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, true, nil
	case "model.duplicate_create":
		row, err := filledCore(db, table, c, s.Values)
		if err != nil {
			return outcome{}, true, err
		}
		other, err := filledCore(db, table, c, s.Duplication)
		if err != nil {
			return outcome{}, true, err
		}
		row.Duplication(other.Self())
		if _, err := row.Create(); err != nil {
			return outcome{}, true, err
		}
		return okOutcome(), true, nil
	case "model.restore":
		row, err := filledCore(db, table, c, s.Values)
		if err != nil {
			return outcome{}, true, err
		}
		restored, err := row.Restore()
		if err != nil {
			return outcome{}, true, err
		}
		if len(s.Columns) == 0 {
			return okOutcome(), true, nil
		}
		// The columns of the row that Restore returns, which the rows expect compares (INT-38).
		returned, ok := restored.(*tableRow)
		if !ok {
			return outcome{}, true, fmt.Errorf("model.restore returned %T, not a table row", restored)
		}
		cells, err := tableCells(returned, s.Columns)
		if err != nil {
			return outcome{}, true, err
		}
		return outcome{fields: map[string]any{"rows": []any{cells}}}, true, nil
	case "model.delete":
		if len(s.Row) > 0 {
			return outcome{}, false, nil
		}
		if err := filterWhere(core, s, c); err != nil {
			return outcome{}, true, err
		}
		rows, err := orm.Gets[*tableRow](core)
		if err != nil {
			return outcome{}, true, err
		}
		for _, r := range rows.Slice() {
			if err := r.m.Delete(nil); err != nil {
				return outcome{}, true, err
			}
		}
		return okOutcome(), true, nil
	case "model.query":
		out, err := tableQuery(s, c, db, core)
		return out, true, err
	}
	return outcome{}, false, nil
}

// tableUpdateByKey is the model.update {key, set} of a table model: a new model with its key and the assignments set, with
// no read before it, and Update, so that a key that names no row is an update that matches none (FCV-4).
func tableUpdateByKey(s databaseStep, c *databaseContext, core *orm.Core) (outcome, error) {
	for _, raw := range []json.RawMessage{s.Key, s.Set} {
		values, err := assignments(raw, c)
		if err != nil {
			return outcome{}, err
		}
		for _, a := range values {
			core.Set(a.Name, a.Value)
		}
	}
	if err := core.Update(nil); err != nil {
		return outcome{}, err
	}
	return outcome{fields: map[string]any{}}, nil
}

// filledCore is a new model of table on db with the column values of raw set in column order.
func filledCore(db *orm.DB, table string, c *databaseContext, raw json.RawMessage) (*orm.Core, error) {
	core := tableCore(db, table, c.schema)
	values, err := modelValues(raw, c)
	if err != nil {
		return nil, err
	}
	for _, column := range sortedColumns(values) {
		core.Set(column, values[column])
	}
	return core, nil
}

// tableRelation is the relation of a table-model query (FCV-4): the related model, the column pairs that match, whether
// it is a collection, and the columns read of each related row.
type tableRelation struct {
	Model   string      `json:"model"`
	Match   [][2]string `json:"match"`
	Many    bool        `json:"many"`
	Columns []string    `json:"columns"`
}

// tableQuery runs a model.query on a table model: the rows of the model, or one page of them with its total, and with a
// relation the parent columns followed by the columns of each related row.
func tableQuery(s databaseStep, c *databaseContext, db *orm.DB, core *orm.Core) (outcome, error) {
	if err := filterWhere(core, s, c); err != nil {
		return outcome{}, err
	}
	for _, column := range s.Order {
		core.OrderBy(column, false, nil)
	}
	var rel *tableRelation
	if len(s.Relation) > 0 {
		rel = &tableRelation{}
		if err := json.Unmarshal(s.Relation, rel); err != nil {
			return outcome{}, err
		}
		table, ok := tableModels[rel.Model]
		if !ok {
			return outcome{}, fmt.Errorf("model %s has no table entry", rel.Model)
		}
		child := tableCore(db, table, c.schema)
		for _, pair := range rel.Match {
			child.Match(pair[0], pair[1])
		}
		core.Relation(rel.Many, child.Self())
	}
	paged := string(s.Page) == "true"
	var parents []*tableRow
	var total int64
	if paged {
		if s.Limit <= 0 {
			return outcome{}, fmt.Errorf("a paged model.query needs a limit above 0")
		}
		page, err := orm.GetsPage[*tableRow](core, int(s.Offset)/s.Limit+1, s.Limit)
		if err != nil {
			return outcome{}, err
		}
		total, parents = page.TotalCount, page.Items.Slice()
	} else {
		// limit is the public Limit of the statement (FCV-4), so a limit on a split IN list fails with IR_INVALID.
		if s.Limit > 0 {
			core.Limit(int(s.Offset), s.Limit)
		}
		rows, err := orm.Gets[*tableRow](core)
		if err != nil {
			return outcome{}, err
		}
		parents = rows.Slice()
	}
	out := []any{}
	for _, p := range parents {
		own, err := tableCells(p, s.Columns)
		if err != nil {
			return outcome{}, err
		}
		if rel == nil {
			out = append(out, own)
			continue
		}
		children, err := relatedTableRows(p, rel)
		if err != nil {
			return outcome{}, err
		}
		for _, child := range children {
			cells, err := tableCells(child, rel.Columns)
			if err != nil {
				return outcome{}, err
			}
			out = append(out, append(append([]any{}, own...), cells...))
		}
	}
	fields := map[string]any{"rows": out}
	if paged {
		fields["total"] = total
	}
	return outcome{fields: fields}, nil
}

// tableCells is the recipe wrappers of the columns of a table row.
func tableCells(r *tableRow, columns []string) ([]any, error) {
	out := make([]any, len(columns))
	for i, column := range columns {
		v, ok := r.vals[column]
		if !ok {
			return nil, fmt.Errorf("the row has no column %s", column)
		}
		switch x := v.(type) {
		case nil:
			out[i] = map[string]any{"null": true}
		case string:
			out[i] = map[string]any{"text": x}
		case int64:
			out[i] = map[string]any{"int": strconv.FormatInt(x, 10)}
		case int:
			out[i] = map[string]any{"int": strconv.Itoa(x)}
		default:
			return nil, fmt.Errorf("a read value %v of type %T has no recipe wrapper", v, v)
		}
	}
	return out, nil
}

// relatedTableRows is the related rows that a relation read attached to a parent: each row of a collection, or the one
// row of a single relation.
func relatedTableRows(p *tableRow, rel *tableRelation) ([]*tableRow, error) {
	table := tableModels[rel.Model]
	if rel.Many {
		children, err := orm.RelatedAs[*orm.Collection[*tableRow]](p.m, table+"_models")
		if err != nil {
			return nil, fmt.Errorf("the rows of %s: %w", rel.Model, err)
		}
		if children == nil {
			return nil, fmt.Errorf("the rows of %s are nil", rel.Model)
		}
		return children.Slice(), nil
	}
	child, err := orm.RelatedAs[*tableRow](p.m, table+"_model")
	if err != nil {
		return nil, err
	}
	if child == nil {
		return nil, nil
	}
	return []*tableRow{child}, nil
}

// requestOp runs the request hook and AES ops of FCV-4, or OP_UNKNOWN for an op that it does not name.
func requestOp(s databaseStep, c *databaseContext) (outcome, error) {
	switch s.Op {
	case "hook.install":
		return c.installHook(s)
	case "hook.records":
		counts := map[string]int{}
		list := []any{}
		for _, r := range c.records {
			list = append(list, map[string]any{"object": []any{
				[]any{"kind", map[string]any{"text": r.kind}}, []any{"entity", map[string]any{"text": r.entity}}}})
			counts[r.entity]++
		}
		return outcome{fields: map[string]any{"value": map[string]any{"array": list}, "counts": counts}}, nil
	case "utils.aes_status", "utils.aes_rotate":
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, err
		}
		table, ok := tableModels[s.Model]
		if !ok {
			return outcome{}, fmt.Errorf("model %s has no table entry", s.Model)
		}
		keyring, err := s.Keyring.keyring()
		if err != nil {
			return outcome{}, err
		}
		model := tableCore(db, table, c.schema).Self()
		if s.Op == "utils.aes_rotate" {
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
	return outcome{}, fmt.Errorf("OP_UNKNOWN %s", s.Op)
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
	b, ok := c.bound[s.Connection]
	if !ok {
		return outcome{}, fmt.Errorf("hook.install: connection %q is not bound by model.connect", s.Connection)
	}
	base, isDB := b.hookBase, b.hookBase != nil
	if !isDB {
		if base, isDB = b.api.(*orm.DB); !isDB {
			return outcome{}, fmt.Errorf("hook.install: connection %q is not a connection", s.Connection)
		}
	}
	var actions []hookAction
	for _, raw := range s.Hooks {
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
			case "record":
				c.records = append(c.records, hookRecord{kind: r.Kind, entity: r.Entity})
			case "fail":
				return &ir.Error{Code: a.code, Msg: "request hook refused " + r.Kind}
			}
		}
		return nil
	})
	c.bound[s.Connection] = bound{api: hooked, fields: b.fields, hookBase: base}
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
