package recipe

// The statement-event ops (FCV-4): the connections, models, schema installs, transactions and subscriptions of the
// statement_events recipe. Each op calls the exported API of the orm package, the entity and connection calls that
// the native statement-event test wraps in its own helpers.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"unicode/utf8"

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
			converted, err := tableValue(s, table, row, name, v)
			if err != nil {
				return true, fmt.Errorf("column %s: %w", name, err)
			}
			row.vals[name] = converted
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

// generatedFixture is the one recipe fixture that generates models (packages/go/models.txt). A model op of any other
// fixture names a table of that fixture, and chain.go runs it on the entity of the table (FCV-4); a model op of this fixture
// calls the generated methods of its model (model.go), which are other calls of the public API than those of the builder.
const generatedFixture = "contracts/fixtures/bench/dbspec-set.json"

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
	case "utils.run":
		result, err := runFrame(s, c)
		return result, true, err
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
		if err := applyMasks(events, s.Masks, c.database); err != nil {
			return outcome{}, true, err
		}
		return outcome{fields: map[string]any{"value": map[string]any{"array": events}}}, true, nil
	}
	return outcome{}, false, nil
}

// frameStatement is one statement of utils.run: the arguments of TxFrame.Run (INT-150).
type frameStatement struct {
	Kind   string            `json:"kind"`
	Tables []string          `json:"tables"`
	SQL    json.RawMessage   `json:"sql"`
	Params []json.RawMessage `json:"params"`
}

// runFrame calls Utils.Run on the connection of s with a function that runs the statements of s in order on its frame. Its
// value is the rows of the last statement, each cell in the recipe wrapper of its plain value (FCV-4).
func runFrame(s databaseStep, c *databaseContext) (outcome, error) {
	db, err := connectionOf(s, c)
	if err != nil {
		return outcome{}, err
	}
	var rows [][]any
	err = db.Utils().Run(func(frame *orm.TxFrame) error {
		for _, statement := range s.Statements {
			text, present, err := sqlExecText(statement.SQL, c)
			if err != nil {
				return err
			}
			if !present {
				return fmt.Errorf("utils.run names no statement for %s", c.database)
			}
			params := make([]any, 0, len(statement.Params))
			for _, raw := range statement.Params {
				param, err := argument(raw, nil)
				if err != nil {
					return err
				}
				params = append(params, param)
			}
			result, err := frame.Run(statement.Kind, statement.Tables, text, params...)
			if err != nil {
				return err
			}
			rows = result.Rows
		}
		return nil
	})
	if err != nil {
		return outcome{}, err
	}
	out := []any{}
	for _, row := range rows {
		cells := []any{}
		for _, cell := range row {
			wrapped, err := plain(cell, "", c.database)
			if err != nil {
				return outcome{}, err
			}
			cells = append(cells, wrapped)
		}
		out = append(out, map[string]any{"array": cells})
	}
	return outcome{fields: map[string]any{"value": map[string]any{"array": out}}}, nil
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
		if compare == "statements" {
			// The bound clock of a soft delete differs on each run, so the sql and the kind are compared.
			value = map[string]any{"object": []any{
				[]any{"sql", map[string]any{"text": e.SQL}},
				[]any{"kind", map[string]any{"text": e.Kind}},
			}}
		}
		out = append(out, value)
	}
	return out, nil
}

// bindValue is a bind in the one form of every runtime: a 32-bit integer is an integer and UTF-8 bytes are their text.
func bindValue(b any) any {
	switch x := b.(type) {
	case int:
		return int64(x)
	case int32:
		return int64(x)
	case []byte:
		if utf8.Valid(x) {
			return string(x)
		}
	}
	return b
}

// eventValue is the recipe object of one statement event: its sql, binds, kind, tables, transaction and error (FCV-4).
// The elapsed time is not part of it.
func eventValue(e orm.StatementEvent, numbers map[int64]int64, c *databaseContext) (any, error) {
	binds := []any{}
	for _, b := range e.Binds {
		w, err := plain(bindValue(b), "", c.database)
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
