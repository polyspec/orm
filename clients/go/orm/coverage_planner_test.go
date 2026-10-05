//go:build featurecoverage

package orm_test

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

// plannerStatement는 compile된 plan step 하나의 role, SQL, bind slot, table이다.
type plannerStatement struct {
	Role   string        `json:"role"`
	SQL    string        `json:"sql"`
	Slots  []plannerSlot `json:"slots"`
	Tables []string      `json:"tables"`
}

// plannerSlot은 bind slot 하나의 출처와 type이다. param slot은 request 값의
// 번호를, parent slot은 key의 type을, 나머지 slot은 type을 싣는다.
type plannerSlot struct {
	From     string   `json:"from"`
	Param    *int     `json:"param,omitempty"`
	Type     string   `json:"type,omitempty"`
	KeyTypes []string `json:"key_types,omitempty"`
}

// compilePlannerCase는 planner fixture case의 input에 schema/bench.dbs의
// manifest_hash를 더해 각 dialect의 engine으로 compile하고, 기대한
// statement나 error code와 비교한다.
func compilePlannerCase(t *testing.T, id string) {
	t.Helper()
	c := featureFixture(t, "planner", id, "compile")
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "schema", "bench.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	var input map[string]any
	decodeFixture(t, c.Input, &input)
	if _, ok := input["manifest_hash"]; ok {
		t.Fatalf("case %s input already holds manifest_hash", id)
	}
	input["manifest_hash"] = m.ManifestHash
	request, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var expected struct {
		Error    string             `json:"error"`
		MySQL    []plannerStatement `json:"mysql"`
		Postgres []plannerStatement `json:"postgres"`
		SQLite   []plannerStatement `json:"sqlite"`
	}
	decodeFixture(t, c.Expected, &expected)
	for dialect, want := range map[string][]plannerStatement{"mysql": expected.MySQL, "postgres": expected.Postgres, "sqlite": expected.SQLite} {
		e, err := engine.New(m, dialect)
		if err != nil {
			t.Fatal(err)
		}
		out, err := e.Compile(request)
		if expected.Error != "" {
			if want != nil || err == nil || orm.ErrorCode(err) != expected.Error {
				t.Fatalf("%s: compile = %s, %v; want %s", dialect, out, err, expected.Error)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", dialect, err)
		}
		var compiled plan.Plan
		if err := json.Unmarshal(out, &compiled); err != nil {
			t.Fatal(err)
		}
		got := []plannerStatement{}
		for _, step := range compiled.Steps {
			slots := []plannerSlot{}
			for _, slot := range step.BindSlots {
				s := plannerSlot{From: slot.From}
				switch slot.From {
				case "param":
					s.Param, s.Type = &slot.Param, slot.ColType
				case "parent":
					s.KeyTypes = slot.KeyTypes
				default:
					s.Type = slot.ColType
				}
				slots = append(slots, s)
			}
			got = append(got, plannerStatement{Role: step.Role, SQL: step.SQL, Slots: slots, Tables: step.Tables})
		}
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		if len(want) == 0 || string(gotJSON) != string(wantJSON) {
			t.Fatalf("%s statements:\n got %s\nwant %s", dialect, gotJSON, wantJSON)
		}
	}
}

// TestCoveragePlannerStatement는 조건, 정렬, limit이 있는 row select를 compile한다.
func TestCoveragePlannerStatement(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_statement")
}

// TestCoveragePlannerCount는 count를 compile한다.
func TestCoveragePlannerCount(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_count")
}

// TestCoveragePlannerRejectsUnknownColumn는 없는 column 조건이 COLUMN_UNKNOWN인지 확인한다.
func TestCoveragePlannerRejectsUnknownColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_unknown_column")
}

// TestCoveragePlannerRestore는 soft delete한 행을 primary key로 되돌리는 restore를 compile한다.
func TestCoveragePlannerRestore(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore")
}

// TestCoveragePlannerRestoreRejectsNonKey는 key가 아닌 column의 restore가 IR_INVALID인지 확인한다.
func TestCoveragePlannerRestoreRejectsNonKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_restore_rejects_non_key")
}

// TestCoveragePlannerTables는 subquery, join, relation이 있는 select의 step마다
// statement가 이름으로 쓰는 table을 확인한다.
func TestCoveragePlannerTables(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_tables")
}

// TestCoveragePlannerBindTypesSelect는 select의 조건 slot이 column, 함수, 상대 시각 함수의 type을 싣는지 확인한다.
func TestCoveragePlannerBindTypesSelect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_select")
}

// TestCoveragePlannerBindTypesUpdate는 update의 할당, AES, blind index, config, optimistic slot의 type을 확인한다.
func TestCoveragePlannerBindTypesUpdate(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_update")
}

// TestCoveragePlannerBindTypesInsert는 insert의 값, AES, blind index, config, now slot의 type을 확인한다.
func TestCoveragePlannerBindTypesInsert(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_bind_types_insert")
}

// TestCoveragePlannerParentKeyTypes는 composite key relation의 parent slot이 key type을 싣는지 확인한다.
func TestCoveragePlannerParentKeyTypes(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_parent_key_types")
}

// TestCoveragePlannerNotGroup는 select의 NOT group이 그 조건을 괄호와 함께 부정하는지 확인한다.
func TestCoveragePlannerNotGroup(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_not_group")
}

// TestCoveragePlannerRejectsTopNot는 top-level where group의 not이 IR_INVALID인지 확인한다.
func TestCoveragePlannerRejectsTopNot(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	compilePlannerCase(t, "planner_rejects_top_not")
}
