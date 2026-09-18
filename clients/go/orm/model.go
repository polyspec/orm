package orm

import (
	"bytes"
	"encoding/json"
	"slices"
	"time"

	orderedjson "github.com/polyspec/ordered-json/go"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/schema"
)

// rowState is the state of a loaded or created row.
type rowState struct {
	loaded   bool
	names    []string
	hidden   map[string]bool
	original map[string]any
	extra    map[string]any
	related  map[string]any
	relNames []string
	cascade  map[string]bool
	flat     []string
}

func (s *rowState) addName(name string) {
	if !slices.Contains(s.names, name) {
		s.names = append(s.names, name)
	}
}

func (s *rowState) setRelated(name string, v any, cascade, flat bool) {
	if s.related == nil {
		s.related = map[string]any{}
		s.cascade = map[string]bool{}
	}
	if _, ok := s.related[name]; !ok {
		s.relNames = append(s.relNames, name)
	}
	s.related[name] = v
	s.cascade[name] = cascade
	if flat {
		s.flat = append(s.flat, name)
	}
}

// Related returns a relation or join result by result name.
func (c *Core) Related(name string) any {
	if c.row == nil {
		return nil
	}
	return c.row.related[name]
}

// entitySchema returns the manifest entity of the model.
func (c *Core) entitySchema(d *DB) *schema.Entity {
	return manifestEntity(d.engineFor(c.ent.Schema.Hash), c.ent.Name)
}

func (c *Core) value(name string) any {
	v, _ := c.ent.Value(c.self, name)
	return v
}

// assembler creates models from the rows of one executed plan.
type assembler struct {
	res  *result
	req  *request
	db   *DB
	conn *DB
	// made collects the models created for each builder core; relations with
	// their own connection attach to them after the plan runs.
	made map[*Core][]*Core
}

// rowShape is the part of a row state that is equal for every row of one
// assemble. names has len == cap, so a row that adds a name copies it.
type rowShape struct {
	names    []string
	hidden   map[string]bool
	keys     []string
	original int
	updated  string
	time     []bool
}

func (a *assembler) shape(b *Core, asm *plan.Assemble) *rowShape {
	if sh, ok := a.res.cache.shapes.Load(asm); ok {
		return sh.(*rowShape)
	}
	sh := &rowShape{time: make([]bool, len(asm.Columns))}
	for i, col := range asm.Columns {
		sh.time[i] = col.Type == "datetime" || col.Type == "date"
		if col.Hidden {
			if sh.hidden == nil {
				sh.hidden = map[string]bool{}
			}
			sh.hidden[col.Name] = true
		}
		if !slices.Contains(sh.names, col.Name) {
			sh.names = append(sh.names, col.Name)
		}
	}
	sh.names = slices.Clip(sh.names)
	for _, key := range asm.Key {
		sh.keys = append(sh.keys, asm.Columns[key.Index-asm.Columns[0].Index].Name)
	}
	if version := updatedColumn(b.entitySchema(a.db)); version != "" && slices.Contains(sh.names, version) {
		sh.updated = version
	}
	sh.original = len(sh.keys)
	if sh.updated != "" {
		sh.original++
	}
	a.res.cache.shapes.Store(asm, sh)
	return sh
}

func (a *assembler) model(b *Core, asm *plan.Assemble, row []any) *Core {
	sh := a.shape(b, asm)
	m := b.ent.New(NewCore(b.ent)).Orm_()
	m.conn = a.conn
	st := &rowState{loaded: true, names: sh.names, hidden: sh.hidden}
	m.row = st
	for i, col := range asm.Columns {
		v := row[col.Index]
		if sh.time[i] {
			v = a.db.localTime(v)
		}
		if col.Column != "" && col.Column == col.Name && b.ent.Assign(m.self, col.Name, v) {
			continue
		}
		if st.extra == nil {
			st.extra = map[string]any{}
		}
		st.extra[col.Name] = v
	}
	st.original = make(map[string]any, sh.original)
	for _, name := range sh.keys {
		st.original[name] = m.value(name)
	}
	if sh.updated != "" {
		if v, ok := b.ent.Value(m.self, sh.updated); ok {
			st.original[sh.updated] = v
		}
	}
	for _, name := range b.news {
		m.New(name, b.newValues[name])
	}
	for _, ch := range asm.Children {
		switch ch.Kind {
		case "join":
			child := b.joinChild(ch.Rel)
			var v any
			if ch.Assemble != nil && len(ch.Assemble.Columns) > 0 && row[ch.Assemble.Columns[0].Index] != nil {
				v = a.model(child, ch.Assemble, row).self
			}
			st.setRelated(ch.Rel, v, false, false)
		default:
			child, many := b.relationChild(ch.Rel)
			rows := a.res.related(ch, row)
			childAsm := a.res.steps[ch.Step].step.Assemble
			if many {
				coll := &collection{}
				for _, cr := range rows {
					cm := a.model(child, childAsm, cr)
					coll.put(child.collectionKey(cm, childAsm, cr), cm)
				}
				st.setRelated(ch.Rel, child.ent.collection(coll), ch.Cascade, false)
			} else {
				var v any
				if len(rows) > 0 {
					v = a.model(child, childAsm, rows[0]).self
				}
				st.setRelated(ch.Rel, v, ch.Cascade, ch.Flatten)
			}
		}
	}
	if a.made != nil {
		a.made[b] = append(a.made[b], m)
	}
	return m
}

func (c *Core) joinChild(name string) *Core {
	for _, j := range c.joins {
		if j.child.resultName(false) == name {
			return j.child
		}
	}
	panic("orm: join result " + name + " without a model")
}

func (c *Core) relationChild(name string) (*Core, bool) {
	for _, r := range c.relations {
		if r.child.resultName(r.many) == name {
			return r.child, r.many
		}
	}
	panic("orm: relation result " + name + " without a model")
}

// collectionKey is the key of a loaded model: fetchKey, keyName, or the
// plan's row identity.
func (c *Core) collectionKey(m *Core, asm *plan.Assemble, row []any) Key {
	switch {
	case c.fetchKey != nil:
		return KeyOf(c.fetchKey(m.self))
	case c.keyName != "":
		if v, ok := c.ent.Value(m.self, c.keyName); ok {
			return KeyOf(v)
		}
		return KeyOf(m.row.extra[c.keyName])
	}
	key, _ := keyFromRow(row, asm.Key)
	return key
}

// collection is an untyped collection; generated code converts it.
type collection struct {
	keys    []Key
	items   map[Key]*Core
	fetched map[Key]any
}

func (c *collection) put(k Key, m *Core) {
	if c.items == nil {
		c.items = map[Key]*Core{}
	}
	if _, ok := c.items[k]; !ok {
		c.keys = append(c.keys, k)
	}
	c.items[k] = m
}

// collection converts an untyped collection to the typed collection of the
// entity; the entity supplies the conversion so child collections keep their
// model type.
func (e *Entity) collection(c *collection) any {
	return e.Collect(c.keys, c.items, c.fetched)
}

// Collect builds a typed collection. Generated entities set Entity.Collect
// with CollectOf.
func CollectOf[T Model](keys []Key, items map[Key]*Core, fetched map[Key]any) any {
	out := &Collection[T]{keys: keys, items: make(map[Key]T, len(items)), fetched: fetched}
	for k, m := range items {
		out.items[k] = m.self.(T)
	}
	return out
}

func (c *Core) terminal() (executor, error) {
	if c.isGroup() {
		return nil, configErr("a terminal is not allowed inside a group callback")
	}
	if c.err != nil {
		return nil, c.err
	}
	return resolve(c.conn)
}

func (c *Core) load(kind string) (*collection, error) {
	ex, err := c.terminal()
	if err != nil {
		return nil, err
	}
	r := c.build(kind)
	res, err := query(ex, r)
	if err != nil {
		return nil, err
	}
	return c.assemble(ex, r, res, res.plan.Steps[0].Assemble)
}

func (c *Core) assemble(ex executor, r *request, res *result, asm *plan.Assemble) (*collection, error) {
	a := &assembler{res: res, req: r, db: ex.base(), conn: c.conn}
	if len(r.external) > 0 {
		a.made = map[*Core][]*Core{}
	}
	out := &collection{keys: make([]Key, 0, len(res.main)), items: make(map[Key]*Core, len(res.main))}
	for _, row := range res.main {
		m := a.model(c, asm, row)
		out.put(c.collectionKey(m, asm, row), m)
	}
	if err := a.external(r); err != nil {
		return nil, err
	}
	if c.fetchValue != nil {
		out.fetched = make(map[Key]any, len(out.keys))
		for _, k := range out.keys {
			out.fetched[k] = c.fetchValue(out.items[k].self)
		}
	}
	return out, nil
}

// external runs the relations whose child has its own connection.
func (a *assembler) external(r *request) error {
	for parent, rels := range r.external {
		parents := a.made[parent]
		if len(parents) == 0 {
			continue
		}
		for _, rel := range rels {
			if err := attachExternal(parents, rel); err != nil {
				return err
			}
		}
	}
	return nil
}

func attachExternal(parents []*Core, rel relSpec) error {
	ch := rel.child
	var values []any
	seen := map[string]bool{}
	for _, p := range parents {
		if ch.possible != nil && !SameScalar(p.value(ch.possible.column), ch.possible.value) {
			continue
		}
		v := p.value(ch.matchLeft)
		if v == nil || seen[scalarKey(v)] {
			continue
		}
		seen[scalarKey(v)] = true
		values = append(values, v)
	}
	type entry struct {
		key Key
		m   *Core
	}
	byKey := map[string][]entry{}
	if len(values) > 0 {
		q := ch.Clone()
		q.matchLeft, q.alias = "", ""
		match := condNode{pred: &predSpec{column: ch.matchRight, op: "in", value: values, list: true}}
		if len(q.where.items) > 0 {
			q.where = condGroup{items: []condNode{{group: &condGroup{items: q.where.items}}}}
			match.conn = "and"
		}
		q.where.items = append(q.where.items, match)
		rows, err := q.load("all")
		if err != nil {
			return err
		}
		for _, k := range rows.keys {
			m := rows.items[k]
			key := scalarKey(m.value(ch.matchRight))
			if ch.groupLimit > 0 && len(byKey[key]) >= ch.groupLimit {
				continue
			}
			byKey[key] = append(byKey[key], entry{k, m})
		}
	}
	name := ch.resultName(rel.many)
	for _, p := range parents {
		if _, dup := p.row.related[name]; dup {
			return configErr("relation result name %s is used twice", name)
		}
		matched := byKey[scalarKey(p.value(ch.matchLeft))]
		if ch.possible != nil && !SameScalar(p.value(ch.possible.column), ch.possible.value) {
			matched = nil
		}
		if rel.many {
			coll := &collection{}
			for _, e := range matched {
				coll.put(e.key, e.m)
			}
			p.row.setRelated(name, ch.ent.collection(coll), !ch.deleteLock, false)
			continue
		}
		var v any
		if len(matched) > 0 {
			v = matched[0].m.self
		}
		p.row.setRelated(name, v, !ch.deleteLock, ch.parentNode)
	}
	return nil
}

// updatedColumn is the column that records the last update of a row.
func updatedColumn(ent *schema.Entity) string {
	if ent == nil || ent.Timestamps == nil {
		return ""
	}
	return ent.Timestamps.Updated
}

// Get runs the query and returns the first model, or nil.
func (c *Core) Get() (Model, error) {
	rows, err := c.load("one")
	if err != nil || len(rows.keys) == 0 {
		return nil, err
	}
	return rows.items[rows.keys[0]].self, nil
}

// Gets runs the query and returns the collection.
func Gets[T Model](c *Core) (*Collection[T], error) {
	rows, err := c.load("all")
	if err != nil {
		return nil, err
	}
	return c.ent.collection(rows).(*Collection[T]), nil
}

// GetsCount runs a grouped count; each model carries row_count.
func GetsCount[T Model](c *Core) (*Collection[T], error) {
	rows, err := c.load("group_count")
	if err != nil {
		return nil, err
	}
	return c.ent.collection(rows).(*Collection[T]), nil
}

// GetsPage returns one page and the total count.
func GetsPage[T Model](c *Core, page, perPage int) (*Page[T], error) {
	if page < 1 || perPage < 1 {
		return nil, configErr("getsPage requires a positive page and perPage")
	}
	if c.limit != nil {
		return nil, configErr("getsPage cannot be combined with limit")
	}
	ex, err := c.terminal()
	if err != nil {
		return nil, err
	}
	q := c.Clone()
	q.limit = &ir.Limit{Offset: (page - 1) * perPage, Count: perPage}
	r := q.build("paginate")
	res, total, err := paginate(ex, r)
	if err != nil {
		return nil, err
	}
	rows, err := q.assemble(ex, r, res, res.plan.Steps[0].Assemble)
	if err != nil {
		return nil, err
	}
	pages := (total + int64(perPage) - 1) / int64(perPage)
	return &Page[T]{Items: c.ent.collection(rows).(*Collection[T]), TotalCount: total, TotalPages: pages, Page: page, PerPage: perPage}, nil
}

// GetCount returns the number of matching rows.
func (c *Core) GetCount() (int64, error) {
	ex, err := c.terminal()
	if err != nil {
		return 0, err
	}
	v, err := scalar(ex, c.build("count"))
	return AsInt64(v), err
}

// GetSum returns the sum of the column selected with sum<Col>().
func (c *Core) GetSum() (float64, error) { return c.aggregate("sum") }

// GetAvg returns the average of the column selected with avg<Col>().
func (c *Core) GetAvg() (float64, error) { return c.aggregate("avg") }

func (c *Core) aggregate(fn string) (float64, error) {
	if c.aggFn != fn {
		return 0, configErr("get%s requires %s<Col>()", titled(fn), fn)
	}
	ex, err := c.terminal()
	if err != nil {
		return 0, err
	}
	r := c.build(fn)
	r.ir.Agg = c.agg
	v, err := scalar(ex, r)
	return AsFloat64(v), err
}

func titled(s string) string { return string(s[0]-'a'+'A') + s[1:] }

// GetQuery returns the statement of gets() without executing it.
func (c *Core) GetQuery() (*Statement, error) {
	ex, err := c.terminal()
	if err != nil {
		return nil, err
	}
	return ex.base().statement(ex.context(), c.build("all"))
}

func inTransaction(conn *DB, fn func() error) error {
	if conn == nil {
		if innermost() == nil {
			return configErr("the model has no connection; use connect or run it inside a transaction")
		}
		return fn()
	}
	return conn.Transaction(fn, Retry(0))
}

func (c *Core) writer(d *DB) (*schema.Entity, error) {
	ent := c.entitySchema(d)
	if ent == nil {
		return nil, configErr("entity %s is not registered for the connection", c.ent.Name)
	}
	return ent, nil
}

func (r *request) assign(ent *schema.Entity, s setSpec) (ir.Assign, error) {
	a := ir.Assign{Column: s.column}
	switch {
	case s.null:
		a.Null = true
	case s.raw != nil:
		pred := r.rawPred(s.raw)
		a.Expr, a.Ps = pred.Expr, pred.Ps
	case s.plus:
		i := r.param(s.value)
		a.PlusP = &i
	case s.minus:
		i := r.param(s.value)
		a.MinusP = &i
	default:
		v, err := encodeValue(ent, s.column, s.value)
		if err != nil {
			return a, err
		}
		if v == nil {
			a.Null = true
			break
		}
		i := r.param(v)
		a.P = &i
	}
	return a, nil
}

func encodeValue(ent *schema.Entity, column string, v any) (any, error) {
	col := ent.Column(column)
	if col == nil {
		return nil, &ir.Error{Code: CodeColumnUnknown, Msg: ent.Name + "." + column}
	}
	if _, ok := v.(NullType); ok {
		return nil, nil
	}
	var codec []string
	for _, s := range col.Styles {
		if s != "aes" && s != "hex" && s != "ip" {
			codec = append(codec, s)
		}
	}
	if len(codec) == 0 {
		return v, nil
	}
	return Encode(codec, v)
}

func (c *Core) writeRequest(kind string, d *DB) (*request, *schema.Entity, error) {
	ent, err := c.writer(d)
	if err != nil {
		return nil, nil, err
	}
	r := &request{}
	r.ir.IRVersion = ir.Version
	r.ir.SchemaHash = c.ent.Schema.Hash
	r.ir.Kind = kind
	r.ir.Entity = c.ent.Name
	return r, ent, nil
}

// Create inserts the model and returns the created model.
func (c *Core) Create() (Model, error) {
	ex, err := c.terminal()
	if err != nil {
		return nil, err
	}
	if len(c.sets) == 0 {
		return nil, configErr("create requires set<Col> values")
	}
	d := ex.base()
	r, ent, err := c.writeRequest("insert", d)
	if err != nil {
		return nil, err
	}
	for _, s := range c.sets {
		a, err := r.assign(ent, s)
		if err != nil {
			return nil, err
		}
		r.ir.Set = append(r.ir.Set, a)
	}
	if c.duplication != nil {
		for _, s := range c.duplication.sets {
			a, err := r.assign(ent, s)
			if err != nil {
				return nil, err
			}
			r.ir.OnDuplicate = append(r.ir.OnDuplicate, a)
		}
		if len(r.ir.OnDuplicate) == 0 {
			return nil, configErr("duplication model has no set<Col> values")
		}
	}
	r.ir.NParams = len(r.params)
	id, _, err := write(ex, r)
	if err != nil {
		return nil, err
	}
	m := c.ent.New(NewCore(c.ent)).Orm_()
	m.conn = c.conn
	st := &rowState{original: map[string]any{}}
	m.row = st
	for _, s := range c.sets {
		st.addName(s.column)
		if !s.plus && !s.minus && s.raw == nil {
			v := s.value
			if s.null {
				v = nil
			}
			if _, ok := v.(NullType); ok {
				v = nil
			}
			if t, ok := v.(time.Time); ok {
				v = t.In(d.location)
			}
			c.ent.Assign(m.self, s.column, v)
		}
	}
	if ent.Auto != "" {
		st.addName(ent.Auto)
		c.ent.Assign(m.self, ent.Auto, id)
	}
	st.loaded = true
	for _, pk := range ent.PK {
		v := m.value(pk)
		if isZero(v) {
			st.loaded = false
		}
		st.original[pk] = v
	}
	for _, name := range c.news {
		m.New(name, c.newValues[name])
	}
	c.sets = nil
	c.duplication = nil
	return m.self, nil
}

func isZero(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case int64:
		return x == 0
	case string:
		return x == ""
	}
	return false
}

// Creates inserts models in multi-row statements in one transaction and
// returns the inserted row count.
func Creates[T Model](c *Core, models []T) (int64, error) {
	ex, err := c.terminal()
	if err != nil {
		return 0, err
	}
	if len(models) == 0 {
		return 0, nil
	}
	d := ex.base()
	first := models[0].Orm_()
	if len(first.sets) == 0 {
		return 0, configErr("creates requires models with set<Col> values")
	}
	columns := make([]string, len(first.sets))
	for i, s := range first.sets {
		if s.raw != nil || s.plus || s.minus {
			return 0, configErr("creates accepts stored values only")
		}
		columns[i] = s.column
	}
	per := driverBindLimit(d.driver) / len(columns)
	var total int64
	err = inTransaction(c.conn, func() error {
		for start := 0; start < len(models); start += per {
			end := min(start+per, len(models))
			r, ent, err := c.writeRequest("insert", d)
			if err != nil {
				return err
			}
			for i, m := range models[start:end] {
				mc := m.Orm_()
				if len(mc.sets) != len(columns) {
					return configErr("every model of creates must set the same columns")
				}
				var row []int
				for j, s := range mc.sets {
					if s.column != columns[j] || s.raw != nil || s.plus || s.minus {
						return configErr("every model of creates must set the same columns in the same order")
					}
					v, err := encodeValue(ent, s.column, s.value)
					if err != nil {
						return err
					}
					if s.null {
						v = nil
					}
					p := r.param(v)
					if i == 0 {
						r.ir.Set = append(r.ir.Set, ir.Assign{Column: s.column, P: &p})
					} else {
						row = append(row, p)
					}
				}
				if i > 0 {
					r.ir.Rows = append(r.ir.Rows, row)
				}
			}
			r.ir.NParams = len(r.params)
			inner, err := resolve(c.conn)
			if err != nil {
				return err
			}
			_, n, err := write(inner, r)
			if err != nil {
				return err
			}
			total += n
		}
		return nil
	})
	return total, err
}

func (c *Core) keyValues(ent *schema.Entity) (map[string]any, error) {
	keys := map[string]any{}
	for _, pk := range ent.PK {
		if c.row != nil && c.row.loaded {
			keys[pk] = c.row.original[pk]
			continue
		}
		found := false
		for _, s := range c.sets {
			if s.column == pk && !s.plus && !s.minus && s.raw == nil && !s.null {
				keys[pk], found = s.value, true
			}
		}
		if !found {
			return nil, configErr("%s requires a loaded row or set primary key %s", ent.Name, pk)
		}
	}
	return keys, nil
}

func keyWhere(r *request, ent *schema.Entity, keys map[string]any) {
	r.ir.Where = &ir.Group{}
	for i, pk := range ent.PK {
		p := r.param(keys[pk])
		pred := &ir.Pred{Column: pk, Op: "eq", P: &p}
		if i > 0 {
			pred.Conn = "and"
		}
		r.ir.Where.Items = append(r.ir.Where.Items, ir.Item{Pred: pred})
	}
}

// Update writes the changed columns of the row. Update(true) also requires
// the stored updated_ts to equal the value that was read.
func (c *Core) Update(optimistic []bool) error {
	if len(optimistic) > 1 {
		return configErr("update accepts one flag")
	}
	ex, err := c.terminal()
	if err != nil {
		return err
	}
	d := ex.base()
	r, ent, err := c.writeRequest("update", d)
	if err != nil {
		return err
	}
	keys, err := c.keyValues(ent)
	if err != nil {
		return err
	}
	loaded := c.row != nil && c.row.loaded
	sets, err := c.withAESColumns(ent)
	if err != nil {
		return err
	}
	for _, s := range sets {
		if !loaded && slices.Contains(ent.PK, s.column) {
			continue
		}
		a, err := r.assign(ent, s)
		if err != nil {
			return err
		}
		r.ir.Set = append(r.ir.Set, a)
	}
	if len(r.ir.Set) == 0 {
		return nil
	}
	keyWhere(r, ent, keys)
	column := updatedColumn(ent)
	if len(optimistic) == 1 && optimistic[0] {
		version, ok := any(nil), false
		if loaded && column != "" {
			version, ok = c.row.original[column]
		}
		if !ok || version == nil {
			return configErr("update(true) requires a row loaded with its update time column")
		}
		r.ir.Optimistic = &ir.Optimist{Column: column, P: r.param(version)}
	}
	r.ir.NParams = len(r.params)
	if _, _, err := write(ex, r); err != nil {
		return err
	}
	if loaded {
		for _, s := range c.sets {
			if slices.Contains(ent.PK, s.column) && !s.plus && !s.minus && s.raw == nil {
				c.row.original[s.column] = s.value
			}
		}
		delete(c.row.original, column)
	}
	c.sets = nil
	return nil
}

// withAESColumns adds the other AES columns of a loaded row when one AES
// column changes, so every AES column is written with the same key version.
func (c *Core) withAESColumns(ent *schema.Entity) ([]setSpec, error) {
	sets := c.sets
	if ent.AESVersion == "" {
		return sets, nil
	}
	changed := false
	for _, s := range sets {
		if col := ent.Column(s.column); col != nil && slices.Contains(col.Styles, "aes") {
			changed = true
		}
	}
	if !changed {
		return sets, nil
	}
	out := slices.Clone(sets)
	for _, col := range ent.Columns {
		if !slices.Contains(col.Styles, "aes") || slices.ContainsFunc(sets, func(s setSpec) bool { return s.column == col.Name }) {
			continue
		}
		if c.row == nil || !slices.Contains(c.row.names, col.Name) {
			return nil, configErr("changing an AES column of %s requires a row loaded with %s", ent.Name, col.Name)
		}
		v := c.value(col.Name)
		if v == nil {
			out = append(out, setSpec{column: col.Name, null: true})
		} else {
			out = append(out, setSpec{column: col.Name, value: v})
		}
	}
	return out, nil
}

// Save updates the row when its primary key is known, otherwise creates it.
func (c *Core) Save() (Model, error) {
	ex, err := c.terminal()
	if err != nil {
		return nil, err
	}
	ent, err := c.writer(ex.base())
	if err != nil {
		return nil, err
	}
	if _, err := c.keyValues(ent); err == nil {
		if err := c.Update(nil); err != nil {
			return nil, err
		}
		return c.self, nil
	}
	return c.Create()
}

// Delete deletes the row. Delete(true) first deletes loaded relation rows
// that belong to it, except relations marked with deleteLock.
func (c *Core) Delete(recursive []bool) error {
	if len(recursive) > 1 {
		return configErr("delete accepts one flag")
	}
	if _, err := c.terminal(); err != nil {
		return err
	}
	if len(recursive) == 1 && recursive[0] {
		return inTransaction(c.conn, func() error { return c.delete(recursive) })
	}
	return c.delete(recursive)
}

func (c *Core) delete(recursive []bool) error {
	ex, err := c.terminal()
	if err != nil {
		return err
	}
	if len(recursive) == 1 && recursive[0] && c.row != nil {
		for _, name := range c.row.relNames {
			if !c.row.cascade[name] {
				continue
			}
			switch v := c.row.related[name].(type) {
			case nil:
			case Model:
				if err := v.Orm_().delete(recursive); err != nil {
					return err
				}
			case interface{ deleteAll([]bool) error }:
				if err := v.deleteAll(recursive); err != nil {
					return err
				}
			}
		}
	}
	d := ex.base()
	r, ent, err := c.writeRequest("delete", d)
	if err != nil {
		return err
	}
	keys, err := c.keyValues(ent)
	if err != nil {
		return err
	}
	keyWhere(r, ent, keys)
	r.ir.NParams = len(r.params)
	_, _, err = write(ex, r)
	return err
}

func (c *Collection[T]) deleteAll(recursive []bool) error {
	for _, k := range c.keys {
		if err := c.items[k].Orm_().delete(recursive); err != nil {
			return err
		}
	}
	return nil
}

// ToArray returns the row values: columns, added outputs, attached values,
// and relation results. Relations merged with parentNode add their columns
// where the row has no value of the same name.
func (c *Core) ToArray() map[string]any {
	out := map[string]any{}
	for _, kv := range c.pairs() {
		switch v := kv.value.(type) {
		case Model:
			out[kv.name] = v.Orm_().ToArray()
		case interface{ ToArray() []map[string]any }:
			out[kv.name] = v.ToArray()
		default:
			out[kv.name] = v
		}
	}
	return out
}

type pair struct {
	name  string
	value any
}

func (c *Core) pairs() []pair {
	var out []pair
	seen := map[string]bool{}
	add := func(name string, v any) {
		if seen[name] {
			return
		}
		seen[name] = true
		out = append(out, pair{name, v})
	}
	st := c.row
	if st == nil {
		st = &rowState{}
		for _, s := range c.sets {
			st.addName(s.column)
		}
	}
	for _, name := range st.names {
		if st.hidden[name] {
			continue
		}
		if v, ok := c.ent.Value(c.self, name); ok {
			add(name, arrayValue(v))
		} else {
			add(name, arrayValue(st.extra[name]))
		}
	}
	for _, name := range c.news {
		add(name, arrayValue(c.newValues[name]))
	}
	for _, name := range st.relNames {
		add(name, st.related[name])
	}
	for _, name := range st.flat {
		if m, ok := st.related[name].(Model); ok {
			for _, kv := range m.Orm_().pairs() {
				add(kv.name, kv.value)
			}
		}
	}
	return out
}

func arrayValue(v any) any {
	switch x := v.(type) {
	case time.Time:
		return x.Format("2006-01-02 15:04:05.000000")
	case *time.Time:
		if x == nil {
			return nil
		}
		return x.Format("2006-01-02 15:04:05.000000")
	case Point:
		return []float64{x[0], x[1]}
	case *orderedjson.Value:
		return x
	}
	return v
}

// MarshalJSON writes the row values in order.
func (c *Core) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, kv := range c.pairs() {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, _ := json.Marshal(kv.name)
		buf.Write(k)
		buf.WriteByte(':')
		v, err := marshalValue(kv.value)
		if err != nil {
			return nil, err
		}
		buf.Write(v)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func marshalValue(v any) ([]byte, error) {
	if m, ok := v.(Model); ok {
		return m.Orm_().MarshalJSON()
	}
	return json.Marshal(v)
}
