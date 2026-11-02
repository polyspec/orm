package recipe

// The statement-event ops (FCV-4): the connections, models, schema installs, transactions and subscriptions of the
// statement_events recipe. Each op calls the exported API of the orm package, the entity and connection calls that
// the native statement-event test wraps in its own helpers.

import (
	"errors"
	"fmt"
	"strconv"

	"github.com/polyspec/orm/packages/go/orm"
)

// errCallback is the error that a transaction callback returns after its steps when its op has fail: true. The
// expect of such a step is {"error": "CALLBACK"} (FCV-4), and runDatabaseStep maps this error to that code.
var errCallback = errors.New("the transaction callback failed")

// callbackCode is the expect code of errCallback; it is not an orm error code.
const callbackCode = "CALLBACK"

// recording is the subscriber of a case that keeps every statement event it receives, in order.
type recording struct {
	events   []orm.StatementEvent
	negative bool // an event with a negative elapsed time
}

func (r *recording) receive(e orm.StatementEvent) error {
	if e.Elapsed < 0 {
		r.negative = true
	}
	r.events = append(r.events, e)
	return nil
}

// subscription is a bound subscription: its unsubscribe function, and the recording of a recording subscriber (nil for
// a subscriber that fails).
type subscription struct {
	stop func()
	rec  *recording
}

// tableRow is a row of a table of the recipe. Its entity takes every column the recipe names, since the fixture defines
// the table.
type tableRow struct {
	m    *orm.Core
	vals map[string]any
}

func (r *tableRow) Orm_() *orm.Core { return r.m }

// tableEntity is the entity of a table of the fixture: the public Entity that a generated model would supply.
func tableEntity(table string, s *orm.Schema) *orm.Entity {
	return &orm.Entity{
		Name:   table,
		Schema: s,
		New: func(c *orm.Core) orm.Model {
			r := &tableRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) (bool, error) {
			row, ok := m.(*tableRow)
			if !ok {
				return false, fmt.Errorf("model is a %T, not a table row", m)
			}
			row.vals[name] = v
			return true, nil
		},
		Value: func(m orm.Model, name string) (any, bool) {
			row, ok := m.(*tableRow)
			if !ok {
				return nil, false
			}
			v, ok := row.vals[name]
			return v, ok
		},
		Collect: func(keys []orm.Key, items map[orm.Key]*orm.Core, fetched map[orm.Key]any) any {
			return orm.CollectOf[*tableRow](keys, items, fetched)
		},
	}
}

// tableCore is the core of a new model of table, connected to db.
func tableCore(db *orm.DB, table string, s *orm.Schema) *orm.Core {
	ent := tableEntity(table, s)
	c := orm.NewCore(ent)
	ent.New(c)
	c.Connect(db)
	return c
}

// tableModels are the models of the fixtures that have no generated model: each names its table of the fixture schema. A
// model op on any other model name fails the case by name (model.go).
var tableModels = map[string]string{
	"EventProbe":  "event_probe",
	"HookItem":    "hook_item",
	"HookEntry":   "hook_entry",
	"HookUpsert":  "hook_upsert",
	"RotRow":      "rot_row",
	"ChunkAuthor": "chunk_author",
}

// boundRow records which path made a bound row, the generated or the table path, with its model and the connection it was
// made on. A model op of the {row} form (no model, no connection) runs on this path and connection (coordinator ruling).
type boundRow struct {
	path  string
	model string
	db    *orm.DB
}

// tableModelOp runs a model op on a table model of the fixture, through the entity of tableEntity.
func tableModelOp(s databaseStep, c *databaseContext, db *orm.DB, table string) (outcome, error) {
	if out, handled, err := tableModelRequest(s, c, db, table); handled {
		return out, err
	}
	core := tableCore(db, table, c.schema)
	switch s.Op {
	case "model.create":
		values, err := assignments(s.Values, c)
		if err != nil {
			return outcome{}, err
		}
		for _, a := range values {
			core.Set(a.Name, a.Value)
		}
		m, err := core.Create()
		if err != nil {
			return outcome{}, err
		}
		return outcome{api: m, fields: map[string]any{}, row: &boundRow{path: "table", model: s.Model, db: db}}, nil
	case "model.get_by":
		if s.Key != nil {
			return outcome{}, fmt.Errorf("model.get_by with key has no table-model path")
		}
		if err := filterWhere(core, s, c); err != nil {
			return outcome{}, err
		}
		m, err := core.Get()
		if err != nil {
			return outcome{}, err
		}
		return outcome{api: m, fields: map[string]any{}, row: &boundRow{path: "table", model: s.Model, db: db}}, nil
	case "model.update":
		row, err := boundAPI[orm.Model](s.Row, c)
		if err != nil {
			return outcome{}, err
		}
		values, err := assignments(s.Set, c)
		if err != nil {
			return outcome{}, err
		}
		for _, a := range values {
			row.Orm_().Set(a.Name, a.Value)
		}
		if err := row.Orm_().Update(nil); err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{}}, nil
	case "model.delete":
		row, err := boundAPI[orm.Model](s.Row, c)
		if err != nil {
			return outcome{}, err
		}
		if err := row.Orm_().Delete(nil); err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{}}, nil
	case "model.count":
		if s.Where != nil {
			if err := filterWhere(core, s, c); err != nil {
				return outcome{}, err
			}
		}
		n, err := core.GetCount()
		if err != nil {
			return outcome{}, err
		}
		return outcome{fields: map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}}, nil
	}
	return outcome{}, fmt.Errorf("model op %s has no table-model path", s.Op)
}

// filterWhere narrows core by the where of s.
func filterWhere(core *orm.Core, s databaseStep, c *databaseContext) error {
	where, err := assignments(s.Where, c)
	if err != nil {
		return err
	}
	return filterTable(core, where)
}

// filterTable narrows a table-model chain by the equalities of where, joined by and in column order.
func filterTable(core *orm.Core, where []orm.CatalogAssignment) error {
	keys := make([]orm.ChainKey, len(where))
	args := make([]any, len(where))
	for i, a := range where {
		keys[i] = orm.ChainKey{Column: a.Name}
		if i > 0 {
			keys[i].Conn = "and"
		}
		args[i] = a.Value
	}
	if len(keys) > 0 {
		core.Where("", keys, args...)
	}
	return nil
}

// statementOp runs the statement-event ops of FCV-4 (events.*). It reports whether s is one of them.
func statementOp(s databaseStep, c *databaseContext) (outcome, bool, error) {
	switch s.Op {
	case "events.subscribe":
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, true, err
		}
		rec := &recording{}
		stop, err := db.Subscribe(rec.receive)
		if err != nil {
			return outcome{}, true, err
		}
		return outcome{api: &subscription{stop: stop, rec: rec}, fields: map[string]any{}}, true, nil
	case "events.fail_subscriber":
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, true, err
		}
		kind := s.Kind
		stop, err := db.Subscribe(func(e orm.StatementEvent) error {
			if e.Kind == kind {
				return errors.New("subscriber refused the event")
			}
			return nil
		})
		if err != nil {
			return outcome{}, true, err
		}
		return outcome{api: &subscription{stop: stop}, fields: map[string]any{}}, true, nil
	case "events.stop_failing", "events.unsubscribe":
		sub, err := boundAPI[*subscription](s.Ref, c)
		if err != nil {
			return outcome{}, true, err
		}
		sub.stop()
		return outcome{fields: map[string]any{}}, true, nil
	case "events.captured":
		sub, err := boundAPI[*subscription](s.Ref, c)
		if err != nil {
			return outcome{}, true, err
		}
		if sub.rec == nil {
			return outcome{}, true, fmt.Errorf("the subscription of ref is not a recording subscriber")
		}
		if sub.rec.negative {
			return outcome{}, true, fmt.Errorf("an event has a negative elapsed time")
		}
		events, err := capturedEvents(sub.rec.events, s.Compare, c)
		if err != nil {
			return outcome{}, true, err
		}
		return outcome{fields: map[string]any{"value": map[string]any{"array": events}}}, true, nil
	}
	return outcome{}, false, nil
}

// capturedEvents is the recipe wrapper of the events of a recording. The transactions are numbered from 1 in the order of
// their first appearance among all the events; then compare "tables" keeps the events that name a table.
func capturedEvents(events []orm.StatementEvent, compare string, c *databaseContext) ([]any, error) {
	numbers := map[int64]int64{}
	out := []any{}
	for _, e := range events {
		value, err := eventValue(e, numbers, c)
		if err != nil {
			return nil, err
		}
		if compare == "tables" && len(e.Tables) == 0 {
			continue
		}
		out = append(out, value)
	}
	return out, nil
}

// eventValue is the recipe object of one statement event: its sql, binds, kind, tables, transaction and error (FCV-4).
// The elapsed time is not part of it.
func eventValue(e orm.StatementEvent, numbers map[int64]int64, c *databaseContext) (any, error) {
	binds := []any{}
	for _, b := range e.Binds {
		w, err := plain(b, "", c.database)
		if err != nil {
			return nil, err
		}
		binds = append(binds, w)
	}
	tables := []any{}
	for _, name := range e.Tables {
		tables = append(tables, map[string]any{"text": name})
	}
	var transaction any = map[string]any{"null": true}
	if e.Transaction != 0 {
		n, ok := numbers[e.Transaction]
		if !ok {
			n = int64(len(numbers) + 1)
			numbers[e.Transaction] = n
		}
		transaction = map[string]any{"int": strconv.FormatInt(n, 10)}
	}
	var failure any = map[string]any{"null": true}
	if e.Err != nil {
		failure = map[string]any{"text": orm.ErrorCode(e.Err)}
	}
	return map[string]any{"object": []any{
		[]any{"sql", map[string]any{"text": e.SQL}},
		[]any{"binds", map[string]any{"array": binds}},
		[]any{"kind", map[string]any{"text": e.Kind}},
		[]any{"tables", map[string]any{"array": tables}},
		[]any{"transaction", transaction},
		[]any{"error", failure},
	}}, nil
}
