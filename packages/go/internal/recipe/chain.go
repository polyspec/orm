package recipe

// The table path of the model ops (FCV-4): a fixture that generates no models names a model of one of its tables, and the
// helper drives the public builder of the runtime, orm.Core, on the entity of that table. Each query field maps to one call
// of the builder. The generated methods of the same chains stay verified by their native tests (FCV-2, T334-3-5-1); this
// path verifies the builder and no name dispatcher.

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	orderedjson "github.com/polyspec/ordered-json/packages/go"
	"github.com/polyspec/orm/packages/go/orm"
)

// chainOps are the model ops of the table path.
var chainOps = map[string]bool{
	"model.query": true, "model.count": true, "model.get_by": true, "model.create": true, "model.creates": true,
	"model.save": true, "model.duplicate_create": true, "model.update": true, "model.delete": true, "model.restore": true,
	"model.chain": true,
}

// chainQuery holds the fields of a query at any depth: a step, a join, a relation or a subquery.
type chainQuery struct {
	Model         string            `json:"model"`
	Key           json.RawMessage   `json:"key"`
	Where         json.RawMessage   `json:"where"`
	Columns       json.RawMessage   `json:"columns"`
	AddColumns    []json.RawMessage `json:"add_columns"`
	RemoveColumns []string          `json:"remove_columns"`
	Order         []chainOrder      `json:"order"`
	Limit         *chainLimit       `json:"limit"`
	Lock          string            `json:"lock"`
	Aggregate     *chainAggregate   `json:"aggregate"`
	Joins         []chainJoin       `json:"joins"`
	Relations     []chainRelation   `json:"relations"`
	ForceIndex    string            `json:"force_index"`
}

type chainOrder struct {
	Column string   `json:"column"`
	Fn     *chainFn `json:"fn"`
	Dir    string   `json:"dir"`
}

// UnmarshalJSON reads an order entry: an object, or a column name that is descending when it begins with "-" (FCV-4).
func (o *chainOrder) UnmarshalJSON(raw []byte) error {
	var name string
	if err := json.Unmarshal(raw, &name); err == nil {
		column, descending := strings.CutPrefix(name, "-")
		o.Column, o.Dir = column, "asc"
		if descending {
			o.Dir = "desc"
		}
		return nil
	}
	type plain chainOrder
	return json.Unmarshal(raw, (*plain)(o))
}

type chainLimit struct {
	Offset int `json:"offset"`
	Count  int `json:"count"`
}

// UnmarshalJSON reads a limit: an object, or the count of the form that names its offset beside it (FCV-4).
func (l *chainLimit) UnmarshalJSON(raw []byte) error {
	if err := json.Unmarshal(raw, &l.Count); err == nil {
		return nil
	}
	type plain chainLimit
	return json.Unmarshal(raw, (*plain)(l))
}

type chainAggregate struct {
	Agg     string   `json:"agg"`
	Column  string   `json:"column"`
	GroupBy []string `json:"group_by"`
}

type chainFn struct {
	Fn   string            `json:"fn"`
	Args []json.RawMessage `json:"args"`
}

type chainJoin struct {
	chainQuery
	Kind    string          `json:"kind"`
	Match   []string        `json:"match"`
	On      json.RawMessage `json:"on"`
	As      string          `json:"as"`
	Alias   string          `json:"alias"`
	Connect bool            `json:"connect"`
}

type chainRelation struct {
	chainQuery
	Match      [][2]string     `json:"match"`
	Many       bool            `json:"many"`
	Connect    bool            `json:"connect"`
	Alias      string          `json:"alias"`
	GroupLimit int             `json:"group_limit"`
	KeyBy      string          `json:"key_by"`
	Possible   json.RawMessage `json:"possible"`
	ParentNode bool            `json:"parent_node"`
	DeleteLock bool            `json:"delete_lock"`
}

// chainStep is a model op of the table path.
type chainStep struct {
	chainQuery
	Op              string                     `json:"op"`
	Connection      string                     `json:"connection"`
	As              string                     `json:"as"`
	From            string                     `json:"from"`
	Pick            []string                   `json:"pick"`
	KeyBy           string                     `json:"key_by"`
	OrderedText     string                     `json:"ordered_text"`
	GroupValue      string                     `json:"group_value"`
	DerivedIntegers []string                   `json:"derived_integers"`
	Page            bool                       `json:"page"`
	Compile         bool                       `json:"compile"`
	Plan            bool                       `json:"plan"`
	PlanPage        *chainPlanPage             `json:"plan_page"`
	PlanSQL         bool                       `json:"plan_sql"`
	Unconnected     bool                       `json:"unconnected"`
	PlanCount       []string                   `json:"plan_count"`
	Items           bool                       `json:"items"`
	Values          json.RawMessage            `json:"values"`
	Attached        json.RawMessage            `json:"attached"`
	Duplication     json.RawMessage            `json:"duplication"`
	Rows            json.RawMessage            `json:"rows"`
	RowsSequence    *chainSequence             `json:"rows_sequence"`
	Batch           int                        `json:"batch"`
	Row             json.RawMessage            `json:"row"`
	Offset          int                        `json:"offset"`
	Relation        json.RawMessage            `json:"relation"`
	Expect          map[string]json.RawMessage `json:"expect"`
	Set             json.RawMessage            `json:"set"`
	Optimistic      bool                       `json:"optimistic"`
	Restore         bool                       `json:"restore"`
	RestoreOrCreate bool                       `json:"restore_or_create"`
	Recursive       bool                       `json:"recursive"`
	Revision        *chainRevision             `json:"revision"`
}

// chainSequence is rows_sequence of model.creates: count rows of values whose column holds from, from + 1 and so on.
type chainSequence struct {
	Column string          `json:"column"`
	From   int64           `json:"from"`
	Count  int             `json:"count"`
	Values json.RawMessage `json:"values"`
}

type chainRevision struct {
	Column string          `json:"column"`
	Value  json.RawMessage `json:"value"`
}

// chainBuild is the state of building one query: the joined models that its predicates name, and the enclosing model that
// an outer reference names.
type chainBuild struct {
	c      *databaseContext
	joined map[string]*orm.Core
	outer  *orm.Core
	db     *orm.DB // the connection of the step, for a join that names connect
}

// snakeOf is the table of a model name as the generator spells it: CompositeAccount is composite_account.
func snakeOf(model string) string {
	var out strings.Builder
	for i, r := range model {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				out.WriteByte('_')
			}
			out.WriteRune(r + ('a' - 'A'))
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

// chainCore is a new core of a model of the fixture, on no connection.
func chainCore(model string, c *databaseContext) *orm.Core {
	ent := tableEntity(snakeOf(model), c.schema)
	core := orm.NewCore(ent)
	ent.New(core)
	return core
}

// chainValue is the native argument of a value wrapper: orm.Null for SQL NULL, the list of an array, and an object as the
// styled value of a column.
func chainValue(raw json.RawMessage, c *databaseContext) (any, error) {
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err == nil {
		if _, isNull := entries["null"]; isNull && len(entries) == 1 {
			return orm.Null, nil
		}
		if object, isObject := entries["object"]; isObject && len(entries) == 1 {
			var pairs [][2]json.RawMessage
			if err := json.Unmarshal(object, &pairs); err != nil {
				return nil, err
			}
			out := map[string]any{}
			for _, pair := range pairs {
				var key string
				if err := json.Unmarshal(pair[0], &key); err != nil {
					return nil, err
				}
				v, err := chainPlain(pair[1], c)
				if err != nil {
					return nil, err
				}
				out[key] = v
			}
			return orm.Value(out), nil
		}
	}
	return assignmentValue(raw, c)
}

// columnValue is the value of a column for a wrapper: a styled wrapper is the styled value of its value, and an object is
// the styled value of the codec of its column, so that an ordered_json column keeps its member order and number text.
func columnValue(core *orm.Core, column string, raw json.RawMessage, c *databaseContext) (any, error) {
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return chainValue(raw, c)
	}
	if styled, ok := entries["styled"]; ok && len(entries) == 1 {
		value, err := chainPlain(styled, c)
		if err != nil {
			return nil, err
		}
		return orm.Value(value), nil
	}
	if _, ok := entries["object"]; ok && len(entries) == 1 {
		model, err := c.schema.Model()
		if err != nil {
			return nil, err
		}
		if entity := model.Entities[core.Entity().Name]; entity != nil {
			if field := entity.Field(column); field != nil && slices.Contains(field.Codec, "ordered_json") {
				return styledArgument(raw, field.Codec, nil)
			}
		}
	}
	return chainValue(raw, c)
}

// orderedText is the text of the ordered-json value that a read holds in column, with its repeated members (DIA-26).
func orderedText(row *tableRow, column string) (string, error) {
	styled, ok := row.vals[column].(orm.StyledValue)
	if !ok {
		return "", fmt.Errorf("ordered_text: the column %s is a %T", column, row.vals[column])
	}
	data, _ := styled.Data()
	value, ok := data.(*orderedjson.Value)
	if !ok {
		return "", fmt.Errorf("ordered_text: the value of %s is a %T", column, data)
	}
	return value.Raw(), nil
}

// chainPlain is a member of a styled object: the native value of its wrapper, without the styled-value wrapping.
func chainPlain(raw json.RawMessage, c *databaseContext) (any, error) {
	return assignmentValue(raw, c)
}

// chainFunc is the public function of a function call (F5).
func chainFunc(f *chainFn) (orm.Func, error) {
	var n int
	for _, arg := range f.Args {
		var wrapped struct {
			Int    string `json:"int"`
			Column string `json:"column"`
		}
		if err := json.Unmarshal(arg, &wrapped); err != nil {
			return orm.Func{}, err
		}
		if wrapped.Column != "" {
			continue
		}
		parsed, err := strconv.Atoi(wrapped.Int)
		if err != nil {
			return orm.Func{}, err
		}
		n = parsed
	}
	switch f.Fn {
	case "year":
		return orm.Year(), nil
	case "month":
		return orm.Month(), nil
	case "day_of_week":
		return orm.DayOfWeek(), nil
	case "now":
		return orm.Now(), nil
	case "days_ago":
		return orm.DaysAgo(n), nil
	case "days_later":
		return orm.DaysLater(n), nil
	case "months_ago":
		return orm.MonthsAgo(n), nil
	case "months_later":
		return orm.MonthsLater(n), nil
	case "seconds_ago":
		return orm.SecondsAgo(n), nil
	}
	return orm.Func{}, fmt.Errorf("function %s has no recipe entry", f.Fn)
}

// fnColumn is the column of a function call on a column.
func fnColumn(f *chainFn) (string, error) {
	for _, arg := range f.Args {
		var wrapped struct {
			Column string `json:"column"`
		}
		if err := json.Unmarshal(arg, &wrapped); err != nil {
			return "", err
		}
		if wrapped.Column != "" {
			return wrapped.Column, nil
		}
	}
	return "", fmt.Errorf("function %s names no column", f.Fn)
}

// operatorKeys are the chain operators of the predicate operators of FCV-4.
var operatorKeys = map[string]string{
	"eq": "", "ne": "ne", "gt": "gt", "ge": "ge", "lt": "lt", "le": "le", "in": "", "not_in": "ne", "between": "between",
	"like": "lk", "binary_like": "lb", "is_null": "", "not_null": "ne",
}

// predicate adds the predicate raw to core, joined by conn.
func (b *chainBuild) predicate(core *orm.Core, conn string, raw json.RawMessage) error {
	members, err := orderedMembers(raw)
	if err != nil {
		return err
	}
	if len(members) == 1 {
		switch members[0].key {
		case "chain":
			return b.items(core, conn, members[0].value)
		case "and", "or":
			return b.group(core, conn, members[0].key, members[0].value)
		case "not":
			g := core.Group()
			core.Entity().New(g)
			if err := b.predicate(g, "", members[0].value); err != nil {
				return err
			}
			core.AddNegatedGroup(conn, g)
			return nil
		case "placed":
			var unjoined struct {
				Model string `json:"model"`
			}
			if err := json.Unmarshal(members[0].value, &unjoined); err == nil {
				core.Connector(conn, []any{chainCore(unjoined.Model, b.c).Self()})
				return nil
			}
			var name string
			if err := json.Unmarshal(members[0].value, &name); err != nil {
				return err
			}
			child, ok := b.joined[name]
			if !ok {
				return fmt.Errorf("placed %s names no join", name)
			}
			core.Connector(conn, []any{child.Self()})
			return nil
		case "tuple":
			return b.tuple(core, conn, members[0].value)
		case "fulltext_boolean":
			var search struct {
				Columns []string `json:"columns"`
				Text    string   `json:"text"`
			}
			if err := json.Unmarshal(members[0].value, &search); err != nil {
				return err
			}
			core.Where(conn, []orm.ChainKey{{Op: "fulltext_boolean", Columns: search.Columns}}, search.Text)
			return nil
		}
	}
	if len(members) == 2 && members[0].key == "expr" && members[1].key == "cmp" {
		return b.functionLeaf(core, conn, members[0].value, members[1].value)
	}
	for i, member := range members {
		keyConn := conn
		if i > 0 {
			keyConn = "and"
		}
		if err := b.leaf(core, keyConn, member.key, member.value); err != nil {
			return err
		}
	}
	return nil
}

// items adds the items of a chain: each is [connector, predicate], or [connector] alone for a connector written as its own
// call. The first item of the chain takes conn when it names none.
func (b *chainBuild) items(core *orm.Core, conn string, raw json.RawMessage) error {
	var items [][]json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return err
	}
	for i, item := range items {
		var itemConn string
		if err := json.Unmarshal(item[0], &itemConn); err != nil {
			return err
		}
		if i == 0 && itemConn == "" {
			itemConn = conn
		}
		if len(item) == 1 {
			core.Connector(itemConn, nil)
			continue
		}
		if err := b.nested(core, itemConn, item[1]); err != nil {
			return err
		}
	}
	return nil
}

// group adds the predicates of an and or an or: at the top of a where they join flat, and an item that is itself an and, an
// or or a not is a parenthesised group of its own.
func (b *chainBuild) group(core *orm.Core, conn, joined string, raw json.RawMessage) error {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return err
	}
	for i, item := range items {
		itemConn := joined
		if i == 0 {
			itemConn = conn
		}
		if err := b.nested(core, itemConn, item); err != nil {
			return err
		}
	}
	return nil
}

// nested adds a predicate inside a list: an and, an or or a chain opens a group callback of the model.
func (b *chainBuild) nested(core *orm.Core, conn string, raw json.RawMessage) error {
	members, err := orderedMembers(raw)
	if err != nil {
		return err
	}
	if len(members) == 1 && (members[0].key == "and" || members[0].key == "or" || members[0].key == "chain") {
		g := core.Group()
		core.Entity().New(g)
		if err := b.predicate(g, "", raw); err != nil {
			return err
		}
		core.AddGroup(conn, g)
		return nil
	}
	return b.predicate(core, conn, raw)
}

// expression reads one operand of a leaf: a joined column, a correlated column, a subquery, a function or a value. The
// compare is the column of the other model when the operand is a column.
func (b *chainBuild) expression(raw json.RawMessage) (value any, compare string, err error) {
	members, err := orderedMembers(raw)
	if err == nil && len(members) == 1 {
		switch members[0].key {
		case "column":
			var name string
			if err := json.Unmarshal(members[0].value, &name); err != nil {
				return nil, "", err
			}
			ref, column, ok := strings.Cut(name, ".")
			if !ok {
				return nil, "", fmt.Errorf("column operand %s names no joined model", name)
			}
			child, ok := b.joined[ref]
			if !ok {
				return nil, "", fmt.Errorf("column operand %s names no join", name)
			}
			return child.Self(), column, nil
		case "outer":
			var name string
			if err := json.Unmarshal(members[0].value, &name); err != nil {
				return nil, "", err
			}
			if b.outer == nil {
				return nil, "", fmt.Errorf("outer %s has no enclosing query", name)
			}
			return b.outer.Self(), name, nil
		case "sub":
			var sub chainQuery
			if err := json.Unmarshal(members[0].value, &sub); err != nil {
				return nil, "", err
			}
			child := chainCore(sub.Model, b.c)
			if err := (&chainBuild{c: b.c, joined: map[string]*orm.Core{}, outer: b.outer}).query(child, sub); err != nil {
				return nil, "", err
			}
			return child.Self(), "", nil
		}
	}
	var fn chainFn
	if err := json.Unmarshal(raw, &fn); err == nil && fn.Fn != "" {
		f, err := chainFunc(&fn)
		return f, "", err
	}
	value, err = chainValue(raw, b.c)
	return value, "", err
}

// leaf adds {column: value} or {column: {operator: operand}}.
func (b *chainBuild) leaf(core *orm.Core, conn, column string, raw json.RawMessage) error {
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return fmt.Errorf("the condition of %s: %w", column, err)
	}
	if len(entries) == 1 {
		for operator, operand := range entries {
			key, ok := operatorKeys[operator]
			if !ok {
				break
			}
			chainKey := orm.ChainKey{Op: key, Column: column}
			switch operator {
			case "is_null", "not_null":
				core.Where(conn, []orm.ChainKey{chainKey}, orm.Null)
				return nil
			case "between":
				var pair [2]json.RawMessage
				if err := json.Unmarshal(operand, &pair); err != nil {
					return err
				}
				low, err := chainValue(pair[0], b.c)
				if err != nil {
					return err
				}
				high, err := chainValue(pair[1], b.c)
				if err != nil {
					return err
				}
				core.Where(conn, []orm.ChainKey{chainKey}, [2]any{low, high})
				return nil
			}
			value, compare, err := b.expression(operand)
			if err != nil {
				return err
			}
			chainKey.Compare = compare
			core.Where(conn, []orm.ChainKey{chainKey}, value)
			return nil
		}
	}
	value, err := chainValue(raw, b.c)
	if err != nil {
		return err
	}
	core.Where(conn, []orm.ChainKey{{Column: column}}, value)
	return nil
}

// functionLeaf adds {expr: <function of a column>, cmp: {operator: value}}.
func (b *chainBuild) functionLeaf(core *orm.Core, conn string, expr, cmp json.RawMessage) error {
	var fn chainFn
	if err := json.Unmarshal(expr, &fn); err != nil {
		return err
	}
	f, err := chainFunc(&fn)
	if err != nil {
		return err
	}
	column, err := fnColumn(&fn)
	if err != nil {
		return err
	}
	members, err := orderedMembers(cmp)
	if err != nil {
		return err
	}
	if len(members) != 1 {
		return fmt.Errorf("cmp holds %d operators, want one", len(members))
	}
	value, err := chainValue(members[0].value, b.c)
	if err != nil {
		return err
	}
	core.Where(conn, []orm.ChainKey{{Op: operatorKeys[members[0].key], Column: column}}, f, value)
	return nil
}

// tupleRow is a value group of a tuple condition; orm reads the fields of a struct in order, so the helper declares the
// widths that the fixture uses.
type tupleRow struct{ A, B any }

// tuple adds {"tuple": [[column, ...], [[value, ...], ...]]} through the tuple key of a composite key (DSL-82).
func (b *chainBuild) tuple(core *orm.Core, conn string, raw json.RawMessage) error {
	var parts []json.RawMessage
	if err := json.Unmarshal(raw, &parts); err != nil {
		return err
	}
	if len(parts) != 2 {
		return fmt.Errorf("a tuple is [columns, rows]")
	}
	var columns []string
	if err := json.Unmarshal(parts[0], &columns); err != nil {
		return err
	}
	var rows [][]json.RawMessage
	if err := json.Unmarshal(parts[1], &rows); err != nil {
		return err
	}
	if len(columns) != 2 {
		return fmt.Errorf("a tuple of %d columns has no recipe entry", len(columns))
	}
	values := make([]tupleRow, 0, len(rows))
	for _, row := range rows {
		first, err := chainValue(row[0], b.c)
		if err != nil {
			return err
		}
		second, err := chainValue(row[1], b.c)
		if err != nil {
			return err
		}
		values = append(values, tupleRow{A: first, B: second})
	}
	core.Where(conn, []orm.ChainKey{{Op: "tuple", Columns: columns}}, values)
	return nil
}

// columnEntry adds one entry of columns or add_columns: a name, a function of a column under a name, or a scalar subquery
// under a name.
func (b *chainBuild) columnEntry(core *orm.Core, raw json.RawMessage) error {
	var name string
	if err := json.Unmarshal(raw, &name); err == nil {
		core.AddColumn(name)
		return nil
	}
	var entry struct {
		Expr struct {
			chainFn
			Sub *chainQuery `json:"sub"`
		} `json:"expr"`
		As string `json:"as"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		return err
	}
	if entry.Expr.Sub != nil {
		sub := *entry.Expr.Sub
		core.AddColumnSub(entry.As, func(outer orm.Model) orm.Model {
			child := chainCore(sub.Model, b.c)
			if err := (&chainBuild{c: b.c, joined: map[string]*orm.Core{}, outer: outer.Orm_()}).query(child, sub); err != nil {
				b.c.t.Fatalf("the subquery column %s: %v", entry.As, err)
			}
			return child.Self()
		})
		return nil
	}
	f, err := chainFunc(&entry.Expr.chainFn)
	if err != nil {
		return err
	}
	column, err := fnColumn(&entry.Expr.chainFn)
	if err != nil {
		return err
	}
	core.AddColumnFunc(column, entry.As, f)
	return nil
}

// query applies the fields of q to core, in the order that a chain writes them: the projection, the joins and relations,
// the conditions, the order, the limit and the lock.
func (b *chainBuild) query(core *orm.Core, q chainQuery) error {
	if len(q.Columns) > 0 {
		var all string
		if err := json.Unmarshal(q.Columns, &all); err == nil {
			if all != "all" {
				return fmt.Errorf("columns %q is neither a list nor all", all)
			}
			core.AddAllColumns()
		} else {
			var entries []json.RawMessage
			if err := json.Unmarshal(q.Columns, &entries); err != nil {
				return err
			}
			core.RemoveAllColumns()
			for _, entry := range entries {
				if err := b.columnEntry(core, entry); err != nil {
					return err
				}
			}
		}
	}
	for _, entry := range q.AddColumns {
		if err := b.columnEntry(core, entry); err != nil {
			return err
		}
	}
	for _, column := range q.RemoveColumns {
		core.RemoveColumn(column)
	}
	if q.Aggregate != nil {
		if q.Aggregate.Column != "" {
			core.Aggregate(q.Aggregate.Agg, q.Aggregate.Column)
		}
		for _, column := range q.Aggregate.GroupBy {
			core.GroupBy(column)
		}
	}
	for _, j := range q.Joins {
		child := chainCore(j.Model, b.c)
		inner := &chainBuild{c: b.c, joined: map[string]*orm.Core{}, outer: b.outer}
		if j.Alias != "" {
			child.Alias(j.Alias)
		}
		if len(j.On) > 0 {
			g := child.Group()
			child.Entity().New(g)
			if err := inner.predicate(g, "", j.On); err != nil {
				return err
			}
			child.On(g)
		}
		if err := inner.query(child, j.chainQuery); err != nil {
			return err
		}
		kind := j.Kind
		if kind == "" {
			kind = "inner"
		}
		if j.Connect {
			child.Connect(b.db)
		}
		core.Join(kind, j.Match[0], j.Match[1], child.Self())
		if j.As != "" {
			b.joined[j.As] = child
		}
	}
	for _, r := range q.Relations {
		child, err := b.relation(r)
		if err != nil {
			return err
		}
		core.Relation(r.Many, child.Self())
	}
	if len(q.Where) > 0 {
		if err := b.predicate(core, "", q.Where); err != nil {
			return err
		}
	}
	for _, o := range q.Order {
		var fn []orm.Func
		column := o.Column
		if o.Fn != nil {
			f, err := chainFunc(o.Fn)
			if err != nil {
				return err
			}
			if column, err = fnColumn(o.Fn); err != nil {
				return err
			}
			fn = []orm.Func{f}
		}
		core.OrderBy(column, o.Dir == "desc", fn)
	}
	if q.Limit != nil {
		core.Limit(q.Limit.Offset, q.Limit.Count)
	}
	if q.Lock != "" {
		core.Lock(q.Lock)
	}
	if q.ForceIndex != "" {
		core.ForceIndex(q.ForceIndex)
	}
	return nil
}

// relation is the child core of a relation.
func (b *chainBuild) relation(r chainRelation) (*orm.Core, error) {
	child := chainCore(r.Model, b.c)
	for _, pair := range r.Match {
		child.Match(pair[0], pair[1])
	}
	if r.Alias != "" {
		child.Alias(r.Alias)
	}
	if len(r.Possible) > 0 {
		members, err := orderedMembers(r.Possible)
		if err != nil {
			return nil, err
		}
		for _, member := range members {
			value, err := chainValue(member.value, b.c)
			if err != nil {
				return nil, err
			}
			child.Possible(member.key, value)
		}
	}
	if r.ParentNode {
		child.ParentNode()
	}
	if err := (&chainBuild{c: b.c, joined: map[string]*orm.Core{}, outer: b.outer}).query(child, r.chainQuery); err != nil {
		return nil, err
	}
	if r.GroupLimit > 0 {
		child.GroupLimit(r.GroupLimit)
	}
	if r.KeyBy != "" {
		child.KeyName(r.KeyBy)
	}
	if r.DeleteLock {
		child.DeleteLock()
	}
	return child, nil
}

// chainKeyArgs reads the key of a terminal by: its chain keys and arguments, in the written order.
func chainKeyArgs(raw json.RawMessage, c *databaseContext) ([]orm.ChainKey, []any, error) {
	members, err := orderedMembers(raw)
	if err != nil {
		return nil, nil, err
	}
	keys := make([]orm.ChainKey, len(members))
	args := make([]any, len(members))
	for i, member := range members {
		keys[i] = orm.ChainKey{Column: member.key}
		if i > 0 {
			keys[i].Conn = "and"
		}
		if args[i], err = chainValue(member.value, c); err != nil {
			return nil, nil, err
		}
	}
	return keys, args, nil
}

// chainRow is the toArray of a row, narrowed to pick when it is named; a nil row is null.
func chainRow(row *tableRow, pick []string) (any, error) {
	if row == nil {
		return nil, nil
	}
	values := row.m.ToArray()
	if len(pick) == 0 {
		return values, nil
	}
	out := map[string]any{}
	for _, name := range pick {
		value, ok := values[name]
		if !ok {
			return nil, fmt.Errorf("the row has no field %s", name)
		}
		out[name] = value
	}
	return out, nil
}

// chainRows is chainRow of each row.
func chainRows(rows []*tableRow, pick []string) ([]any, error) {
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		value, err := chainRow(row, pick)
		if err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, nil
}

// jsonOutcome is the outcome of a step whose expect is {"json": <value>}.
func jsonOutcome(value any) outcome {
	return outcome{fields: map[string]any{"json": value}}
}

// chainOp runs a model op of the table path.
func chainOp(raw json.RawMessage, c *databaseContext) (outcome, error) {
	var s chainStep
	if err := json.Unmarshal(raw, &s); err != nil {
		return outcome{}, err
	}
	// A model op that names no connection and no row runs on the case connection (FCV-4).
	db := c.db
	if len(s.Row) > 0 {
		db = nil
	}
	if s.Connection != "" {
		bound, ok := c.bound[s.Connection]
		if !ok {
			return outcome{}, fmt.Errorf("%s: connection %q is not bound", s.Op, s.Connection)
		}
		if db, ok = bound.api.(*orm.DB); !ok {
			return outcome{}, fmt.Errorf("%s: connection %q is not bound by model.connect", s.Op, s.Connection)
		}
	}
	switch s.Op {
	case "model.chain":
		core, err := chainBuilt(s, db, c)
		if err != nil {
			return outcome{}, err
		}
		return outcome{api: core, fields: map[string]any{}}, nil
	case "model.query":
		return chainGets(s, db, c)
	case "model.count":
		core, err := chainBuilt(s, db, c)
		if err != nil {
			return outcome{}, err
		}
		n, err := core.GetCount()
		if err != nil {
			return outcome{}, err
		}
		return countOutcome(n), nil
	case "model.get_by":
		core, err := chainBuilt(s, db, c)
		if err != nil {
			return outcome{}, err
		}
		m, err := core.Get()
		if err != nil {
			return outcome{}, err
		}
		row, ok := m.(*tableRow)
		if !ok && m != nil {
			return outcome{}, fmt.Errorf("model.get_by: the row is a %T", m)
		}
		if s.OrderedText != "" && row != nil {
			text, err := orderedText(row, s.OrderedText)
			if err != nil {
				return outcome{}, err
			}
			return jsonOutcome(text), nil
		}
		value, err := chainRow(row, s.Pick)
		if err != nil {
			return outcome{}, err
		}
		out := jsonOutcome(value)
		if row != nil {
			out.api = row
		}
		return out, nil
	case "model.create", "model.save", "model.duplicate_create", "model.restore":
		return chainWrite(s, db, c)
	case "model.creates":
		return chainCreates(s, db, c)
	case "model.update":
		return chainUpdate(s, db, c)
	case "model.delete":
		return chainDelete(s, db, c)
	}
	return outcome{}, fmt.Errorf("OP_UNKNOWN %s", s.Op)
}

// chainBuilt is the core of a read: the fields of the step applied, then the key of a terminal by.
func chainBuilt(s chainStep, db *orm.DB, c *databaseContext) (*orm.Core, error) {
	if s.From != "" {
		// A bound chain is read again: a terminal leaves it as it was (DSL-69), and a terminal with a key reads a clone of it.
		core, ok := c.bound[s.From].api.(*orm.Core)
		if !ok {
			return nil, fmt.Errorf("from %s names no bound chain", s.From)
		}
		return chainByKey(core, s, c)
	}
	core := chainCore(s.Model, c)
	if !s.Unconnected {
		core.Connect(db)
	}
	q := s.chainQuery
	if q.Limit != nil && s.Offset > 0 {
		q.Limit = &chainLimit{Offset: s.Offset, Count: q.Limit.Count}
	}
	if s.Page {
		q.Limit = nil
	}
	build := &chainBuild{c: c, joined: map[string]*orm.Core{}, db: db}
	if err := build.query(core, q); err != nil {
		return nil, err
	}
	if s.KeyBy != "" {
		core.KeyName(s.KeyBy)
	}
	if len(s.Relation) > 0 {
		var r chainRelation
		if err := json.Unmarshal(s.Relation, &r); err != nil {
			return nil, err
		}
		// The columns of this relation are read of each child row; they do not narrow its statement.
		r.Columns = nil
		child, err := build.relation(r)
		if err != nil {
			return nil, err
		}
		// Only a relation that names connect runs on the connection of the query; without it the child has no handle and takes the connection of its parent (INT-87).
		if r.Connect {
			child.Connect(db)
		}
		core.Relation(r.Many, child.Self())
	}
	return chainByKey(core, s, c)
}

// chainByKey adds the key of the step to the chain, as the By form of a terminal.
func chainByKey(core *orm.Core, s chainStep, c *databaseContext) (*orm.Core, error) {
	if len(s.Key) == 0 {
		return core, nil
	}
	keys, args, err := chainKeyArgs(s.Key, c)
	if err != nil {
		return nil, err
	}
	return core.By(keys, args...), nil
}

// chainGets runs the terminal of a model.query: Gets, or the terminal of its aggregate, its page or its compile.
func chainGets(s chainStep, db *orm.DB, c *databaseContext) (outcome, error) {
	core, err := chainBuilt(s, db, c)
	if err != nil {
		return outcome{}, err
	}
	switch {
	case s.Compile:
		statement, err := core.GetQuery()
		if err != nil {
			return outcome{}, err
		}
		return jsonOutcome(map[string]any{"sql": statement.SQL, "binds": statement.Binds}), nil
	case s.Aggregate != nil && s.Aggregate.Agg == "sum":
		sum, err := core.GetSum()
		if err != nil {
			return outcome{}, err
		}
		return jsonOutcome(sum), nil
	case s.Aggregate != nil && s.Aggregate.Agg == "avg":
		avg, err := core.GetAvg()
		if err != nil {
			return outcome{}, err
		}
		return jsonOutcome(avg), nil
	case s.Aggregate != nil:
		groups, err := orm.GetsCount(core)
		if err != nil {
			return outcome{}, err
		}
		if s.GroupValue != "" {
			for row := range groups.All() {
				value, err := row.Value(s.GroupValue)
				if err != nil {
					return outcome{}, err
				}
				return jsonOutcome(value), nil
			}
			return outcome{}, fmt.Errorf("group_value %s: the aggregate has no group row", s.GroupValue)
		}
		return jsonOutcome(groups.ToArray()), nil
	case s.Plan:
		var page chainPlanPage
		if s.PlanPage != nil {
			page = *s.PlanPage
		} else {
			var limit chainLimit
			if s.Limit != nil {
				limit = *s.Limit
			}
			if limit.Count <= 0 {
				return outcome{}, fmt.Errorf("a plan needs a limit count above 0")
			}
			page = chainPlanPage{Page: limit.Offset/limit.Count + 1, PerPage: limit.Count}
		}
		steps, err := core.GetPagePlanSteps(page.Page, page.PerPage)
		if err != nil {
			return outcome{}, err
		}
		return jsonOutcome(chainPlanSteps(steps, s.PlanCount, s.PlanSQL)), nil
	case s.Page:
		var limit chainLimit
		if s.Limit != nil {
			limit = chainLimit{Offset: limit.Offset + s.Offset + s.Limit.Offset, Count: s.Limit.Count}
		}
		return chainPage(s, core, limit.Offset/max(limit.Count, 1)+1, limit.Count, c)
	case s.PlanPage != nil:
		return chainPage(s, core, s.PlanPage.Page, s.PlanPage.PerPage, c)
	}
	rows, err := orm.Gets[*tableRow](core)
	if err != nil {
		return outcome{}, err
	}
	value, err := chainRows(rows.Slice(), s.Pick)
	if err != nil {
		return outcome{}, err
	}
	out := jsonOutcome(value)
	out.api = rows
	if wantsRows(s, c) {
		cells, err := chainCells(rows.Slice(), s)
		if err != nil {
			return outcome{}, err
		}
		out.fields["rows"] = cells
	}
	return out, nil
}

// wantsRows reports whether the expect of the database of the case compares rows of wrappers.
func wantsRows(s chainStep, c *databaseContext) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(s.Expect[c.database], &fields); err != nil {
		return false
	}
	_, ok := fields["rows"]
	return ok
}

// chainCells is the rows of wrappers of the columns of a step, each followed by the columns of each related row of its
// relation; a parent without a child gives no row.
func chainCells(parents []*tableRow, s chainStep) ([]any, error) {
	var names []string
	if err := json.Unmarshal(s.Columns, &names); err != nil {
		return nil, fmt.Errorf("a rows expect needs a list of column names: %w", err)
	}
	var rel *tableRelation
	if len(s.Relation) > 0 {
		rel = &tableRelation{}
		if err := json.Unmarshal(s.Relation, rel); err != nil {
			return nil, err
		}
	}
	out := []any{}
	for _, parent := range parents {
		own, err := tableCells(parent, names)
		if err != nil {
			return nil, err
		}
		if rel == nil {
			out = append(out, own)
			continue
		}
		children, err := relatedTableRows(parent, rel)
		if err != nil {
			return nil, err
		}
		for _, child := range children {
			cells, err := tableCells(child, rel.Columns)
			if err != nil {
				return nil, err
			}
			out = append(out, append(append([]any{}, own...), cells...))
		}
	}
	return out, nil
}

// tableRelation is the relation of a model.query whose rows expect reads its child columns.
type tableRelation struct {
	Model   string   `json:"model"`
	Many    bool     `json:"many"`
	Columns []string `json:"columns"`
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
		case int32:
			out[i] = map[string]any{"int": strconv.FormatInt(int64(x), 10)}
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
	table := snakeOf(rel.Model)
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

// chainPlanPage is the page and the size that a plan step passes to GetPagePlanSteps as they are, refused values included.
type chainPlanPage struct {
	Page    int `json:"page"`
	PerPage int `json:"per_page"`
}

// chainPlanSteps is the role and the tables of each step, with how many times its upper-cased statement holds each text of
// plan_count, and its statement when withSQL is set.
func chainPlanSteps(steps []orm.QueryPlanStep, texts []string, withSQL bool) []any {
	out := make([]any, len(steps))
	for i, step := range steps {
		sql := strings.ToUpper(step.SQL)
		count := map[string]any{}
		for _, text := range texts {
			count[text] = strings.Count(sql, text)
		}
		shown := map[string]any{"role": step.Role, "tables": step.Tables, "count": count}
		if withSQL {
			shown["sql"] = step.SQL
		}
		out[i] = shown
	}
	return out
}

// chainPage runs GetsPage: the keys and the counts of the page, and the rows and total of a rows expect.
func chainPage(s chainStep, core *orm.Core, number, count int, c *databaseContext) (outcome, error) {
	if count <= 0 && s.PlanPage == nil {
		return outcome{}, fmt.Errorf("a page needs a limit count above 0")
	}
	page, err := orm.GetsPage[*tableRow](core, number, count)
	if err != nil {
		return outcome{}, err
	}
	keys := []any{}
	for _, key := range page.Items.Keys() {
		value, err := key.Value()
		if err != nil {
			return outcome{}, err
		}
		keys = append(keys, value)
	}
	fields := map[string]any{"keys": keys, "total": page.TotalCount, "pages": page.TotalPages, "page": page.Page, "per_page": page.PerPage}
	if s.Items {
		items, err := chainRows(page.Items.Slice(), s.Pick)
		if err != nil {
			return outcome{}, err
		}
		fields["items"] = items
	}
	out := jsonOutcome(fields)
	out.fields["total"] = page.TotalCount
	if wantsRows(s, c) {
		cells, err := chainCells(page.Items.Slice(), s)
		if err != nil {
			return outcome{}, err
		}
		out.fields["rows"] = cells
	}
	return out, nil
}

// chainAssign sets the members of an object of values on core, in the written order. A null wrapper is SetNull; an
// arith entry is Plus or Minus.
func chainAssign(core *orm.Core, raw json.RawMessage, c *databaseContext) error {
	if len(raw) == 0 {
		return nil
	}
	members, err := orderedMembers(raw)
	if err != nil {
		return err
	}
	for _, member := range members {
		var arith struct {
			Arith *struct {
				Operation string          `json:"operation"`
				Amount    json.RawMessage `json:"amount"`
			} `json:"arith"`
		}
		if err := json.Unmarshal(member.value, &arith); err == nil && arith.Arith != nil {
			amount, err := chainValue(arith.Arith.Amount, c)
			if err != nil {
				return err
			}
			if arith.Arith.Operation == "minus" {
				core.Minus(member.key, amount)
			} else {
				core.Plus(member.key, amount)
			}
			continue
		}
		value, err := columnValue(core, member.key, member.value, c)
		if err != nil {
			return err
		}
		if value == orm.Null {
			core.SetNull(member.key)
			continue
		}
		core.Set(member.key, value)
	}
	return nil
}

// chainWrite runs model.create, model.save, model.duplicate_create and model.restore: a model set from values, then its
// terminal. The written model is bound with as, and its toArray is the result.
func chainWrite(s chainStep, db *orm.DB, c *databaseContext) (outcome, error) {
	core := chainCore(s.Model, c)
	if !s.Unconnected {
		core.Connect(db)
	}
	if err := chainAssign(core, s.Values, c); err != nil {
		return outcome{}, err
	}
	if len(s.Attached) > 0 {
		members, err := orderedMembers(s.Attached)
		if err != nil {
			return outcome{}, err
		}
		for _, member := range members {
			value, err := chainValue(member.value, c)
			if err != nil {
				return outcome{}, err
			}
			core.New(member.key, value)
		}
	}
	if len(s.Duplication) > 0 {
		duplicate := chainCore(s.Model, c)
		if err := chainAssign(duplicate, s.Duplication, c); err != nil {
			return outcome{}, err
		}
		core.Duplication(duplicate.Self())
	}
	var m orm.Model
	var err error
	switch {
	case s.Op == "model.save":
		m, err = core.Save()
	case s.Op == "model.restore":
		m, err = core.Restore()
	case s.RestoreOrCreate:
		m, err = core.RestoreOrCreate()
	default:
		m, err = core.Create()
	}
	if err != nil {
		return outcome{}, err
	}
	row, ok := m.(*tableRow)
	if !ok {
		return outcome{}, fmt.Errorf("%s returned a %T", s.Op, m)
	}
	value, err := chainRow(row, s.Pick)
	if err != nil {
		return outcome{}, err
	}
	out := jsonOutcome(value)
	out.api = row
	// With columns, the rows expect compares the row that the write returns (INT-38).
	if len(s.Columns) > 0 {
		cells, err := chainCells([]*tableRow{row}, s)
		if err != nil {
			return outcome{}, err
		}
		out.fields["rows"] = cells
	}
	return out, nil
}

// chainCreates runs model.creates on the rows of rows or rows_sequence.
func chainCreates(s chainStep, db *orm.DB, c *databaseContext) (outcome, error) {
	models := []orm.Model{}
	if s.RowsSequence != nil {
		for i := 0; i < s.RowsSequence.Count; i++ {
			row := chainCore(s.Model, c)
			row.Set(s.RowsSequence.Column, s.RowsSequence.From+int64(i))
			if err := chainAssign(row, s.RowsSequence.Values, c); err != nil {
				return outcome{}, err
			}
			models = append(models, row.Self())
		}
	} else {
		var rows []json.RawMessage
		if err := json.Unmarshal(s.Rows, &rows); err != nil {
			return outcome{}, err
		}
		for _, raw := range rows {
			row := chainCore(s.Model, c)
			if err := chainAssign(row, raw, c); err != nil {
				return outcome{}, err
			}
			models = append(models, row.Self())
		}
	}
	batch := s.Batch
	if s.RowsSequence != nil && batch == 0 {
		batch = len(models)
	}
	core := chainCore(s.Model, c)
	core.Connect(db)
	n, err := orm.Creates(core, models, batch)
	if err != nil {
		return outcome{}, err
	}
	return countOutcome(n), nil
}

// countOutcome is the outcome of a count: an expect names it as {"value": {"int": ...}} or {"json": n}.
func countOutcome(n int64) outcome {
	out := jsonOutcome(n)
	out.fields["value"] = map[string]any{"int": strconv.FormatInt(n, 10)}
	return out
}

// chainTarget is the model that an update or a delete writes through: the bound row, or a new model set from values, which
// writes with no read.
func chainTarget(s chainStep, db *orm.DB, c *databaseContext) (*orm.Core, error) {
	if len(s.Row) > 0 {
		name := refName(s.Row)
		b, ok := c.bound[name]
		if !ok {
			return nil, fmt.Errorf("%s names row %q, which no bound row holds", s.Op, name)
		}
		row, ok := b.api.(*tableRow)
		if !ok {
			return nil, fmt.Errorf("%s: row %q is a %T", s.Op, name, b.api)
		}
		return row.m, nil
	}
	core := chainCore(s.Model, c)
	core.Connect(db)
	// The key form sets the key on a new model, with no read before it, so a key that names no row matches none (FCV-4).
	if len(s.Key) > 0 {
		return core, chainAssign(core, s.Key, c)
	}
	return core, chainAssign(core, s.Values, c)
}

// chainRevisionOf reads the guard of a write.
func chainRevisionOf(core *orm.Core, r *chainRevision, c *databaseContext) error {
	if r == nil {
		return nil
	}
	value, err := assignmentValue(r.Value, c)
	if err != nil {
		return err
	}
	n, err := int64Of(value, r.Column)
	if err != nil {
		return err
	}
	core.ExpectRevision(r.Column, n)
	return nil
}

// chainUpdate runs model.update on its target.
func chainUpdate(s chainStep, db *orm.DB, c *databaseContext) (outcome, error) {
	core, err := chainTarget(s, db, c)
	if err != nil {
		return outcome{}, err
	}
	if err := chainAssign(core, s.Set, c); err != nil {
		return outcome{}, err
	}
	if err := chainRevisionOf(core, s.Revision, c); err != nil {
		return outcome{}, err
	}
	var optimistic []bool
	if s.Optimistic {
		optimistic = []bool{true}
	}
	if err := core.Update(optimistic); err != nil {
		return outcome{}, err
	}
	return chainAffected(db), nil
}

// chainDelete runs model.delete on a bound row, a bound collection, or a new model set from values.
func chainDelete(s chainStep, db *orm.DB, c *databaseContext) (outcome, error) {
	if len(s.Row) > 0 {
		if collection, ok := c.bound[refName(s.Row)].api.(*orm.Collection[*tableRow]); ok {
			return outcome{fields: map[string]any{}}, collection.Delete(s.Recursive)
		}
	}
	if len(s.Where) > 0 {
		// A delete by where loads the rows and deletes each one (FCV-4).
		core, err := chainBuilt(s, db, c)
		if err != nil {
			return outcome{}, err
		}
		rows, err := orm.Gets[*tableRow](core)
		if err != nil {
			return outcome{}, err
		}
		for _, row := range rows.Slice() {
			if err := row.m.Delete(nil); err != nil {
				return outcome{}, err
			}
		}
		return okOutcome(), nil
	}
	core, err := chainTarget(s, db, c)
	if err != nil {
		return outcome{}, err
	}
	if err := chainRevisionOf(core, s.Revision, c); err != nil {
		return outcome{}, err
	}
	var recursive []bool
	if s.Recursive {
		recursive = []bool{true}
	}
	if err := core.Delete(recursive); err != nil {
		return outcome{}, err
	}
	return chainAffected(db), nil
}

// chainAffected is the outcome of a write: the rows that it matched, on the connection that its step names (F15).
func chainAffected(db *orm.DB) outcome {
	if db == nil {
		return outcome{fields: map[string]any{}}
	}
	return outcome{fields: affectedFields(db)}
}

// boolOutcome is the value of an op that returns a boolean (FCV-4).
func boolOutcome(value bool) outcome {
	return outcome{fields: map[string]any{"value": map[string]any{"bool": value}}}
}

// utilsOp runs the utils ops on the connection of s (INT-50 to INT-53, INT-134).
func utilsOp(s databaseStep, c *databaseContext) (outcome, error) {
	db, err := connectionOf(s, c)
	if err != nil {
		return outcome{}, err
	}
	switch s.Op {
	case "utils.lock":
		return outcome{fields: map[string]any{}}, db.Utils().Lock(s.Name)
	case "utils.set_local":
		value, err := assignmentValue(s.Value, c)
		if err != nil {
			return outcome{}, err
		}
		text, err := stringOf(value, s.Name)
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{}}, db.Utils().SetLocal(s.Name, text)
	case "utils.was_inserted":
		inserted, err := db.Utils().WasInserted(s.Table, s.Sequence)
		if err != nil {
			return outcome{}, err
		}
		return boolOutcome(inserted), nil
	case "utils.backend_waiting_for_lock":
		waiting, err := db.Utils().BackendWaitingForLock(c.ctx)
		if err != nil {
			return outcome{}, err
		}
		return boolOutcome(waiting), nil
	case "utils.stats":
		// The pool counts of the connection (INT-79).
		stats := db.Utils().Stats()
		return jsonOutcome(map[string]any{"max_open_connections": stats.MaxOpenConnections, "open_connections": stats.OpenConnections, "in_use": stats.InUse, "idle": stats.Idle}), nil
	case "utils.groups":
		// The names of the groups that the value of utils() holds (INT-134), each read through its own call.
		utils := db.Utils()
		names := []any{}
		for _, group := range []struct {
			name string
			held bool
		}{
			{"aes", utils.Aes() != nil},
			{"privileges", utils.Privileges() != nil},
			{"schema", utils.Schema() != nil},
			{"stats", utils.Stats() != orm.DBStats{}},
		} {
			if group.held {
				names = append(names, map[string]any{"text": group.name})
			}
		}
		return outcome{fields: map[string]any{"value": map[string]any{"array": names}}}, nil
	}
	value, err := db.Utils().Local(s.Name)
	if err != nil {
		return outcome{}, err
	}
	return jsonOutcome(value), nil
}

// applyMasks replaces the masked binds of the captured events (FCV-4 events.captured).
func applyMasks(events []any, masks map[string][]eventMask, database string) error {
	for _, mask := range masks[database] {
		if mask.Event >= len(events) {
			return fmt.Errorf("mask of event %d: %d events", mask.Event, len(events))
		}
		object, ok := events[mask.Event].(map[string]any)["object"].([]any)
		if !ok {
			return fmt.Errorf("event %d is not an object", mask.Event)
		}
		binds, ok := object[1].([]any)[1].(map[string]any)["array"].([]any)
		if !ok || mask.Bind >= len(binds) {
			return fmt.Errorf("mask of bind %d of event %d", mask.Bind, mask.Event)
		}
		binds[mask.Bind] = map[string]any{"text": mask.Value}
	}
	return nil
}

// styledCodecs are the codec stages whose column reads as a styled value, as the generator declares it.
var styledCodecs = map[string]bool{"ordered_json": true, "serialize": true, "gz": true, "base64": true, "json": true, "jsons": true}

// tableValue converts a read value of a column as the assign of a generated model does, from the type of the field in the
// runtime model of the fixture. A name that is no field of the table, such as an added column, keeps its value.
func tableValue(s *orm.Schema, table string, row *tableRow, name string, v any) (any, error) {
	model, err := s.Model()
	if err != nil {
		return nil, err
	}
	entity := model.Entities[table]
	if entity == nil {
		return v, nil
	}
	field := entity.Field(name)
	if field == nil {
		return v, nil
	}
	if v == nil {
		return nil, nil
	}
	for _, stage := range field.Codec {
		if styledCodecs[stage] {
			return orm.AsStyledValue(v, field.Null)
		}
	}
	switch field.Type {
	case "i16":
		// A value past the range reaches the write, whose slot check refuses it (CODEC_ENCODE).
		if n, err := orm.AsInt64(v); err == nil && (n < math.MinInt16 || n > math.MaxInt16) {
			return v, nil
		}
		return orm.AsInt16(v)
	case "i32":
		return orm.AsInt32(v)
	case "i64":
		return orm.AsInt64(v)
	case "bool":
		return orm.AsBool(v)
	case "decimal":
		return row.m.DecodeDecimal(v, field.Precision, field.Scale)
	case "f64":
		return orm.AsFloat64(v)
	case "date", "datetime":
		// A temporal cell is the text of the value model (PRT-69), as the other runtimes read it.
		t, err := orm.AsTime(v)
		if err != nil {
			return nil, err
		}
		if field.Type == "date" {
			return t.Format(time.DateOnly), nil
		}
		return t.Format("2006-01-02 15:04:05.000000"), nil
	case "time":
		return orm.AsTimeText(v, 6)
	case "bytes":
		if len(field.Codec) == 0 {
			return orm.AsBytes(v)
		}
	}
	return orm.AsString(v)
}
