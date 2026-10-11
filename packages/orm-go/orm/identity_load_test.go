package orm_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

// contracts/fixtures/identity_load.json의 공유 case를 이 client로 실행한다. compile
// case는 세 dialect의 engine으로 request를 compile해 statement나 오류를 비교하고,
// execute case는 case database에 fixture를 설치한 뒤 각 step의 request를 그
// database의 engine으로 compile해 DB.Execute로 실행하고, 마지막에 load_probe의 행을
// 읽어 비교한다.

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

// loadStatement는 compile된 plan step 하나의 role, SQL, bind slot, table이다.
type loadStatement struct {
	Role   string     `json:"role"`
	SQL    string     `json:"sql"`
	Slots  []loadSlot `json:"slots"`
	Tables []string   `json:"tables"`
}

// loadSlot은 bind slot 하나의 출처, request 값의 번호, type이다.
type loadSlot struct {
	From  string `json:"from"`
	Param *int   `json:"param,omitempty"`
	Type  string `json:"type,omitempty"`
}

// readIdentityLoad는 case 파일을 읽는다. 숫자는 json.Number로 읽어 정수 parameter가
// int64로 bind되게 한다.
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

// compileIdentityLoad는 request에 manifest_hash를 더해 dialect의 engine으로 compile한다.
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

// identityLoadParam은 case parameter를 client 값으로 바꾼다: 정수는 int64다.
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

// TestIdentityLoad는 case 파일의 모든 case를 case ID의 subtest로 실행한다. compile case는
// 세 dialect에서, execute case는 MySQL, PostgreSQL, SQLite의 case database마다 실행한다.
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
					t.Run(driver, func(t *testing.T) { executeIdentityLoadCase(t, doc, c, driver) })
				}
			default:
				t.Fatalf("unknown operation %q", c.Operation)
			}
		})
	}
}

// compileIdentityLoadCase는 compile case의 input을 세 dialect에서 compile해 기대한
// statement나 오류 code와 message를 비교한다.
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
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		if len(want) == 0 || string(gotJSON) != string(wantJSON) {
			t.Fatalf("%s statements:\n got %s\nwant %s", dialect, gotJSON, wantJSON)
		}
	}
}

// executeIdentityLoadCase는 execute case를 driver의 새 case database에서 실행한다: fixture를
// 설치하고, 각 step의 request를 compile해 DB.Execute로 실행한 뒤 load_probe의 행을 읽는다.
func executeIdentityLoadCase(t *testing.T, doc *identityLoadDoc, c identityLoadCase, driver string) {
	dsn := newDatabase(t, driver)
	db, err := orm.ConnectSchema(dsn, doc.schema, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
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
	defer raw.Close()
	rows, err := raw.Query(doc.Read[driver])
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
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
