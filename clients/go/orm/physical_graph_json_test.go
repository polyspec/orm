package orm

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPhysicalGraphJSON(t *testing.T) {
	start := time.Now()
	t.Log("RUN physical_graph_json")
	defer func() {
		t.Logf("DONE physical_graph_json %s", time.Since(start))
		if time.Since(start) > 15*time.Second {
			t.Fatal("deadline exceeded")
		}
	}()
	data, e := os.ReadFile("../../../contracts/fixtures/physical_graph_json.json")
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Empty map[string]any
		Cases []struct {
			ID, Text, Path string
			OK             bool
		}
		Versions []string
		Bounds   struct{ Bytes, Depth, Nodes int }
	}
	if e = json.Unmarshal(data, &f); e != nil {
		t.Fatal(e)
	}
	if len(f.Cases) != 30 {
		t.Fatal("missing cases")
	}
	fail := func(text, path string) {
		t.Helper()
		_, err := PhysicalGraphFromJSON([]byte(text))
		var located *PhysicalGraphError
		if !errors.As(err, &located) || located.Path() != path || err.Error() != "SCHEMA_INVALID" {
			t.Fatalf("wrong rejection: %v", err)
		}
	}
	for _, c := range f.Cases {
		t.Run(c.ID, func(t *testing.T) {
			if c.OK {
				g, e := PhysicalGraphFromJSON([]byte(c.Text))
				if e != nil || !reflect.DeepEqual(g.Value(), f.Empty) {
					t.Fatalf("changed graph: %v", e)
				}
			} else {
				fail(c.Text, c.Path)
			}
		})
	}
	empty, _ := json.Marshal(f.Empty)
	for i, v := range f.Versions {
		text := strings.Replace(string(empty), `"version":1`, `"version":`+v, 1)
		if i < 4 {
			g, e := PhysicalGraphFromJSON([]byte(text))
			if e != nil || !reflect.DeepEqual(g.Value(), f.Empty) {
				t.Fatalf("version %d: %v", i, e)
			}
		} else {
			fail(text, "")
		}
	}
	recordsData, e := os.ReadFile("../../../contracts/fixtures/physical_graph_records.json")
	if e != nil {
		t.Fatal(e)
	}
	var records struct{ Base map[string]any }
	if e = json.Unmarshal(recordsData, &records); e != nil {
		t.Fatal(e)
	}
	records.Base["tables"].([]any)[0].(map[string]any)["comment"] = `</script> <!-- --> " \ 😺 �`
	input, _ := json.Marshal(records.Base)
	g, e := PhysicalGraphFromJSON(input)
	if e != nil {
		t.Fatal(e)
	}
	out, e := g.JSON()
	if e != nil {
		t.Fatal(e)
	}
	again, e := PhysicalGraphFromJSON(out)
	if e != nil || !reflect.DeepEqual(again.Value(), records.Base) {
		t.Fatalf("roundtrip: %v", e)
	}
	out2, _ := again.JSON()
	if string(out) != string(out2) {
		t.Fatal("non-idempotent emission")
	}
	for _, text := range []string{strings.Repeat(" ", f.Bounds.Bytes+1), strings.Repeat("[", 17) + strings.Repeat("]", 17), "[" + strings.Repeat("0,", f.Bounds.Nodes) + "0]", string([]byte{255})} {
		fail(text, "")
	}
	var zero PhysicalGraph
	if _, err := zero.JSON(); err == nil {
		t.Fatal("emitted an uninitialized graph")
	}
}
func TestPhysicalGraphJSONOutput(t *testing.T) {
	start := time.Now()
	t.Log("RUN physical_graph_json_output")
	defer func() {
		t.Logf("DONE physical_graph_json_output %s", time.Since(start))
		if time.Since(start) > 15*time.Second {
			t.Fatal("deadline exceeded")
		}
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_graph_json.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Empty  map[string]any
		Output struct {
			AcceptedTables, RejectedTables, CommentBytes int
			CommentCharacter                             string
		}
	}
	if err = json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	base := physicalGraphRecordFixture(t)["base"].(map[string]any)["tables"].([]any)[0].(map[string]any)
	for _, count := range []int{f.Output.AcceptedTables, f.Output.RejectedTables} {
		value := graphRecordClone(t, f.Empty).(map[string]any)
		tables := make([]any, count)
		for i := range tables {
			table := graphRecordClone(t, base).(map[string]any)
			table["id"] = fmt.Sprintf("t-%d", i)
			table["identity"] = []any{nil, "main", fmt.Sprintf("Table.%d", i), nil}
			table["comment"] = strings.Repeat(f.Output.CommentCharacter, f.Output.CommentBytes)
			for j, column := range table["columns"].([]any) {
				column.(map[string]any)["id"] = fmt.Sprintf("c-%d-%d", i, j)
			}
			tables[i] = table
		}
		value["tables"] = tables
		graph, err := PhysicalGraphFromValue(value)
		if err != nil {
			t.Fatal(err)
		}
		text, err := graph.JSON()
		if count == f.Output.AcceptedTables {
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := PhysicalGraphFromJSON(text)
			if err != nil || !reflect.DeepEqual(parsed.Value(), value) {
				t.Fatalf("output-limit roundtrip: %v", err)
			}
		} else {
			var located *PhysicalGraphError
			if !errors.As(err, &located) || located.Path() != "" {
				t.Fatalf("wrong output rejection: %v", err)
			}
		}
	}
}
