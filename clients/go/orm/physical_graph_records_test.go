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

func physicalGraphRecordFixture(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_graph_records.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]any
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}
func graphRecordClone(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var result any
	if err = json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func graphRecordScale(t *testing.T, base map[string]any, count int) map[string]any {
	result := map[string]any{"indices": make([]any, count), "keys": make([]any, count), "checks": make([]any, count)}
	for i := 0; i < count; i++ {
		index := graphRecordClone(t, base["indices"].([]any)[0]).(map[string]any)
		index["id"] = fmt.Sprintf("index-%d", i)
		index["tableId"] = fmt.Sprintf("t-%d", i)
		terms := index["terms"].([]any)
		terms[0].(map[string]any)["source"].(map[string]any)["columnId"] = fmt.Sprintf("c-%d-1", i)
		terms[1].(map[string]any)["source"].(map[string]any)["columnId"] = fmt.Sprintf("c-%d-0", i)
		key := graphRecordClone(t, base["keys"].([]any)[0]).(map[string]any)
		key["id"] = fmt.Sprintf("key-%d", i)
		key["tableId"] = fmt.Sprintf("t-%d", i)
		key["columns"] = []any{fmt.Sprintf("c-%d-1", i), fmt.Sprintf("c-%d-0", i)}
		key["indexId"] = index["id"]
		check := graphRecordClone(t, base["checks"].([]any)[0]).(map[string]any)
		check["id"] = fmt.Sprintf("check-%d", i)
		check["tableId"] = fmt.Sprintf("t-%d", i)
		check["expressionSql"] = "\"Column.0\" > 0"
		result["indices"].([]any)[i] = index
		result["keys"].([]any)[i] = key
		result["checks"].([]any)[i] = check
	}
	return result
}

func TestPhysicalGraphRecords(t *testing.T) {
	started := time.Now()
	t.Log("RUN physical_graph_records")
	defer func() {
		t.Logf("DONE physical_graph_records %s", time.Since(started))
		if time.Since(started) > 15*time.Second {
			t.Fatal("records deadline exceeded")
		}
	}()
	fixture := physicalGraphRecordFixture(t)
	base := fixture["base"].(map[string]any)
	cases := fixture["cases"].([]any)
	if len(cases) != 35 || len(fixture["duplicates"].([]any)) != 3 || len(fixture["counts"].([]any)) != 3 || len(fixture["bytes"].([]any)) != 3 {
		t.Fatal("missing graph record cases")
	}
	for _, field := range []string{"tables", "indices", "keys", "checks"} {
		if fixture["scale"].(map[string]any)[field] != float64(2000) {
			t.Fatal("changed record scale criterion")
		}
	}
	expect := func(t *testing.T, value map[string]any, path string) {
		t.Helper()
		_, err := PhysicalGraphFromValue(value)
		var located *PhysicalGraphError
		if !errors.As(err, &located) || located.Error() != "SCHEMA_INVALID" || located.Path() != path {
			t.Fatalf("expected %s: %v", path, err)
		}
	}
	seen := map[string]bool{}
	for _, item := range cases {
		c := item.(map[string]any)
		id := c["id"].(string)
		if id == "" || seen[id] {
			t.Fatal("invalid case ID")
		}
		seen[id] = true
		t.Run(id, func(t *testing.T) {
			value := graphRecordClone(t, base).(map[string]any)
			if drop, ok := c["drop"].(string); ok {
				delete(value, drop)
			}
			for _, item := range c["changes"].([]any) {
				change := item.(map[string]any)
				path := change["path"].([]any)
				var target any = value
				for _, key := range path[:len(path)-1] {
					switch key := key.(type) {
					case string:
						target = target.(map[string]any)[key]
					case float64:
						target = target.([]any)[int(key)]
					}
				}
				switch key := path[len(path)-1].(type) {
				case string:
					target.(map[string]any)[key] = graphRecordClone(t, change["value"])
				case float64:
					target.([]any)[int(key)] = graphRecordClone(t, change["value"])
				}
			}
			if path, ok := c["error"].(string); ok {
				expect(t, value, path)
				return
			}
			graph, err := PhysicalGraphFromValue(value)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(graph.Value(), value) {
				t.Fatal("changed graph records")
			}
			if len(value["indices"].([]any)) > 0 {
				value["indices"].([]any)[0].(map[string]any)["terms"].([]any)[0].(map[string]any)["order"] = "changed"
				snapshot := graph.Value()
				snapshot["checks"].([]any)[0].(map[string]any)["comment"] = "changed"
				if graph.Value()["indices"].([]any)[0].(map[string]any)["terms"].([]any)[0].(map[string]any)["order"] == "changed" || graph.Value()["checks"].([]any)[0].(map[string]any)["comment"] == "changed" {
					t.Fatal("aliased graph records")
				}
			}
		})
	}
	for _, item := range fixture["duplicates"].([]any) {
		c := item.(map[string]any)
		t.Run(c["id"].(string), func(t *testing.T) {
			value := graphRecordClone(t, base).(map[string]any)
			field := c["field"].(string)
			record := graphRecordClone(t, value[field].([]any)[0]).(map[string]any)
			record["id"] = "another"
			for _, name := range []string{"name", "kind", "indexId"} {
				if v, ok := c[name]; ok {
					record[name] = v
				}
			}
			value[field] = append(value[field].([]any), record)
			expect(t, value, c["error"].(string))
		})
	}
	for _, item := range fixture["counts"].([]any) {
		c := item.(map[string]any)
		t.Run(c["field"].(string)+"-count", func(t *testing.T) {
			value := graphRecordClone(t, base).(map[string]any)
			field := c["field"].(string)
			value[field] = make([]any, int(c["count"].(float64)))
			expect(t, value, c["error"].(string))
		})
	}
	t.Run("combined-count", func(t *testing.T) {
		value := graphRecordClone(t, base).(map[string]any)
		for _, field := range []string{"foreignKeys", "indices", "keys"} {
			value[field] = make([]any, 20000)
		}
		expect(t, value, "")
	})
	for _, item := range fixture["bytes"].([]any) {
		c := item.(map[string]any)
		field := c["field"].(string)
		t.Run(field+"-string-budget", func(t *testing.T) {
			value := graphRecordClone(t, base).(map[string]any)
			prototype := value[field].([]any)[0]
			records := make([]any, int(c["count"].(float64)))
			comment := strings.Repeat("x", int(c["commentBytes"].(float64)))
			for i := range records {
				record := graphRecordClone(t, prototype).(map[string]any)
				record["id"] = fmt.Sprintf("record-%d", i)
				record["name"] = nil
				record["comment"] = comment
				if field == "keys" {
					record["kind"] = "unique"
					record["indexId"] = nil
				}
				records[i] = record
			}
			value[field] = records
			if field == "indices" {
				value["keys"] = []any{}
			}
			expect(t, value, c["error"].(string))
		})
	}
}
