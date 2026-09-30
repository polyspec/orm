package orm

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func physicalIndexInput(t *testing.T, base map[string]any, c map[string]any) map[string]any {
	t.Helper()
	unit := "x"
	if supplied, ok := c["unit"].(string); ok {
		unit = supplied
	}
	encoded, err := json.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	value := map[string]any{}
	if err = json.Unmarshal(encoded, &value); err != nil {
		t.Fatal(err)
	}
	if changes, ok := c["changes"].(map[string]any); ok {
		for k, v := range changes {
			value[k] = v
		}
	}
	if changes, ok := c["termChanges"].(map[string]any); ok {
		for k, v := range changes {
			value["terms"].([]any)[0].(map[string]any)[k] = v
		}
	}
	if field, ok := c["drop"].(string); ok {
		delete(value, field)
	}
	if field, ok := c["field"].(string); ok {
		value[field] = strings.Repeat(unit, int(c["count"].(float64)))
	}
	if field, ok := c["termField"].(string); ok {
		value["terms"].([]any)[0].(map[string]any)[field] = strings.Repeat(unit, int(c["count"].(float64)))
	}
	if size, ok := c["expression"].(float64); ok {
		value["terms"].([]any)[0].(map[string]any)["source"] = map[string]any{"kind": "expression", "sql": strings.Repeat("x", int(size))}
	}
	if count, ok := c["terms"].(float64); ok {
		term := value["terms"].([]any)[0]
		terms := make([]any, int(count))
		for i := range terms {
			terms[i] = term
		}
		value["terms"] = terms
	}
	if count, ok := c["include"].(float64); ok {
		ids := make([]any, int(count))
		for i := range ids {
			ids[i] = fmt.Sprintf("included-%d", i)
		}
		value["include"] = ids
	}
	if count, ok := c["options"].(float64); ok {
		options := make([]any, int(count))
		for i := range options {
			options[i] = map[string]any{"name": "x", "value": strings.Repeat("x", int(c["size"].(float64)))}
		}
		value["options"] = options
	}
	return value
}

func TestPhysicalIndexVectors(t *testing.T) {
	started := time.Now()
	t.Log("RUN physical_index")
	defer func() {
		t.Logf("DONE physical_index %s", time.Since(started))
		if time.Since(started) > 3*time.Second {
			t.Fatal("index deadline exceeded")
		}
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_indices.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Base          map[string]any
		Cases, Bounds []map[string]any
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) != 46 || len(fixture.Bounds) != 20 {
		t.Fatal("missing index vectors")
	}
	seen := map[string]bool{}
	for _, c := range append(fixture.Cases, fixture.Bounds...) {
		id, ok := c["id"].(string)
		if !ok || id == "" || seen[id] {
			t.Fatal("invalid case ID")
		}
		seen[id] = true
		t.Run(id, func(t *testing.T) {
			value := physicalIndexInput(t, fixture.Base, c)
			index, e := PhysicalIndexFromValue(value)
			if expected, ok := c["error"].(string); ok {
				if e == nil || e.Error() != expected {
					t.Fatalf("expected safe rejection: %v", e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if !reflect.DeepEqual(index.Value(), value) {
				t.Fatal("changed index fields/order")
			}
			value["terms"].([]any)[0].(map[string]any)["source"].(map[string]any)["kind"] = "changed"
			copy := index.Value()
			copy["terms"].([]any)[0].(map[string]any)["source"].(map[string]any)["kind"] = "changed"
			if index.Value()["terms"].([]any)[0].(map[string]any)["source"].(map[string]any)["kind"] == "changed" {
				t.Fatal("aliased nested source")
			}
			if len(copy["include"].([]any)) > 0 {
				copy["include"].([]any)[0] = "changed"
				if index.Value()["include"].([]any)[0] == "changed" {
					t.Fatal("aliased included columns")
				}
			}
		})
	}
	for _, field := range []string{"name", "methodSql", "predicateSql", "comment"} {
		value := physicalIndexInput(t, fixture.Base, map[string]any{})
		value[field] = string([]byte{0xff})
		if _, e := PhysicalIndexFromValue(value); e == nil || e.Error() != "SCHEMA_INVALID" {
			t.Fatal("invalid UTF-8 accepted")
		}
	}
	for _, prefix := range []any{int(191), int64(2147483647), uint32(2147483647), float32(191)} {
		value := physicalIndexInput(t, fixture.Base, map[string]any{})
		value["terms"].([]any)[0].(map[string]any)["prefixLength"] = prefix
		if _, e := PhysicalIndexFromValue(value); e != nil {
			t.Fatal("native numeric prefix rejected")
		}
	}
	for _, prefix := range []any{int64(-1), uint64(1 << 63), math.NaN(), math.Inf(1)} {
		value := physicalIndexInput(t, fixture.Base, map[string]any{})
		value["terms"].([]any)[0].(map[string]any)["prefixLength"] = prefix
		if _, e := PhysicalIndexFromValue(value); e == nil || e.Error() != "SCHEMA_INVALID" {
			t.Fatal("invalid native numeric prefix accepted")
		}
	}
}
