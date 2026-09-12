package orm

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/plan"
)

func TestLoadPlanBundleUsesRegisteredShapeWithoutCompiler(t *testing.T) {
	schemaJSON, err := os.ReadFile("../../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.LoadJSON(schemaJSON, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	r := NewReq(eng, "all", "battle")
	compiled := &plan.Plan{SchemaHash: eng.M.SchemaHash, Kind: "all", Steps: []plan.Step{{Role: "main", SQL: "SELECT 1"}}}
	d := &DB{Eng: eng, driver: "mysql", cfg: Config{PlanCacheSize: 2}, plans: map[uint64]*cached{}}
	bundle, err := json.Marshal(map[string]any{
		"version": 1, "schema_hash": eng.M.SchemaHash, "dialect": "mysql", "request_sha256": canonicalRequestSHA(r.IR),
		"plan": compiled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.LoadPlanBundle(bundle, r); err != nil {
		t.Fatal(err)
	}
	got, err := d.Plan(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != "all" || len(got.Steps) == 0 {
		t.Fatalf("loaded plan = %#v", got)
	}
}
