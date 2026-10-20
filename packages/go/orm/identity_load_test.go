package orm_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Runs the shared cases of contracts/fixtures/identity_load.json with this client. Compile
// cases compile the request with the engine of each of the three dialects and compare the statement or error;
// an execute case installs the fixture in the case database, then compiles each step's request with that
// database's engine and runs it with DB.Execute, and at the end reads the rows of load_probe
// and compares them.

const identityLoadCases = "../../../contracts/fixtures/identity_load.json"

type identityLoadStep struct {
	Request map[string]any `json:"request"`
	Params  []any          `json:"params"`
	Error   string         `json:"error"`
	Message string         `json:"message"`
}

type identityLoadCase struct {
	ID        string             `json:"id"`
	Operation string             `json:"operation"`
	Input     map[string]any     `json:"input"`
	Expected  json.RawMessage    `json:"expected"`
	Steps     []identityLoadStep `json:"steps"`
}

type identityLoadDoc struct {
	Fixture string             `json:"fixture"`
	Read    map[string]string  `json:"read"`
	Cases   []identityLoadCase `json:"cases"`
	model   *runtimemodel.Model
	schema  *orm.Schema
}

// loadStatement is the role, SQL, bind slot, and table of one compiled plan step.
type loadStatement struct {
	Role   string     `json:"role"`
	SQL    string     `json:"sql"`
	Slots  []loadSlot `json:"slots"`
	Tables []string   `json:"tables"`
}

// loadSlot is the source of one bind slot, the number of the request value, and its type.
type loadSlot struct {
	From  string `json:"from"`
	Param *int   `json:"param,omitempty"`
	Type  string `json:"type,omitempty"`
}

// readIdentityLoad reads the case file. Numbers are read as json.Number so that integer parameters
// are bound as int64.
func readIdentityLoad(t *testing.T) *identityLoadDoc {
	t.Helper()
	raw, err := os.ReadFile(identityLoadCases)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var doc identityLoadDoc
	if err := dec.Decode(&doc); err != nil {
		t.Fatal(err)
	}
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", filepath.FromSlash(doc.Fixture)))
	if err != nil {
		t.Fatal(err)
	}
	doc.model = m
	doc.schema = &orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText}
	return &doc
}

// compileIdentityLoad adds manifest_hash to the request and compiles it with the dialect's engine.
func compileIdentityLoad(t *testing.T, m *runtimemodel.Model, dialect string, request map[string]any) (*plan.Plan, error) {
	t.Helper()
	if _, ok := request["manifest_hash"]; ok {
		t.Fatalf("request already holds manifest_hash")
	}
	withHash := map[string]any{"manifest_hash": m.ManifestHash}
	for k, v := range request {
		withHash[k] = v
	}
	text, err := json.Marshal(withHash)
	if err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(m, dialect)
	if err != nil {
		t.Fatal(err)
	}
	out, err := e.Compile(text)
	if err != nil {
		return nil, err
	}
	var compiled plan.Plan
	if err := json.Unmarshal(out, &compiled); err != nil {
		t.Fatal(err)
	}
	return &compiled, nil
}

// identityLoadParam converts a case parameter to a client value: integers become int64.
func identityLoadParam(t *testing.T, v any) any {
	t.Helper()
	if n, ok := v.(json.Number); ok {
		i, err := n.Int64()
		if err != nil {
			t.Fatalf("parameter %s is no integer", n)
		}
		return i
	}
	return v
}

// TestIdentityLoad runs every case of the case file as a subtest named by its case ID. Compile cases
// run in all three dialects, and execute cases run in turn inside that subtest,
// in the case database of MySQL, PostgreSQL, and SQLite.
func TestIdentityLoad(t *testing.T) {
	testcase.Start(t, testcase.Database)
	doc := readIdentityLoad(t)
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			switch c.Operation {
			case "compile":
				compileIdentityLoadCase(t, doc, c)
			case "execute":
				for _, driver := range []string{"mysql", "postgres", "sqlite"} {
					t.Logf("driver %s", driver)
					executeIdentityLoadCase(t, doc, c, driver)
				}
			default:
				t.Fatalf("unknown operation %q", c.Operation)
			}
		})
	}
}

// compileIdentityLoadCase compiles the input of a compile case in all three dialects and compares
// the statement or error code and message with the expected ones.
func compileIdentityLoadCase(t *testing.T, doc *identityLoadDoc, c identityLoadCase) {
	var expected struct {
		Error    string          `json:"error"`
		Message  string          `json:"message"`
		MySQL    []loadStatement `json:"mysql"`
		Postgres []loadStatement `json:"postgres"`
		SQLite   []loadStatement `json:"sqlite"`
	}
	if err := json.Unmarshal(c.Expected, &expected); err != nil {
		t.Fatal(err)
	}
	for _, dialect := range []string{"mysql", "postgres", "sqlite"} {
		want := map[string][]loadStatement{"mysql": expected.MySQL, "postgres": expected.Postgres, "sqlite": expected.SQLite}[dialect]
		compiled, err := compileIdentityLoad(t, doc.model, dialect, c.Input)
		if expected.Error != "" {
			if err == nil || orm.ErrorCode(err) != expected.Error || !strings.HasSuffix(err.Error(), expected.Message) {
				t.Fatalf("%s: compile = %v; want %s %q", dialect, err, expected.Error, expected.Message)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", dialect, err)
		}
		got := []loadStatement{}
		for _, step := range compiled.Steps {
			slots := []loadSlot{}
			for _, slot := range step.BindSlots {
				s := loadSlot{From: slot.From, Type: slot.ColType}
				if slot.From == "param" {
					s.Param = &slot.Param
				}
				slots = append(slots, s)
			}
			got = append(got, loadStatement{Role: step.Role, SQL: step.SQL, Slots: slots, Tables: step.Tables})
		}
		checkStatementsJSON(t, dialect, got, want, len(want))
	}
}

// executeIdentityLoadCase runs an execute case in a new case database of the driver: it installs the fixture,
// compiles each step's request and runs it with DB.Execute, then reads the rows of load_probe.
func executeIdentityLoadCase(t *testing.T, doc *identityLoadDoc, c identityLoadCase, driver string) {
	dsn := newDatabase(t, driver)
	db, err := orm.ConnectSchema(dsn, doc.schema, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	if err := db.Utils().Schema().Install(doc.schema); err != nil {
		t.Fatal(err)
	}
	for i, s := range c.Steps {
		compiled, err := compileIdentityLoad(t, doc.model, driver, s.Request)
		if err != nil {
			t.Fatalf("step %d: compile: %v", i, err)
		}
		params := make([]any, len(s.Params))
		for j, p := range s.Params {
			params[j] = identityLoadParam(t, p)
		}
		err = db.Execute(&compiled.Steps[0], params)
		switch {
		case s.Error == "" && err != nil:
			t.Fatalf("step %d: execute: %v", i, err)
		case s.Error != "" && (orm.ErrorCode(err) != s.Error || !strings.HasSuffix(err.Error(), s.Message)):
			t.Fatalf("step %d: execute = %v; want %s %q", i, err, s.Error, s.Message)
		}
	}
	var expected struct {
		Rows [][]any `json:"rows"`
	}
	dec := json.NewDecoder(bytes.NewReader(c.Expected))
	dec.UseNumber()
	if err := dec.Decode(&expected); err != nil {
		t.Fatal(err)
	}
	want := [][]any{}
	for _, row := range expected.Rows {
		want = append(want, []any{identityLoadParam(t, row[0]), row[1]})
	}
	raw := openNative(t, driver, dsn)
	defer testcase.Close(t, raw)
	rows, err := raw.Query(doc.Read[driver])
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, rows)
	got := [][]any{}
	for rows.Next() {
		var seq int64
		var label string
		if err := rows.Scan(&seq, &label); err != nil {
			t.Fatal(err)
		}
		got = append(got, []any{seq, label})
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s rows = %v, want %v", driver, got, want)
	}
}
