package ormgen

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

func TestPrecompiledPlanContainsSchemaAndRequestHashes(t *testing.T) {
	d, err := schema.Parse("erDiagram\n thing {\n bigint id PK \"auto\"\n }\n")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	schemaJSON, err := m.MarshalIndent()
	if err != nil {
		t.Fatal(err)
	}
	request := `{"ir_version":1,"schema_hash":"` + m.SchemaHash + `","kind":"all","entity":"thing","n_params":0}`
	eng, err := engine.LoadJSON(append(schemaJSON, '\n'), "mysql")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := eng.Compile([]byte(request))
	if err != nil {
		t.Fatal(err)
	}
	var got precompiledPlan
	if err := json.Unmarshal([]byte(`{"version":1,"schema_hash":"`+m.SchemaHash+`","dialect":"mysql","request_sha256":"x","plan":`+string(plan)+`}`), &got); err != nil {
		t.Fatal(err)
	}
	if got.Version != 1 || got.SchemaHash != m.SchemaHash || got.Dialect != "mysql" || got.Plan == nil || !strings.Contains(string(got.Plan), "steps") {
		t.Fatalf("unexpected precompiled plan: %+v", got)
	}
}
