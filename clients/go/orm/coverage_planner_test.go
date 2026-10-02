//go:build featurecoverage

package orm_test

import (
	"encoding/json"
	"path/filepath"
	"slices"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/runtimemodel"
)

// plannerStatement는 compile된 plan step 하나의 role, SQL, bind slot param이다.
type plannerStatement struct {
	Role   string `json:"role"`
	SQL    string `json:"sql"`
	Params []int  `json:"params"`
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
			params := []int{}
			for _, slot := range step.BindSlots {
				if slot.From != "param" {
					t.Fatalf("%s: step %d binds from %s", dialect, step.ID, slot.From)
				}
				params = append(params, slot.Param)
			}
			got = append(got, plannerStatement{Role: step.Role, SQL: step.SQL, Params: params})
		}
		if len(want) == 0 || !slices.EqualFunc(got, want, func(a, b plannerStatement) bool {
			return a.Role == b.Role && a.SQL == b.SQL && slices.Equal(a.Params, b.Params)
		}) {
			t.Fatalf("%s statements:\n got %+v\nwant %+v", dialect, got, want)
		}
	}
}

// TestCoveragePlannerStatement는 조건, 정렬, limit이 있는 row select를 compile한다.
func TestCoveragePlannerStatement(t *testing.T) { compilePlannerCase(t, "planner_statement") }

// TestCoveragePlannerCount는 count를 compile한다.
func TestCoveragePlannerCount(t *testing.T) { compilePlannerCase(t, "planner_count") }

// TestCoveragePlannerRejectsUnknownColumn는 없는 column 조건이 COLUMN_UNKNOWN인지 확인한다.
func TestCoveragePlannerRejectsUnknownColumn(t *testing.T) {
	compilePlannerCase(t, "planner_rejects_unknown_column")
}
