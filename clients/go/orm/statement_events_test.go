package orm_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// tests/events/vectors.json의 case를 이 client로 실행해 statement event를 비교한다.
// ORM_EVENTS_RECORD=1이면 비교 대신 이 driver의 기대 event를 vector에 기록한다.

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

// errCallback은 실패하는 transaction callback의 오류다.
var errCallback = errors.New("callback failed")

// eventRun은 case 하나를 실행하는 상태다.
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

// step은 step 하나를 실행하고 그 오류를 돌려준다.
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
				if err := r.checked(inner); err != nil {
					return err
				}
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
		r.stopFail = r.db.Subscribe(func(e orm.StatementEvent) error {
			if e.Kind == kind {
				return errors.New("subscriber refused the event")
			}
			return nil
		})
		return nil
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

// checked는 step을 실행하고 그 오류가 step이 기대한 것인지 확인한다. 기대한
// 오류는 삼키지 않고 돌려주어 바깥 transaction의 callback이 받게 한다. transaction
// step이 기대한 callback 오류는 바깥 callback에서 처리된 것으로 본다.
func (r *eventRun) checked(s eventStep) error {
	err := r.step(s)
	switch {
	case s.Error == "" && err != nil:
		r.t.Fatalf("step %s: %v", s.Op, err)
	case s.Error == "callback":
		if !errors.Is(err, errCallback) {
			r.t.Fatalf("step %s = %v, want the callback error", s.Op, err)
		}
		return nil
	case s.Error != "" && orm.ErrorCode(err) != s.Error:
		r.t.Fatalf("step %s = %v, want %s", s.Op, err, s.Error)
	}
	return nil
}

// runEventCases는 vector의 모든 case를 driver에서 실행한다. subtests이면 case마다
// subtest로 실행하고, 아니면(coverage는 test 하나의 결과만 받는다) 차례로 실행한다.
func runEventCases(t *testing.T, driver string, subtests bool) {
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
	recording := os.Getenv("ORM_EVENTS_RECORD") == "1"
	recorded := map[string][]eventRecord{}
	for _, c := range doc.Cases {
		runOne := func(t *testing.T) {
			s := fixtureSchema(t, "statement_events")
			dsn := newDatabase(t, driver)
			db, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if c.Install == nil || *c.Install {
				if err := db.Utils().Schema().Install(s); err != nil {
					t.Fatal(err)
				}
			}
			r := &eventRun{t: t, db: db, schema: s, ent: rowEntity("event_probe", s, "seq", "label"), numbers: map[int64]int64{}}
			r.stopRec = db.Subscribe(r.record)
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

// normalized는 JSON으로 다시 읽은 record다. bind의 숫자와 빈 목록이 같은 형태가 된다.
func normalized(records []eventRecord) any {
	raw, _ := json.Marshal(records)
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

// recordEvents는 vector의 각 case에 driver의 기대 event를 쓴다.
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

// serverTransactions는 vector의 server_transactions다.
type serverTransactions struct {
	Database        string   `json:"database"`
	FirstRunClients []string `json:"first_run_clients"`
	Page            string   `json:"page"`
	Probe           string   `json:"probe"`
	TimeZone        struct {
		Setting string `json:"setting"`
		Source  string `json:"source"`
	} `json:"time_zone"`
}

// TestStatementEventsServerTransactions는 vector의 server_transactions를 PostgreSQL case
// database에서 실행한다. probe가 돌려주는 backend의 local transaction 번호 차이로 page 실행 한
// 번의 server transaction을 센다. pool size 1이므로 모든 statement가 한 backend에서 실행된다.
// go가 first_run_clients에 없으면 첫 실행은 보고만 한다.
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
	compareFirst := slices.Contains(spec.FirstRunClients, "go")
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
	defer db.Close()
	var setting, source string
	if err := orm.ReadForTest(db, "SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'", &setting, &source); err != nil {
		t.Fatal(err)
	}
	if setting != spec.TimeZone.Setting || source != spec.TimeZone.Source {
		t.Errorf("TimeZone setting and source = %s, %s, want %s, %s", setting, source, spec.TimeZone.Setting, spec.TimeZone.Source)
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
	r.stopRec = db.Subscribe(r.record)
	before := probe()
	for _, name := range []string{"first", "second"} {
		r.records = nil
		for _, st := range page.Steps {
			r.checked(st)
		}
		events := int64(0)
		for _, rec := range r.records {
			if rec.SQL != spec.Probe {
				events++
			}
		}
		after := probe()
		transactions := after - before - cost
		before = after
		t.Logf("server_transactions %s run: %d events, %d transactions", name, events, transactions)
		if (name == "second" || compareFirst) && transactions != events {
			t.Errorf("%s run spent %d server transactions for %d statement events, want one per event", name, transactions, events)
		}
	}
}
