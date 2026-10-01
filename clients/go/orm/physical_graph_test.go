package orm

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/polyspec/orm/engine/schema"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestPhysicalGraphVectors(t *testing.T) {
	started := startCaseClock(t)
	t.Log("RUN physical_graph")
	defer func() {
		t.Logf("DONE physical_graph %s", started.wallTime())
		started.assertWithin(t, "physical_graph", 15*time.Second)
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_graphs.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Base  map[string]any `json:"base"`
		Cases []struct {
			ID      string `json:"id"`
			Changes []struct {
				Path  []any `json:"path"`
				Value any   `json:"value"`
			} `json:"changes"`
			Error *string `json:"error"`
		} `json:"cases"`
		Scale struct {
			Tables  int `json:"tables"`
			Columns int `json:"columnsPerTable"`
			FKs     int `json:"foreignKeys"`
		} `json:"scale"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) != 28 {
		t.Fatal("missing graph vectors")
	}
	clone := func(value any) any {
		encoded, e := json.Marshal(value)
		if e != nil {
			t.Fatal(e)
		}
		var result any
		if e = json.Unmarshal(encoded, &result); e != nil {
			t.Fatal(e)
		}
		return result
	}
	seen := map[string]bool{}
	t.Run("native-numeric-version", func(t *testing.T) {
		value := clone(fixture.Base).(map[string]any)
		value["version"] = 1
		graph, e := PhysicalGraphFromValue(value)
		if e != nil {
			t.Fatal(e)
		}
		if !reflect.DeepEqual(graph.Value(), value) {
			t.Fatal("changed native numeric version")
		}
	})
	for _, c := range fixture.Cases {
		if c.ID == "" || seen[c.ID] {
			t.Fatal("invalid vector ID")
		}
		seen[c.ID] = true
		t.Run(c.ID, func(t *testing.T) {
			value := clone(fixture.Base).(map[string]any)
			for _, change := range c.Changes {
				var target any = value
				for _, key := range change.Path[:len(change.Path)-1] {
					switch key := key.(type) {
					case string:
						target = target.(map[string]any)[key]
					case float64:
						target = target.([]any)[int(key)]
					}
				}
				key := change.Path[len(change.Path)-1]
				switch key := key.(type) {
				case string:
					target.(map[string]any)[key] = change.Value
				case float64:
					target.([]any)[int(key)] = change.Value
				}
			}
			graph, e := PhysicalGraphFromValue(value)
			if c.Error != nil {
				var located *PhysicalGraphError
				if !errors.As(e, &located) || located.Error() != "SCHEMA_INVALID" || located.Path() != *c.Error {
					t.Fatalf("wrong graph error: %v", e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if !reflect.DeepEqual(graph.Value(), value) {
				t.Fatal("changed graph")
			}
			snapshot := graph.Value()
			snapshot["dialectVersion"] = "changed"
			value["dialectVersion"] = "changed"
			if graph.Value()["dialectVersion"] == "changed" {
				t.Fatal("aliased graph")
			}
		})
	}
	if fixture.Scale.Tables != 2000 || fixture.Scale.Columns != 30 || fixture.Scale.FKs != 10000 {
		t.Fatal("changed stress criterion")
	}
	scaleStarted := time.Now()
	tables := make([]any, 2000)
	baseTable := fixture.Base["tables"].([]any)[0].(map[string]any)
	baseColumn := baseTable["columns"].([]any)[0]
	for i := range tables {
		table := clone(baseTable).(map[string]any)
		table["id"] = fmt.Sprintf("t-%d", i)
		table["identity"] = []any{nil, "main", fmt.Sprintf("Table.%d", i), nil}
		columns := make([]any, 30)
		for j := range columns {
			column := clone(baseColumn).(map[string]any)
			column["id"] = fmt.Sprintf("c-%d-%d", i, j)
			column["name"] = fmt.Sprintf("Column.%d", j)
			columns[j] = column
		}
		table["columns"] = columns
		tables[i] = table
	}
	fks := make([]any, 10000)
	for i := range fks {
		source, target := i/5, (i/5+i%5)%2000
		fk := clone(fixture.Base["foreignKeys"].([]any)[0]).(map[string]any)
		fk["id"] = fmt.Sprintf("fk-%d", i)
		fk["name"] = fmt.Sprintf("FK.%d", i%5)
		fk["tableId"] = fmt.Sprintf("t-%d", source)
		fk["columns"] = []any{fmt.Sprintf("c-%d-0", source), fmt.Sprintf("c-%d-1", source)}
		fk["target"] = map[string]any{"tableId": fmt.Sprintf("t-%d", target), "columns": []any{fmt.Sprintf("c-%d-1", target), fmt.Sprintf("c-%d-0", target)}}
		fks[i] = fk
	}
	value := clone(fixture.Base).(map[string]any)
	value["tables"] = tables
	value["foreignKeys"] = fks
	records := graphRecordScale(t, physicalGraphRecordFixture(t)["base"].(map[string]any), 2000)
	for _, field := range []string{"indices", "keys", "checks"} {
		value[field] = records[field]
	}
	generated := time.Now()
	graph, err := PhysicalGraphFromValue(value)
	if err != nil {
		t.Fatal(err)
	}
	validated := time.Now()
	snapshot := graph.Value()
	if !reflect.DeepEqual(snapshot, value) {
		t.Fatal("lost stress graph fields")
	}
	jsonStarted := time.Now()
	text, err := graph.JSON()
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := PhysicalGraphFromJSON(text)
	if err != nil || !reflect.DeepEqual(parsed.Value(), snapshot) {
		t.Fatalf("lost text stress graph: %v", err)
	}
	emitted, err := parsed.JSON()
	if err != nil || string(emitted) != string(text) {
		t.Fatalf("non-idempotent stress JSON: %v", err)
	}
	t.Logf("physical-json-retention bytes=%d elapsed=%s", len(text), time.Since(jsonStarted))
	documentStarted := time.Now()
	source, err := schema.EmitPhysicalDocument(graph, "# Physical design\n\n", "\nAfter\n", "\n")
	if err != nil {
		t.Fatal(err)
	}
	document, err := schema.ParsePhysicalDocument(source)
	if err != nil || !reflect.DeepEqual(document.Graph.Value(), snapshot) {
		t.Fatal("changed complete stress document", err)
	}
	sourceAgain, err := schema.EmitPhysicalDocument(document.Graph, document.Prefix, document.Suffix, document.Newline)
	if err != nil || string(sourceAgain) != string(source) {
		t.Fatal("non-idempotent stress document", err)
	}
	t.Logf("physical-document-retention bytes=%d elapsed=%s", len(source), time.Since(documentStarted))
	tables[0].(map[string]any)["columns"].([]any)[0].(map[string]any)["name"] = "changed"
	if graph.Value()["tables"].([]any)[0].(map[string]any)["columns"].([]any)[0].(map[string]any)["name"] != "Column.0" {
		t.Fatal("aliased nested graph")
	}
	t.Logf("physical-graph-retention tables=2000 columns=60000 foreignKeys=10000 indices=2000 keys=2000 checks=2000 generate=%s validate=%s elapsed=%s", generated.Sub(scaleStarted), validated.Sub(generated), time.Since(scaleStarted))
}
