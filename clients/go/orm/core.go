package orm

import (
	"fmt"
	"maps"
	"reflect"
	"slices"

	"github.com/polyspec/orm/engine/ir"
)

// Model is implemented by every generated model. Orm_ returns the model core;
// the name cannot be produced from a column name, so it never collides with
// a generated method.
type Model interface {
	Orm_() *Core
}

// Entity describes one generated model type. Generated code registers one
// Entity per model and supplies the typed field accessors.
type Entity struct {
	Name   string
	Schema *Schema
	// New returns a model of this type that owns core; it calls core.Bind.
	New func(core *Core) Model
	// Assign stores a decoded column value in the typed field; false means
	// name is not a column of the entity.
	Assign func(m Model, name string, value any) bool
	// Value reads a column field; false means name is not a column.
	Value func(m Model, name string) (any, bool)
	// Collect builds the typed collection of the model; generated code sets
	// it to CollectOf with the model type.
	Collect func(keys []Key, items map[Key]*Core, fetched map[Key]any) any
}

// ChainKey is one key of a generated chain method.
type ChainKey struct {
	Conn    string   // connector before this key; empty for the first key
	Op      string   // "", ne, gt, lt, ge, le, lk, lb, between, fulltext, fulltext_boolean, tuple, ne_tuple
	Column  string   // compared column
	Columns []string // fulltext and tuple columns
	Compare string   // column of the passed model for a column comparison
}

type condNode struct {
	conn   string
	pred   *predSpec
	group  *condGroup
	joined *Core
	raw    *rawSpec
}

type condGroup struct {
	items   []condNode
	pending string
}

type predSpec struct {
	column   string
	op       string
	value    any
	fn       *Func
	cols     []string
	ref      *Core
	refCol   string
	sub      *Core
	list     bool
	isNull   bool
	between  bool
	tuple    bool
	fulltext bool
}

type rawSpec struct {
	sql   string
	binds []any
}

type joinSpec struct {
	kind  string
	left  string
	right string
	child *Core
}

type relSpec struct {
	many  bool
	child *Core
}

type columnSpec struct {
	mode    string
	add     []string
	remove  []string
	formats map[string]formatSpec
	funcs   map[string]formatSpec
	subs    map[string]func(Model) Model
	raws    map[string]rawSpec
	order   []string
}

type formatSpec struct {
	column string
	format string
	fn     *Func
}

type orderSpec struct {
	column string
	desc   bool
	fn     *Func
	random bool
	raw    *rawSpec
}

type setSpec struct {
	column string
	value  any
	null   bool
	raw    *rawSpec
	plus   bool
	minus  bool
}

type modelKind int

const (
	kindQuery modelKind = iota
	kindGroup
)

// Core is the state shared by a generated model: the query under
// construction and, for a loaded row, the row state.
type Core struct {
	ent  *Entity
	self Model
	conn *DB
	err  error
	kind modelKind
	// target is the model a group callback stands for.
	target *Core

	where     condGroup
	on        *condGroup
	joins     []joinSpec
	relations []relSpec
	columns   columnSpec
	order     []orderSpec
	groupBy   []string
	groupRaw  []rawSpec
	limit     *ir.Limit
	index     string
	lock      string
	agg       string
	aggFn     string

	matchLeft, matchRight string
	alias                 string
	parentNode            bool
	possible              *setSpec
	groupLimit            int
	deleteLock            bool
	keyName               string
	fetchKey              func(Model) any
	fetchValue            func(Model) any

	sets        []setSpec
	news        []string
	newValues   map[string]any
	duplication *Core

	row *rowState
}

// NewCore creates the core of a new model of ent. Generated constructors call it.
func NewCore(ent *Entity) *Core {
	return &Core{ent: ent}
}

// Bind records the generated model that owns the core.
func (c *Core) Bind(self Model) { c.self = self }

// Self returns the generated model that owns the core.
func (c *Core) Self() Model { return c.self }

// Entity returns the model descriptor.
func (c *Core) Entity() *Entity { return c.ent }

func (c *Core) fail(format string, args ...any) {
	if c.err == nil {
		c.err = &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf(format, args...)}
	}
}

func (c *Core) failErr(err error) {
	if c.err == nil && err != nil {
		c.err = err
	}
}

// Err returns the first recorded builder error.
func (c *Core) Err() error { return c.err }

func (c *Core) isGroup() bool { return c.kind == kindGroup }

// subject resolves a group model to the model it stands for.
func (c *Core) subject() *Core {
	for c.target != nil {
		c = c.target
	}
	return c
}

// Connect sets the connection of a model or a loaded row.
func (c *Core) Connect(db *DB) {
	if c.isGroup() {
		c.fail("connect is not allowed inside a group callback")
		return
	}
	if db == nil {
		c.fail("connect requires a database")
		return
	}
	c.conn = db
}

// Group creates the core passed to an and(fn)/or(fn) or on(fn) callback.
func (c *Core) Group() *Core {
	return &Core{ent: c.ent, kind: kindGroup, target: c}
}

func (g *condGroup) add(owner *Core, conn string, node condNode) {
	switch {
	case g.pending != "" && conn != "":
		owner.fail("connector %s follows connector %s", conn, g.pending)
		return
	case g.pending != "":
		conn, g.pending = g.pending, ""
	}
	// A connector at the start has nothing to join, so it is dropped: the
	// first condition or group carries no AND or OR.
	if len(g.items) == 0 {
		conn = ""
	}
	if len(g.items) > 0 && conn == "" {
		owner.fail("condition without and/or after another condition")
		return
	}
	node.conn = conn
	g.items = append(g.items, node)
}

func (c *Core) group() *condGroup { return &c.where }

// Connector records and()/or() without arguments, or places the conditions of
// a joined model with and(model)/or(model).
func (c *Core) Connector(conn string, args []any) {
	g := c.group()
	switch len(args) {
	case 0:
		if g.pending != "" {
			c.fail("connector %s follows connector %s", conn, g.pending)
			return
		}
		g.pending = conn
	case 1:
		m, ok := args[0].(Model)
		if !ok || m == nil {
			c.fail("%s accepts a callback of the same model or a joined model, not %T", conn, args[0])
			return
		}
		child := m.Orm_()
		if child == c.subject() {
			c.fail("%s cannot place the model inside itself", conn)
			return
		}
		g.add(c, conn, condNode{joined: child})
	default:
		c.fail("%s accepts at most one argument", conn)
	}
}

// AddGroup appends the conditions collected by a group callback.
func (c *Core) AddGroup(conn string, g *Core) {
	c.failErr(g.err)
	if len(g.where.items) == 0 {
		c.fail("%s group callback added no condition", conn)
		return
	}
	if g.where.pending != "" {
		c.fail("connector %s without a following condition", g.where.pending)
		return
	}
	c.group().add(c, conn, condNode{group: &condGroup{items: g.where.items}})
}

// On sets the join ON conditions from a callback group.
func (c *Core) On(g *Core) {
	if c.isGroup() {
		c.fail("on is not allowed inside a group callback")
		return
	}
	c.failErr(g.err)
	if g.where.pending != "" {
		c.fail("connector %s without a following condition", g.where.pending)
		return
	}
	if len(g.where.items) == 0 {
		c.fail("on callback added no condition")
		return
	}
	c.on = &condGroup{items: g.where.items}
}

// Raw appends a raw condition. conn is empty for the first condition.
func (c *Core) Raw(conn, sql string, binds []any) {
	c.group().add(c, conn, condNode{raw: &rawSpec{sql: sql, binds: binds}})
}

// Where appends the conditions of a chain. conn is the connector of the
// method name; args holds one value per key, and a key that receives a column
// function takes the compared value as the following argument.
func (c *Core) Where(conn string, keys []ChainKey, args ...any) {
	i := 0
	for k, key := range keys {
		if i >= len(args) {
			c.fail("%s expects %d values", chainName(keys), len(keys))
			return
		}
		value := args[i]
		i++
		keyConn := key.Conn
		if k == 0 {
			keyConn = conn
		}
		pred, extra, err := c.predicate(key, value, args[i:], len(keys) == 1)
		if err != nil {
			c.failErr(err)
			return
		}
		i += extra
		c.group().add(c, keyConn, condNode{pred: pred})
	}
	if i != len(args) {
		c.fail("%s expects %d values, got %d", chainName(keys), len(keys), len(args))
	}
}

func chainName(keys []ChainKey) string {
	name := ""
	for _, k := range keys {
		name += k.Conn + k.Op + k.Column
	}
	return name
}

var operators = map[string]string{"": "eq", "ne": "not_eq", "gt": "gt", "lt": "lt", "ge": "gte", "le": "lte", "lk": "contains", "lb": "contains_binary"}

func (c *Core) predicate(key ChainKey, value any, rest []any, single bool) (*predSpec, int, error) {
	p := &predSpec{column: key.Column}
	switch key.Op {
	case "fulltext", "fulltext_boolean":
		s, ok := value.(string)
		if !ok {
			return nil, 0, configErr("full-text value for %s must be a string", key.Column)
		}
		p.op, p.cols, p.value, p.fulltext = "match", key.Columns, s, true
		if key.Op == "fulltext_boolean" {
			p.op = "match_boolean"
		}
		return p, 0, nil
	case "tuple", "ne_tuple":
		rows, err := tupleRows(value, len(key.Columns))
		if err != nil {
			return nil, 0, err
		}
		p.op, p.cols, p.value, p.tuple = "tuple_in", key.Columns, rows, true
		if key.Op == "ne_tuple" {
			p.op = "tuple_not_in"
		}
		return p, 0, nil
	case "between":
		v := reflect.ValueOf(value)
		if v.Kind() != reflect.Array || v.Len() != 2 {
			return nil, 0, configErr("between value for %s must be a two-value array", key.Column)
		}
		p.op, p.value, p.between = "between", []any{v.Index(0).Interface(), v.Index(1).Interface()}, true
		return p, 0, nil
	}
	if key.Compare != "" {
		m, ok := value.(Model)
		if !ok || m == nil {
			return nil, 0, configErr("column comparison %s requires a model", key.Column)
		}
		p.op, p.ref, p.refCol = operators[key.Op]+"_col", m.Orm_(), key.Compare
		return p, 0, nil
	}
	op := operators[key.Op]
	switch v := value.(type) {
	case NullType:
		if key.Op != "" && key.Op != "ne" {
			return nil, 0, configErr("null is not accepted by the %s operator", key.Op)
		}
		p.op, p.isNull = "is_null", true
		if key.Op == "ne" {
			p.op = "is_not_null"
		}
		return p, 0, nil
	case Func:
		if v.column {
			if !single {
				return nil, 0, configErr("a column function is accepted only by a single-key condition")
			}
			if len(rest) != 1 {
				return nil, 0, configErr("column function on %s requires one compared value", key.Column)
			}
			f := v
			p.op, p.fn, p.value = op, &f, rest[0]
			return p, 1, nil
		}
		f := v
		p.op, p.fn = op, &f
		return p, 0, nil
	case Model:
		if key.Op != "" && key.Op != "ne" {
			return nil, 0, configErr("a subquery is not accepted by the %s operator", key.Op)
		}
		p.op, p.sub = "in", v.Orm_()
		if key.Op == "ne" {
			p.op = "not_in"
		}
		return p, 0, nil
	}
	rv := reflect.ValueOf(value)
	if rv.Kind() == reflect.Slice && rv.Type().Elem().Kind() != reflect.Uint8 {
		if key.Op != "" && key.Op != "ne" {
			return nil, 0, configErr("a list is not accepted by the %s operator", key.Op)
		}
		list := make([]any, rv.Len())
		for i := range list {
			list[i] = rv.Index(i).Interface()
		}
		if len(list) == 0 {
			return nil, 0, &ir.Error{Code: CodeEmptyIn, Msg: key.Column + " received an empty list"}
		}
		p.op, p.value, p.list = "in", list, true
		if key.Op == "ne" {
			p.op = "not_in"
		}
		return p, 0, nil
	}
	if value == nil {
		return nil, 0, configErr("%s received nil; use orm.Null", key.Column)
	}
	p.op, p.value = op, value
	return p, 0, nil
}

func tupleRows(value any, width int) ([][]any, error) {
	rv := reflect.ValueOf(value)
	if rv.Kind() != reflect.Slice {
		return nil, configErr("tuple values must be a list")
	}
	if rv.Len() == 0 {
		return nil, &ir.Error{Code: CodeEmptyIn, Msg: "tuple condition received an empty list"}
	}
	rows := make([][]any, rv.Len())
	for i := range rows {
		item := reflect.Indirect(rv.Index(i))
		if item.Kind() != reflect.Struct || item.NumField() != width {
			return nil, configErr("tuple values must be generated value groups")
		}
		row := make([]any, width)
		for f := range row {
			row[f] = item.Field(f).Interface()
		}
		rows[i] = row
	}
	return rows, nil
}

// Join adds a configured child model as an INNER or LEFT join.
func (c *Core) Join(kind, left, right string, child Model) {
	if c.isGroup() {
		c.fail("join is not allowed inside a group callback")
		return
	}
	if child == nil {
		c.fail("join requires a model")
		return
	}
	ch := child.Orm_()
	if ch.conn != nil {
		c.fail("a join child cannot have its own connection")
		return
	}
	for _, j := range c.joins {
		if j.child == ch {
			c.fail("the model is already joined")
			return
		}
	}
	c.joins = append(c.joins, joinSpec{kind: kind, left: left, right: right, child: ch})
}

// Relation attaches a child model loaded by a separate query.
func (c *Core) Relation(many bool, child Model) {
	if c.isGroup() {
		c.fail("relation is not allowed inside a group callback")
		return
	}
	if child == nil {
		c.fail("relation requires a model")
		return
	}
	ch := child.Orm_()
	if ch.matchLeft == "" {
		c.fail("relation child %s requires match<L>With<R>()", ch.ent.Name)
		return
	}
	c.relations = append(c.relations, relSpec{many: many, child: ch})
}

// Match sets the relation key: parent column left equals child column right.
func (c *Core) Match(left, right string) { c.matchLeft, c.matchRight = left, right }

// Alias sets the result name of a relation or join.
func (c *Core) Alias(name string) { c.alias = name }

// ParentNode merges the child columns into the parent row.
func (c *Core) ParentNode() { c.parentNode = true }

// Possible loads the child only for parents whose column equals value.
func (c *Core) Possible(column string, value any) {
	c.possible = &setSpec{column: column, value: value}
}

// GroupLimit limits child rows per parent key.
func (c *Core) GroupLimit(n int) {
	if n < 1 {
		c.fail("groupLimit requires a positive count")
		return
	}
	c.groupLimit = n
}

// DeleteLock excludes the relation from recursive delete.
func (c *Core) DeleteLock() { c.deleteLock = true }

// KeyName sets the collection key column.
func (c *Core) KeyName(column string) { c.keyName = column }

// FetchKey computes the collection key of each row.
func (c *Core) FetchKey(fn func(Model) any) { c.fetchKey = fn }

// FetchValue replaces each loaded row value with the callback result.
func (c *Core) FetchValue(fn func(Model) any) { c.fetchValue = fn }

func (c *Core) addName(name string) bool {
	if slices.Contains(c.columns.order, name) {
		c.fail("column name %s is already added", name)
		return false
	}
	c.columns.order = append(c.columns.order, name)
	return true
}

// AddColumn adds one column.
func (c *Core) AddColumn(column string) {
	if !slices.Contains(c.columns.add, column) {
		c.columns.add = append(c.columns.add, column)
	}
}

// AddColumnFormat adds a formatted column; format contains %s for the column.
func (c *Core) AddColumnFormat(column, name, format string) {
	if !c.addName(name) {
		return
	}
	if c.columns.formats == nil {
		c.columns.formats = map[string]formatSpec{}
	}
	c.columns.formats[name] = formatSpec{column: column, format: format}
}

// AddColumnFunc adds a column function output.
func (c *Core) AddColumnFunc(column, name string, fn Func) {
	if !fn.column {
		c.fail("addColumn%s requires a column function", name)
		return
	}
	if !c.addName(name) {
		return
	}
	if c.columns.funcs == nil {
		c.columns.funcs = map[string]formatSpec{}
	}
	c.columns.funcs[name] = formatSpec{column: column, fn: &fn}
}

// AddColumnSub adds a scalar subquery column.
func (c *Core) AddColumnSub(name string, fn func(Model) Model) {
	if !c.addName(name) {
		return
	}
	if c.columns.subs == nil {
		c.columns.subs = map[string]func(Model) Model{}
	}
	c.columns.subs[name] = fn
}

// AddRawColumn adds a raw column.
func (c *Core) AddRawColumn(name, sql string, binds []any) {
	if !c.addName(name) {
		return
	}
	if c.columns.raws == nil {
		c.columns.raws = map[string]rawSpec{}
	}
	c.columns.raws[name] = rawSpec{sql: sql, binds: binds}
}

// RemoveColumn removes one column.
func (c *Core) RemoveColumn(column string) {
	if !slices.Contains(c.columns.remove, column) {
		c.columns.remove = append(c.columns.remove, column)
	}
}

// RemoveAllColumns keeps only primary and foreign keys.
func (c *Core) RemoveAllColumns() { c.columns.mode = "none" }

// AddAllColumns selects every column.
func (c *Core) AddAllColumns() { c.columns.mode = "all" }

// ForceIndex adds an index hint.
func (c *Core) ForceIndex(name string) { c.index = name }

// OrderBy appends an order key; fn is an optional column function.
func (c *Core) OrderBy(column string, desc bool, fn []Func) {
	o := orderSpec{column: column, desc: desc}
	switch len(fn) {
	case 0:
	case 1:
		if !fn[0].column {
			c.fail("orderBy accepts a column function only")
			return
		}
		f := fn[0]
		o.fn = &f
	default:
		c.fail("orderBy accepts one column function")
		return
	}
	c.order = append(c.order, o)
}

// OrderByRandom orders rows randomly.
func (c *Core) OrderByRandom() { c.order = append(c.order, orderSpec{random: true}) }

// OrderByRaw appends a raw order expression.
func (c *Core) OrderByRaw(sql string) {
	c.order = append(c.order, orderSpec{raw: &rawSpec{sql: sql}})
}

// GroupBy appends a grouping column.
func (c *Core) GroupBy(column string) { c.groupBy = append(c.groupBy, column) }

// GroupByRaw appends a raw grouping expression.
func (c *Core) GroupByRaw(sql string) {
	c.groupRaw = append(c.groupRaw, rawSpec{sql: sql})
}

// Limit sets the row range.
func (c *Core) Limit(offset, count int) {
	if offset < 0 || count < 1 {
		c.fail("limit requires a non-negative offset and a positive count")
		return
	}
	c.limit = &ir.Limit{Offset: offset, Count: count}
}

// Lock requests a row lock: update, share, update_nowait, or share_nowait.
func (c *Core) Lock(mode string) { c.lock = mode }

// Aggregate selects the function (sum or avg) and column of getSum or getAvg.
func (c *Core) Aggregate(fn, column string) { c.aggFn, c.agg = fn, column }

// Set records a stored column value.
func (c *Core) Set(column string, value any) {
	c.putSet(setSpec{column: column, value: value})
}

// SetNull records a null column value.
func (c *Core) SetNull(column string) { c.putSet(setSpec{column: column, null: true}) }

// SetRaw records a column value from a raw SQL expression.
func (c *Core) SetRaw(column, sql string, binds []any) {
	c.putSet(setSpec{column: column, raw: &rawSpec{sql: sql, binds: binds}})
}

// Plus records a bound increment.
func (c *Core) Plus(column string, n any) { c.putSet(setSpec{column: column, value: n, plus: true}) }

// Minus records a bound decrement.
func (c *Core) Minus(column string, n any) { c.putSet(setSpec{column: column, value: n, minus: true}) }

func (c *Core) putSet(s setSpec) {
	if c.isGroup() {
		c.fail("set is not allowed inside a group callback")
		return
	}
	for i := range c.sets {
		if c.sets[i].column == s.column {
			c.sets[i] = s
			return
		}
	}
	c.sets = append(c.sets, s)
}

// New attaches a value under a name that is not a column.
func (c *Core) New(name string, value any) {
	if c.newValues == nil {
		c.newValues = map[string]any{}
	}
	if _, ok := c.newValues[name]; !ok {
		c.news = append(c.news, name)
	}
	c.newValues[name] = value
}

// NewValue returns a value attached with New or an added output column.
func (c *Core) NewValue(name string) any {
	if v, ok := c.newValues[name]; ok {
		return v
	}
	if c.row != nil {
		return c.row.extra[name]
	}
	return nil
}

// Duplication sets the duplicate-key update of the next create.
func (c *Core) Duplication(m Model) {
	if m == nil {
		c.fail("duplication requires a model")
		return
	}
	c.duplication = m.Orm_()
}

// By applies the chain of a getBy/getsBy/getCountBy terminal to a copy of the
// model; the chain joins the existing conditions with AND.
func (c *Core) By(keys []ChainKey, args ...any) *Core {
	out := c.Clone()
	conn := ""
	if len(out.where.items) > 0 {
		conn = "and"
	}
	out.Where(conn, keys, args...)
	return out
}

// clone copies the builder state so a terminal with chain values leaves the
// original model unchanged.
func (c *Core) clone() *Core {
	out := *c
	out.where = condGroup{items: slices.Clone(c.where.items), pending: c.where.pending}
	out.joins = slices.Clone(c.joins)
	out.relations = slices.Clone(c.relations)
	out.order = slices.Clone(c.order)
	out.groupBy = slices.Clone(c.groupBy)
	out.groupRaw = slices.Clone(c.groupRaw)
	out.sets = slices.Clone(c.sets)
	out.news = slices.Clone(c.news)
	out.newValues = maps.Clone(c.newValues)
	out.columns.add = slices.Clone(c.columns.add)
	out.columns.remove = slices.Clone(c.columns.remove)
	out.columns.order = slices.Clone(c.columns.order)
	out.columns.formats = maps.Clone(c.columns.formats)
	out.columns.funcs = maps.Clone(c.columns.funcs)
	out.columns.subs = maps.Clone(c.columns.subs)
	out.columns.raws = maps.Clone(c.columns.raws)
	return &out
}

// Clone returns a copy of the model for a terminal with chain values.
func (c *Core) Clone() *Core {
	out := c.clone()
	out.Bind(c.ent.New(out))
	return out
}
