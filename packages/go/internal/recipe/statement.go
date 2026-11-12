package recipe

// The statement-event ops (FCV-4): the connections, models, schema installs, transactions and subscriptions of the
// statement_events recipe. Each op calls the exported API of the orm package, the entity and connection calls that
// the native statement-event test wraps in its own helpers.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/polyspec/orm/packages/go/engine/ir"
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
	switch s.k("op").Op {
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
		kind := s.k("kind").Kind
		refusal := errors.New("subscriber refused the event")
		if refused := s.k("refusal").Refusal; refused != nil {
			refusal = &ir.Error{Code: refused.Code, Msg: refused.Message}
		}
		stop, err := db.Subscribe(func(e orm.StatementEvent) error {
			if e.Kind == kind {
				return refusal
			}
			return nil
		})
		if err != nil {
			return outcome{}, true, err
		}
		return outcome{api: &subscription{stop: stop}, fields: map[string]any{}}, true, nil
	case "db.execute":
		return outcome{fields: map[string]any{}}, true, executeRequest(s, c)
	case "fault.next_rollback":
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, true, err
		}
		return outcome{fields: map[string]any{}}, true, failNextRollback(db)
	case "fault.next_statement":
		db, err := connectionOf(s, c)
		if err != nil {
			return outcome{}, true, err
		}
		return outcome{fields: map[string]any{}}, true, failNextStatement(db, s.k("code").Code, s.k("message").Message)
	case "events.stop_failing", "events.unsubscribe":
		sub, err := boundAPI[*subscription](s.k("ref").Ref, c)
		if err != nil {
			return outcome{}, true, err
		}
		sub.stop()
		return outcome{fields: map[string]any{}}, true, nil
	case "utils.run":
		result, err := runFrame(s, c)
		return result, true, err
	case "events.captured":
		sub, err := boundAPI[*subscription](s.k("ref").Ref, c)
		if err != nil {
			return outcome{}, true, err
		}
		if sub.rec == nil {
			return outcome{}, true, fmt.Errorf("the subscription of ref is not a recording subscriber")
		}
		if sub.rec.negative {
			return outcome{}, true, fmt.Errorf("an event has a negative elapsed time")
		}
		events, err := capturedEvents(sub.rec.events, s.k("compare").Compare, c)
		if err != nil {
			return outcome{}, true, err
		}
		if err := applyMasks(events, s.k("masks").Masks, dialectKey(c.database, s.k("masks").Masks)); err != nil {
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
		for _, statement := range s.k("statements").Statements {
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
		if hold := s.k("hold_ms").HoldMs; hold > 0 {
			time.Sleep(time.Duration(hold) * time.Millisecond)
		}
		if s.k("conflict").Conflict != "" {
			return orm.TransactionConflict(s.k("conflict").Conflict)
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
			wrapped, err := plain(cell, "", c.dialect())
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
		if compare == "shape" {
			// The binds of a statement of the clock and the text of each dialect are not part of the shape of the plan.
			tables := make([]any, len(e.Tables))
			for i, name := range e.Tables {
				tables[i] = map[string]any{"text": name}
			}
			value = map[string]any{"object": []any{
				[]any{"kind", map[string]any{"text": e.Kind}},
				[]any{"tables", map[string]any{"array": tables}},
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
		w, err := plain(bindValue(b), "", c.dialect())
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

// serverTransactions runs the nested steps twice on the connection and reads the server transactions of each run by the
// difference of the probe (INT-149). The probe runs in a frame of its own, so its cost is measured first. The excess of a
// run is what it spent beyond one per event, and the first run of a client that prepares each text in a round trip of its
// own may spend one more for each text.
func serverTransactions(s databaseStep, c *databaseContext) (outcome, error) {
	db, err := connectionOf(s, c)
	if err != nil {
		return outcome{}, err
	}
	frameRows := func(text string) ([][]any, error) {
		var rows [][]any
		err := db.Utils().Run(func(frame *orm.TxFrame) error {
			result, err := frame.Run("utility", []string{}, text)
			if err != nil {
				return err
			}
			rows = result.Rows
			return nil
		})
		return rows, err
	}
	probe := func() (int64, error) {
		rows, err := frameRows(s.k("probe").Probe)
		if err != nil {
			return 0, err
		}
		if len(rows) != 1 || len(rows[0]) != 1 {
			return 0, fmt.Errorf("the probe returned %d rows, want one cell", len(rows))
		}
		return strconv.ParseInt(fmt.Sprint(cellText(rows[0][0])), 10, 64)
	}
	fields := map[string]any{}
	if c.database == "postgres" {
		rows, err := frameRows("SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'")
		if err != nil {
			return outcome{}, err
		}
		// Through a pooler the pooler applies the startup parameters with SET, so the source says nothing about the client.
		pooled := os.Getenv("ORM_TEST_POSTGRES_DSN") != os.Getenv("ORM_TEST_POSTGRES_SERVER_DSN")
		fields["time_zone"] = fmt.Sprint(cellText(rows[0][0]))
		fields["time_zone_from_startup"] = pooled || fmt.Sprint(cellText(rows[0][1])) == "client"
	}
	first, err := probe()
	if err != nil {
		return outcome{}, err
	}
	second, err := probe()
	if err != nil {
		return outcome{}, err
	}
	cost := second - first
	prepares := slices.Contains(s.k("first_run_prepare_clients").FirstRunPrepareClients, "go")
	rec := &recording{}
	before := second
	for _, run := range []string{"first", "second"} {
		rec.events = nil
		stop, err := db.Subscribe(rec.receive)
		if err != nil {
			return outcome{}, err
		}
		err = runNested(s.k("steps").Steps, c)
		stop()
		if err != nil {
			return outcome{}, err
		}
		after, err := probe()
		if err != nil {
			return outcome{}, err
		}
		texts := map[string]bool{}
		for _, event := range rec.events {
			texts[event.SQL] = true
		}
		spent := after - before - cost
		before = after
		excess := spent - int64(len(rec.events))
		if run == "first" && prepares {
			excess -= int64(len(texts))
		}
		fields[run+"_excess"] = excess
		fields["events"] = int64(len(rec.events))
		fields["texts"] = int64(len(texts))
	}
	fields["probe_cost"] = cost
	return outcome{fields: fields}, nil
}

// cellText is a cell of a probe: the driver gives a bigint as a number or as its text bytes.
func cellText(cell any) any {
	if bytes, ok := cell.([]byte); ok {
		return string(bytes)
	}
	return cell
}
