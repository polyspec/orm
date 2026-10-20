package orm_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Runs the cases of tests/events/vectors.json with this client and compares the statement events.
// If ORM_EVENTS_RECORD=1, it records this driver's expected events into the vector instead of comparing.

const eventsVector = "../../../tests/events/vectors.json"

type eventStep struct {
	Op     string      `json:"op"`
	Label  string      `json:"label,omitempty"`
	To     string      `json:"to,omitempty"`
	Result *int64      `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
	Fail   bool        `json:"fail,omitempty"`
	Kind   string      `json:"kind,omitempty"`
	Steps  []eventStep `json:"steps,omitempty"`
}

type eventRecord struct {
	SQL         string   `json:"sql"`
	Binds       []any    `json:"binds"`
	Kind        string   `json:"kind"`
	Tables      []string `json:"tables"`
	Transaction *int64   `json:"transaction"`
	Error       *string  `json:"error"`
}

type eventCase struct {
	ID      string                   `json:"id"`
	Install *bool                    `json:"install,omitempty"`
	Compare string                   `json:"compare,omitempty"`
	Steps   []eventStep              `json:"steps"`
	Events  map[string][]eventRecord `json:"events"`
}

// errCallback is the error of a transaction callback that fails.
var errCallback = errors.New("callback failed")

// eventRun is the state of running one case.
type eventRun struct {
	t        *testing.T
	db       *orm.DB
	schema   *orm.Schema
	ent      *orm.Entity
	records  []eventRecord
	numbers  map[int64]int64
	stopRec  func()
	stopFail func()
}

func (r *eventRun) record(e orm.StatementEvent) error {
	if e.Elapsed < 0 {
		r.t.Errorf("event %q has a negative elapsed time %v", e.SQL, e.Elapsed)
	}
	raw, err := json.Marshal(e.Binds)
	if err != nil {
		return err
	}
	var binds []any
	if err := json.Unmarshal(raw, &binds); err != nil {
		return err
	}
	rec := eventRecord{SQL: e.SQL, Binds: binds, Kind: e.Kind, Tables: e.Tables}
	if e.Transaction != 0 {
		n, ok := r.numbers[e.Transaction]
		if !ok {
			n = int64(len(r.numbers) + 1)
			r.numbers[e.Transaction] = n
		}
		rec.Transaction = &n
	}
	if e.Err != nil {
		code := orm.ErrorCode(e.Err)
		rec.Error = &code
	}
	r.records = append(r.records, rec)
	return nil
}

func (r *eventRun) model() *orm.Core {
	c := orm.NewCore(r.ent)
	r.ent.New(c)
	c.Connect(r.db)
	return c
}

func (r *eventRun) byLabel(label string) *orm.Core {
	c := r.model()
	c.Where("", []orm.ChainKey{{Column: "label"}}, label)
	return c
}

// step runs one step and returns its error.
func (r *eventRun) step(s eventStep) error {
	switch s.Op {
	case "create":
		c := r.model()
		c.Set("label", s.Label)
		_, err := c.Create()
		return err
	case "get":
		_, err := r.byLabel(s.Label).Get()
		return err
	case "count":
		n, err := r.model().GetCount()
		if err == nil && s.Result != nil && n != *s.Result {
			r.t.Errorf("count = %d, want %d", n, *s.Result)
		}
		return err
	case "update":
		m, err := r.byLabel(s.Label).Get()
		if err != nil {
			return err
		}
		m.Orm_().Set("label", s.To)
		return m.Orm_().Update(nil)
	case "delete":
		m, err := r.byLabel(s.Label).Get()
		if err != nil {
			return err
		}
		return m.Orm_().Delete(nil)
	case "transaction":
		return r.db.Transaction(func() error {
			for _, inner := range s.Steps {
				r.checked(inner)
			}
			if s.Fail {
				return errCallback
			}
			return nil
		}, orm.Retry(0))
	case "install":
		return r.db.Utils().Schema().Install(r.schema)
	case "fail_subscriber":
		kind := s.Kind
		var err error
		r.stopFail, err = r.db.Subscribe(func(e orm.StatementEvent) error {
			if e.Kind == kind {
				return errors.New("subscriber refused the event")
			}
			return nil
		})
		return err
	case "stop_failing":
		r.stopFail()
		return nil
	case "unsubscribe":
		r.stopRec()
		return nil
	}
	r.t.Fatalf("unknown step %q", s.Op)
	return nil
}

// checked runs the step and checks whether its error is the one the step expected; another error ends the case.
// An error that the step expected is handled here, so the outer transaction's callback goes on with its next
// step, and a transaction callback error that the step expected is handled by the outer callback.
func (r *eventRun) checked(s eventStep) {
	err := r.step(s)
	switch {
	case s.Error == "" && err != nil:
		r.t.Fatalf("step %s: %v", s.Op, err)
	case s.Error == "callback":
		if !errors.Is(err, errCallback) {
			r.t.Fatalf("step %s = %v, want the callback error", s.Op, err)
		}
	case s.Error != "" && orm.ErrorCode(err) != s.Error:
		r.t.Fatalf("step %s = %v, want %s", s.Op, err, s.Error)
	}
}

// runEventCases runs every case of the vector on the driver. If subtests are used, it runs each case
// as a subtest; otherwise (coverage receives the result of only one test) it runs them in order.
func runEventCases(t *testing.T, driver string, subtests bool) {
	cases := eventCases(t)
	recording := os.Getenv("ORM_EVENTS_RECORD") == "1"
	recorded := map[string][]eventRecord{}
	for _, c := range cases {
		runOne := func(t *testing.T) { runEventCase(t, driver, c, recording, recorded) }
		if subtests {
			t.Run(c.ID, runOne)
		} else {
			runOne(t)
		}
	}
	if recording {
		recordEvents(t, driver, recorded)
	}
}

// eventCases reads the cases of tests/events/vectors.json in file order.
func eventCases(t *testing.T) []eventCase {
	t.Helper()
	raw, err := os.ReadFile(eventsVector)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []eventCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Cases
}

// TestStatementEvents runs every case of tests/events/vectors.json as a subtest named by its id,
// and each case on MySQL, PostgreSQL and SQLite in a new case database of each, so the parity
// check runs the suite under its case ids. It never records; the per-driver tests do.
func TestStatementEvents(t *testing.T) {
	testcase.Start(t, testcase.Database)
	for _, c := range eventCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			for _, driver := range []string{"mysql", "postgres", "sqlite"} {
				t.Logf("driver %s", driver)
				runEventCase(t, driver, c, false, nil)
			}
		})
	}
}

// runEventCase runs case c on driver in a new case database and compares its events with the
// vector, or keeps them in recorded when recording.
func runEventCase(t *testing.T, driver string, c eventCase, recording bool, recorded map[string][]eventRecord) {
	t.Helper()
	s := fixtureSchema(t, "statement_events")
	dsn := newDatabase(t, driver)
	db, err := orm.ConnectSchema(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	if c.Install == nil || *c.Install {
		if err := db.Utils().Schema().Install(s); err != nil {
			t.Fatal(err)
		}
	}
	r := &eventRun{t: t, db: db, schema: s, ent: rowEntity("event_probe", s, "seq", "label"), numbers: map[int64]int64{}}
	if r.stopRec, err = db.Subscribe(r.record); err != nil {
		t.Fatal(err)
	}
	for _, s := range c.Steps {
		r.checked(s)
	}
	got := r.records
	if c.Compare == "tables" {
		got = nil
		for _, rec := range r.records {
			if len(rec.Tables) > 0 {
				got = append(got, rec)
			}
		}
	}
	if got == nil {
		got = []eventRecord{}
	}
	if recording {
		recorded[c.ID] = got
		return
	}
	if want := c.Events[driver]; !reflect.DeepEqual(normalized(got), normalized(want)) {
		gotJSON, _ := json.MarshalIndent(got, "", "  ")
		wantJSON, _ := json.MarshalIndent(want, "", "  ")
		t.Fatalf("%s events\n got %s\nwant %s", driver, gotJSON, wantJSON)
	}
}

// normalized is the record read back as JSON. Numbers and empty lists in bind take the same form.
func normalized(records []eventRecord) any {
	raw, _ := json.Marshal(records)
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

// recordEvents writes the driver's expected events into each case of the vector.
func recordEvents(t *testing.T, driver string, recorded map[string][]eventRecord) {
	raw, err := os.ReadFile(eventsVector)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, c := range doc["cases"].([]any) {
		cm := c.(map[string]any)
		if events, ok := recorded[cm["id"].(string)]; ok {
			cm["events"].(map[string]any)[driver] = events
		}
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Clean(eventsVector), append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestStatementEventsMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runEventCases(t, "mysql", true)
}

func TestStatementEventsPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runEventCases(t, "postgres", true)
}

func TestStatementEventsSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	runEventCases(t, "sqlite", true)
}

// serverTransactions is the server_transactions of the vector.
type serverTransactions struct {
	Database               string   `json:"database"`
	FirstRunClients        []string `json:"first_run_clients"`
	FirstRunPrepareClients []string `json:"first_run_prepare_clients"`
	Page                   string   `json:"page"`
	Probe                  string   `json:"probe"`
	TimeZone               struct {
		Setting string `json:"setting"`
		Source  string `json:"source"`
	} `json:"time_zone"`
}

// TestStatementEventsServerTransactions runs the vector's server_transactions on the PostgreSQL case
// database. From the difference in the backend's local transaction numbers that the probe returns, it counts the
// server transactions of the page run. The pool size is 1, so every statement runs on one backend.
// The pgx statement cache prepares a statement text the first time a connection sends it, in its own round trip,
// so if go is in first_run_prepare_clients, the first run adds the number of statement texts to the event count.
func TestStatementEventsServerTransactions(t *testing.T) {
	testcase.Start(t, testcase.Database)
	raw, err := os.ReadFile(eventsVector)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases              []eventCase        `json:"cases"`
		ServerTransactions serverTransactions `json:"server_transactions"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	spec := doc.ServerTransactions
	var page *eventCase
	for i := range doc.Cases {
		if doc.Cases[i].ID == spec.Page {
			page = &doc.Cases[i]
		}
	}
	if page == nil {
		t.Fatalf("server_transactions page %q is no case", spec.Page)
	}
	onePerEvent, withPrepares := slices.Contains(spec.FirstRunClients, "go"), slices.Contains(spec.FirstRunPrepareClients, "go")
	if onePerEvent == withPrepares {
		t.Fatalf("go must be in exactly one of first_run_clients and first_run_prepare_clients")
	}
	s := fixtureSchema(t, "statement_events")
	dsn := newDatabase(t, spec.Database)
	setup, err := orm.ConnectSchema(dsn, s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := setup.Utils().Schema().Install(s); err != nil {
		t.Fatal(err)
	}
	if err := setup.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := orm.ConnectSchema(dsn, s, orm.Config{PoolSize: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	var setting, source string
	if err := orm.ReadForTest(db, "SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'", &setting, &source); err != nil {
		t.Fatal(err)
	}
	// Through a pooler, the pooler applies the startup parameters to the server connection with SET,
	// so the source does not name the client. The source is compared only when connecting directly to the server.
	pooled := os.Getenv("ORM_TEST_POSTGRES_DSN") != os.Getenv("ORM_TEST_POSTGRES_SERVER_DSN")
	if setting != spec.TimeZone.Setting || (!pooled && source != spec.TimeZone.Source) {
		t.Errorf("TimeZone setting and source = %s, %s, want %s, %s (pooled %v)", setting, source, spec.TimeZone.Setting, spec.TimeZone.Source, pooled)
	}
	probe := func() int64 {
		var n int64
		if err := orm.ReadForTest(db, spec.Probe, &n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	first := probe()
	cost := probe() - first
	r := &eventRun{t: t, db: db, schema: s, ent: rowEntity("event_probe", s, "seq", "label"), numbers: map[int64]int64{}}
	if r.stopRec, err = db.Subscribe(r.record); err != nil {
		t.Fatal(err)
	}
	before := probe()
	for _, name := range []string{"first", "second"} {
		r.records = nil
		for _, st := range page.Steps {
			r.checked(st)
		}
		events := int64(0)
		texts := map[string]bool{}
		for _, rec := range r.records {
			if rec.SQL != spec.Probe {
				events++
				texts[rec.SQL] = true
			}
		}
		after := probe()
		transactions := after - before - cost
		before = after
		t.Logf("server_transactions %s run: %d events, %d statement texts, %d transactions", name, events, len(texts), transactions)
		want := events
		if name == "first" && withPrepares {
			want += int64(len(texts))
		}
		if transactions != want {
			t.Errorf("%s run spent %d server transactions for %d statement events of %d statement texts, want %d", name, transactions, events, len(texts), want)
		}
	}
}
