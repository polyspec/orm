package orm

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func physicalKeyInput(t *testing.T, base map[string]any, c map[string]any) map[string]any {
	t.Helper()
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
	if field, ok := c["drop"].(string); ok {
		delete(value, field)
	}
	if field, ok := c["field"].(string); ok {
		unit := "x"
		if supplied, ok := c["unit"].(string); ok {
			unit = supplied
		}
		value[field] = strings.Repeat(unit, int(c["count"].(float64)))
	}
	if count, ok := c["columns"].(float64); ok {
		ids := make([]any, int(count))
		for i := range ids {
			ids[i] = fmt.Sprintf("column-%d", i)
		}
		value["columns"] = ids
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

func TestPhysicalKeyVectors(t *testing.T) {
	started := time.Now()
	t.Log("RUN physical_key")
	defer func() {
		t.Logf("DONE physical_key %s", time.Since(started))
		if time.Since(started) > 3*time.Second {
			t.Fatal("key deadline exceeded")
		}
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_keys.json")
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
	if len(fixture.Cases) != 35 || len(fixture.Bounds) != 14 {
		t.Fatal("missing key vectors")
	}
	seen := map[string]bool{}
	for _, c := range append(fixture.Cases, fixture.Bounds...) {
		id, ok := c["id"].(string)
		if !ok || id == "" || seen[id] {
			t.Fatal("invalid case ID")
		}
		seen[id] = true
		t.Run(id, func(t *testing.T) {
			caseStarted := time.Now()
			defer func() {
				if time.Since(caseStarted) > time.Second {
					t.Fatal("case deadline exceeded")
				}
			}()
			value := physicalKeyInput(t, fixture.Base, c)
			key, e := PhysicalKeyFromValue(value)
			if expected, ok := c["error"].(string); ok {
				if e == nil || e.Error() != expected {
					t.Fatalf("expected safe rejection: %v", e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if !reflect.DeepEqual(key.Value(), value) {
				t.Fatal("changed key fields/order")
			}
			value["columns"].([]any)[0] = "changed"
			copy := key.Value()
			copy["columns"].([]any)[0] = "changed"
			if key.Value()["columns"].([]any)[0] == "changed" {
				t.Fatal("aliased key columns")
			}
			if len(value["options"].([]any)) > 0 {
				value["options"].([]any)[0].(map[string]any)["value"] = "changed"
				copy["options"].([]any)[0].(map[string]any)["value"] = "changed"
				if key.Value()["options"].([]any)[0].(map[string]any)["value"] == "changed" {
					t.Fatal("aliased key options")
				}
			}
		})
	}
	for _, field := range []string{"name", "indexId", "comment"} {
		value := physicalKeyInput(t, fixture.Base, map[string]any{})
		value[field] = string([]byte{0xff})
		if _, e := PhysicalKeyFromValue(value); e == nil || e.Error() != "SCHEMA_INVALID" {
			t.Fatal("invalid UTF-8 accepted")
		}
	}
}
