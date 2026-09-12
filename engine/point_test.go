package engine

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
)

func TestPointPlanForEveryDialect(t *testing.T) {
	d, err := schema.Parse("erDiagram\n  thing {\n    bigint id PK\n    point location \"?\"\n  }\n")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	for driver, parts := range map[string][]string{
		"mysql":    {"ST_AsText(`a`.`location`)", "ST_PointFromText(?)"},
		"postgres": {`("a"."location")::text`, `CAST($2 AS text)::point`},
		"sqlite":   {`"a"."location"`, "?"},
	} {
		e, err := New(m, driver)
		if err != nil {
			t.Fatal(err)
		}
		selectPlan, err := e.P.Compile(&ir.Request{IRVersion: 1, SchemaHash: m.SchemaHash, Kind: "all", Query: ir.Query{Entity: "thing"}})
		if err != nil || !strings.Contains(selectPlan.Steps[0].SQL, parts[0]) {
			t.Fatalf("%s select=%v err=%v", driver, selectPlan, err)
		}
		writePlan, err := e.P.Compile(&ir.Request{IRVersion: 1, SchemaHash: m.SchemaHash, Kind: "insert", Query: ir.Query{Entity: "thing"}, Set: []ir.Assign{{Column: "id", P: intp(0)}, {Column: "location", P: intp(1)}}, NParams: 2})
		if err != nil || !strings.Contains(writePlan.Steps[0].SQL, parts[1]) {
			t.Fatalf("%s insert=%v err=%v", driver, writePlan, err)
		}
		if got := writePlan.Steps[0].BindSlots[1].ColType; got != "point" {
			t.Fatalf("%s point col_type=%q", driver, got)
		}
	}
}

func intp(v int) *int { return &v }
