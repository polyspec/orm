package recipe

// The request ops of FCV-4 (T334-3-4): the model ops, the request hook and the transaction. Each op calls the public API of
// the orm package; the hook is the declarative form of orm.RequestHook that the hook.install actions name.

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/orm"
)

// row is a model of a table of the case: its columns are the values that the case reads and writes by name.
type row struct {
	m    *orm.Core
	vals map[string]any
}

// Orm_ returns the core of the row.
func (r *row) Orm_() *orm.Core { return r.m }

// record is one request that a record action of the installed hook saw (FCV-4, hook.records).
type record struct {
	kind   string
	entity string
}

// requestState is the state of the request ops of a case, kept in the databaseContext.
type requestState struct {
	base     *orm.DB
	conn     *orm.DB
	named    map[string]*orm.DB
	schema   *orm.Schema
	entities map[string]*orm.Entity
	records  []record
	inTx     bool
}

// entity returns the model of the table name of the case, with the columns that the catalog describes.
func (c *databaseContext) entity(name string) (*orm.Entity, error) {
	if e, ok := c.entities[name]; ok {
		return e, nil
	}
	metadata, err := c.catalog.DescribeTable(c.ctx, orm.CatalogTableRef{Namespace: c.namespace, Name: name})
	if err != nil {
		return nil, err
	}
	columns := make([]string, len(metadata.Columns))
	for i, column := range metadata.Columns {
		columns[i] = column.Name
	}
	e := &orm.Entity{
		Name:   name,
		Schema: c.schema,
		New: func(core *orm.Core) orm.Model {
			r := &row{m: core, vals: map[string]any{}}
			core.Bind(r)
			return r
		},
		Assign: func(m orm.Model, column string, v any) (bool, error) {
			r, isRow := m.(*row)
			if !isRow || !slices.Contains(columns, column) {
				return false, nil
			}
			r.vals[column] = v
			return true, nil
		},
		Value: func(m orm.Model, column string) (any, bool) {
			r, isRow := m.(*row)
			if !isRow {
				return nil, false
			}
			v, ok := r.vals[column]
			return v, ok
		},
		Collect: func(keys []orm.Key, items map[orm.Key]*orm.Core, fetched map[orm.Key]any) any {
			return orm.CollectOf[*row](keys, items, fetched)
		},
	}
	c.entities[name] = e
	return e, nil
}

// connection returns the connection that a step names with on, or the default connection.
func (c *databaseContext) connection(on string) (*orm.DB, error) {
	if on == "" {
		return c.conn, nil
	}
	conn, ok := c.named[on]
	if !ok {
		return nil, fmt.Errorf("connection %s is not connected by a model.connect step", on)
	}
	return conn, nil
}

// values converts an object of column values (recipe wrappers) to the Go values of the model.
func values(raw json.RawMessage) (map[string]any, error) {
	out := map[string]any{}
	if len(raw) == 0 {
		return out, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	for column, field := range fields {
		n, err := wrapper(field)
		if err != nil {
			return nil, err
		}
		v, err := toGo(n)
		if err != nil {
			return nil, err
		}
		out[column] = v
	}
	return out, nil
}

// core builds the model of the step with the values, connected to the connection of the step unless the step runs in a
// transaction, where a model without a connection uses the transaction.
func (c *databaseContext) core(name, on string, vals map[string]any) (*orm.Core, error) {
	e, err := c.entity(name)
	if err != nil {
		return nil, err
	}
	core := orm.NewCore(e)
	e.New(core)
	if !c.inTx {
		conn, err := c.connection(on)
		if err != nil {
			return nil, err
		}
		core.Connect(conn)
	}
	for _, column := range sortedKeys(vals) {
		core.Set(column, vals[column])
	}
	return core, nil
}

// where adds the equalities of the where object to the core, ANDed.
func (c *databaseContext) where(core *orm.Core, raw json.RawMessage) error {
	vals, err := values(raw)
	if err != nil {
		return err
	}
	for _, column := range sortedKeys(vals) {
		core.Where("", []orm.ChainKey{{Column: column}}, vals[column])
	}
	return nil
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// cell is the recipe wrapper of a value that a read returns.
func cell(v any) (any, error) {
	switch x := v.(type) {
	case string:
		return map[string]any{"text": x}, nil
	case int64:
		return map[string]any{"int": strconv.FormatInt(x, 10)}, nil
	case int:
		return map[string]any{"int": strconv.Itoa(x)}, nil
	}
	return nil, fmt.Errorf("a read value %v of type %T has no recipe wrapper in a request op", v, v)
}

// project returns the cells of the columns of the row.
func project(r *row, columns []string) ([]any, error) {
	out := make([]any, len(columns))
	for i, column := range columns {
		v, ok := r.vals[column]
		if !ok {
			return nil, fmt.Errorf("the row has no column %s", column)
		}
		w, err := cell(v)
		if err != nil {
			return nil, err
		}
		out[i] = w
	}
	return out, nil
}

// requestOp runs one request op and returns its outcome, or OP_UNKNOWN for an op that it does not name.
func requestOp(s databaseStep, c *databaseContext) (outcome, error) {
	switch s.Op {
	case "model.connect":
		if s.As == "" || s.PoolSize != 0 {
			return outcome{}, fmt.Errorf("model.connect of a second connection needs as and no pool_size")
		}
		conn, err := orm.ConnectSchema(c.dsn, c.schema, orm.Config{})
		if err != nil {
			return outcome{}, err
		}
		c.named[s.As] = conn
		c.closers = append(c.closers, conn.Close)
		return outcome{}, nil
	case "hook.install":
		return outcome{}, c.installHook(s.Hooks)
	case "hook.records":
		counts := map[string]int{}
		list := []any{}
		for _, r := range c.records {
			list = append(list, map[string]any{"object": []any{
				[]any{"kind", map[string]any{"text": r.kind}}, []any{"entity", map[string]any{"text": r.entity}}}})
			counts[r.entity]++
		}
		countsOut := map[string]any{}
		for entity, n := range counts {
			countsOut[entity] = n
		}
		return outcome{fields: map[string]any{"value": map[string]any{"array": list}, "counts": countsOut}}, nil
	case "transaction":
		err := c.conn.Transaction(func() error {
			c.inTx = true
			defer func() { c.inTx = false }()
			for _, raw := range s.Steps {
				var sub databaseStep
				if err := json.Unmarshal(raw, &sub); err != nil {
					return err
				}
				if err := runDatabaseStep(sub, c); err != nil {
					return err
				}
			}
			return nil
		})
		return outcome{}, err
	case "model.create":
		vals, err := values(s.Values)
		if err != nil {
			return outcome{}, err
		}
		core, err := c.core(s.Model, s.Connection, vals)
		if err != nil {
			return outcome{}, err
		}
		_, err = core.Create()
		return outcome{}, err
	case "model.creates":
		conn, err := c.connection(s.Connection)
		if err != nil {
			return outcome{}, err
		}
		e, err := c.entity(s.Model)
		if err != nil {
			return outcome{}, err
		}
		all := orm.NewCore(e)
		e.New(all)
		all.Connect(conn)
		var models []orm.Model
		for _, raw := range s.Rows {
			vals, err := values(raw)
			if err != nil {
				return outcome{}, err
			}
			core, err := c.core(s.Model, s.Connection, vals)
			if err != nil {
				return outcome{}, err
			}
			models = append(models, core.Self())
		}
		n, err := orm.Creates(all, models, s.Batch)
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, err
	case "model.duplicate_create":
		vals, err := values(s.Values)
		if err != nil {
			return outcome{}, err
		}
		dup, err := values(s.Duplicate)
		if err != nil {
			return outcome{}, err
		}
		core, err := c.core(s.Model, s.Connection, vals)
		if err != nil {
			return outcome{}, err
		}
		other, err := c.core(s.Model, "", dup)
		if err != nil {
			return outcome{}, err
		}
		core.Duplication(other.Self())
		_, err = core.Create()
		return outcome{}, err
	case "model.query":
		return c.query(s)
	case "model.count":
		core, err := c.core(s.Model, s.Connection, nil)
		if err != nil {
			return outcome{}, err
		}
		if err := c.where(core, s.Where); err != nil {
			return outcome{}, err
		}
		n, err := core.GetCount()
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, err
	case "model.update":
		set, err := values(s.Set)
		if err != nil {
			return outcome{}, err
		}
		rows, err := c.loaded(s)
		if err != nil {
			return outcome{}, err
		}
		for _, r := range rows {
			for _, column := range sortedKeys(set) {
				r.m.Set(column, set[column])
			}
			if err := r.m.Update(nil); err != nil {
				return outcome{}, err
			}
		}
		return outcome{}, nil
	case "model.delete":
		rows, err := c.loaded(s)
		if err != nil {
			return outcome{}, err
		}
		for _, r := range rows {
			if err := r.m.Delete(nil); err != nil {
				return outcome{}, err
			}
		}
		return outcome{}, nil
	case "model.restore":
		vals, err := values(s.Values)
		if err != nil {
			return outcome{}, err
		}
		core, err := c.core(s.Model, s.Connection, vals)
		if err != nil {
			return outcome{}, err
		}
		_, err = core.Restore()
		return outcome{}, err
	}
	return outcome{}, fmt.Errorf("OP_UNKNOWN %s", s.Op)
}

// loaded reads the rows whose columns equal the where of the step.
func (c *databaseContext) loaded(s databaseStep) ([]*row, error) {
	core, err := c.core(s.Model, s.Connection, nil)
	if err != nil {
		return nil, err
	}
	if err := c.where(core, s.Where); err != nil {
		return nil, err
	}
	rows, err := orm.Gets[*row](core)
	if err != nil {
		return nil, err
	}
	return rows.Slice(), nil
}

// query runs a model.query: the rows of the model (and, with a relation, the parent and child columns of each pair).
func (c *databaseContext) query(s databaseStep) (outcome, error) {
	core, err := c.core(s.Model, s.Connection, nil)
	if err != nil {
		return outcome{}, err
	}
	if err := c.where(core, s.Where); err != nil {
		return outcome{}, err
	}
	for _, column := range s.Order {
		core.OrderBy(column, false, nil)
	}
	paged := string(s.Page) == "true"
	var childCore *orm.Core
	var rel *relationSpec
	if s.Relation != nil {
		rel = s.Relation
		childCore, err = c.core(rel.Model, s.Connection, nil)
		if err != nil {
			return outcome{}, err
		}
		for _, pair := range rel.Match {
			childCore.Match(pair[0], pair[1])
		}
		core.Relation(rel.Many, childCore.Self())
	}
	var parents []*row
	var total int64
	if paged {
		if s.Limit <= 0 {
			return outcome{}, fmt.Errorf("a paged model.query needs limit above 0")
		}
		page, err := orm.GetsPage[*row](core, int(s.Offset)/s.Limit+1, s.Limit)
		if err != nil {
			return outcome{}, err
		}
		total = page.TotalCount
		parents = page.Items.Slice()
	} else {
		// limit is the public Limit of the statement (FCV-4), so a limit on a split IN list fails with IR_INVALID.
		if s.Limit > 0 {
			core.Limit(int(s.Offset), s.Limit)
		}
		rows, err := orm.Gets[*row](core)
		if err != nil {
			return outcome{}, err
		}
		parents = rows.Slice()
	}
	out := []any{}
	for _, p := range parents {
		own, err := project(p, s.Columns)
		if err != nil {
			return outcome{}, err
		}
		if rel == nil {
			out = append(out, own)
			continue
		}
		children, err := relatedRows(p, rel)
		if err != nil {
			return outcome{}, err
		}
		for _, child := range children {
			cells, err := project(child, rel.Columns)
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

// relationSpec is the relation of a model.query (FCV-4).
type relationSpec struct {
	Model   string      `json:"model"`
	Match   [][2]string `json:"match"`
	Many    bool        `json:"many"`
	Columns []string    `json:"columns"`
}

// relatedRows returns the child rows that the parent of a relation read attached: each child of a many relation, or the
// one child of a single relation.
func relatedRows(p *row, rel *relationSpec) ([]*row, error) {
	if rel.Many {
		children, err := orm.RelatedAs[*orm.Collection[*row]](p.m, rel.Model+"_models")
		if err != nil {
			return nil, fmt.Errorf("the children of %s: %w", rel.Model, err)
		}
		if children == nil {
			return nil, fmt.Errorf("the children of %s are nil", rel.Model)
		}
		return children.Slice(), nil
	}
	child, err := orm.RelatedAs[*row](p.m, rel.Model+"_model")
	if err != nil {
		return nil, err
	}
	if child == nil {
		return nil, nil
	}
	return []*row{child}, nil
}

// hookAction is one action of hook.install, with its values converted once.
type hookAction struct {
	action string
	kinds  any
	column string
	value  any
	nested bool
	code   string
}

// installHook replaces the hook of the default connection with the actions in order (FCV-4).
func (c *databaseContext) installHook(raws []json.RawMessage) error {
	var actions []hookAction
	for _, raw := range raws {
		var s struct {
			Action string          `json:"action"`
			Kinds  json.RawMessage `json:"kinds"`
			Column string          `json:"column"`
			Value  json.RawMessage `json:"value"`
			Nested bool            `json:"nested"`
			Error  string          `json:"error"`
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		a := hookAction{action: s.Action, column: s.Column, nested: s.Nested, code: s.Error}
		var kinds any
		if err := json.Unmarshal(s.Kinds, &kinds); err != nil {
			return err
		}
		a.kinds = kinds
		if len(s.Value) > 0 {
			n, err := wrapper(s.Value)
			if err != nil {
				return err
			}
			v, err := toGo(n)
			if err != nil {
				return err
			}
			a.value = v
		}
		actions = append(actions, a)
	}
	c.records = nil
	c.conn = c.base.WithRequestHook(func(r *ir.Request, addParam func(any) int, params []any) error {
		for _, a := range actions {
			if !kindMatches(a.kinds, r.Kind) {
				continue
			}
			switch a.action {
			case "scope":
				if a.nested {
					scopeTree(&r.Query, a.column, a.value, addParam)
				} else {
					andWhere(&r.Query, equalPred(addParam, a.column, a.value))
				}
			case "assign":
				p := addParam(a.value)
				r.Set = append(r.Set, ir.Assign{Column: a.column, P: &p})
				for i := range r.Rows {
					r.Rows[i] = append(r.Rows[i], addParam(a.value))
				}
			case "record":
				c.records = append(c.records, record{kind: r.Kind, entity: r.Entity})
			case "fail":
				return &ir.Error{Code: a.code, Msg: "request hook refused " + r.Kind}
			}
		}
		return nil
	})
	return nil
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

var readKinds = []string{"one", "all", "count", "group_count", "sum", "avg", "paginate"}

// equalPred is the predicate column = value with the value bound through addParam.
func equalPred(addParam func(any) int, column string, value any) ir.Pred {
	p := addParam(value)
	return ir.Pred{Column: column, Op: "eq", P: &p}
}

// andWhere adds pred to the where of q with and; an existing where is wrapped in one group item.
func andWhere(q *ir.Query, pred ir.Pred) {
	if q.Where == nil || len(q.Where.Items) == 0 {
		q.Where = &ir.Group{Items: []ir.Item{{Pred: &pred}}}
		return
	}
	pred.Conn = "and"
	q.Where = &ir.Group{Items: []ir.Item{{Group: q.Where}, {Pred: &pred}}}
}

// scopeTree adds column = value to the where of q and of each of its relation queries, nested ones included.
func scopeTree(q *ir.Query, column string, value any, addParam func(any) int) {
	andWhere(q, equalPred(addParam, column, value))
	for _, rel := range q.Relations {
		scopeTree(rel.Query, column, value, addParam)
	}
}
