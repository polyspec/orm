package orm

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPhysicalCheckVectors(t *testing.T) {
	started := time.Now()
	t.Log("RUN physical_check")
	defer func() {
		t.Logf("DONE physical_check %s", time.Since(started))
		if time.Since(started) > 3*time.Second {
			t.Fatal("CHECK deadline exceeded")
		}
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_checks.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Base  map[string]any `json:"base"`
		Cases []struct {
			ID      string         `json:"id"`
			Changes map[string]any `json:"changes"`
			Error   string         `json:"error"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) != 24 {
		t.Fatal("missing CHECK vectors")
	}
	seen := map[string]bool{}
	for _, c := range fixture.Cases {
		if c.ID == "" || seen[c.ID] {
			t.Fatal("invalid case ID")
		}
		seen[c.ID] = true
		t.Run(c.ID, func(t *testing.T) {
			value := map[string]any{}
			for k, v := range fixture.Base {
				value[k] = v
			}
			for k, v := range c.Changes {
				value[k] = v
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(encoded, &value); err != nil {
				t.Fatal(err)
			}
			record, e := PhysicalCheckFromValue(value)
			if c.Error != "" {
				if e == nil || e.Error() != c.Error {
					t.Fatalf("expected safe rejection: %v", e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if !reflect.DeepEqual(record.Value(), value) {
				t.Fatal("changed CHECK record")
			}
			if len(value["options"].([]any)) > 0 {
				value["options"].([]any)[0].(map[string]any)["value"] = "changed"
				copy := record.Value()
				copy["options"].([]any)[0].(map[string]any)["value"] = "changed"
				if record.Value()["options"].([]any)[0].(map[string]any)["value"] == "changed" {
					t.Fatal("aliased CHECK")
				}
			}
		})
	}
}

func TestPhysicalCheckBounds(t *testing.T) {
	started := time.Now()
	t.Log("RUN physical_check_bounds")
	defer func() {
		t.Logf("DONE physical_check_bounds %s", time.Since(started))
		if time.Since(started) > 3*time.Second {
			t.Fatal("CHECK bounds deadline exceeded")
		}
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_checks.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Base   map[string]any `json:"base"`
		Bounds []struct {
			ID, Field, Unit, Drop, Error string
			Count, Options, Size         int
		} `json:"bounds"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Bounds) != 17 {
		t.Fatal("missing bounds")
	}
	seen := map[string]bool{}
	for _, c := range fixture.Bounds {
		if c.ID == "" || seen[c.ID] {
			t.Fatal("invalid bounds ID")
		}
		seen[c.ID] = true
		t.Run(c.ID, func(t *testing.T) {
			value := map[string]any{}
			for k, v := range fixture.Base {
				value[k] = v
			}
			if c.Field != "" {
				value[c.Field] = strings.Repeat(c.Unit, c.Count)
			}
			if c.Options > 0 {
				options := make([]any, c.Options)
				for i := range options {
					options[i] = map[string]any{"name": "x", "value": strings.Repeat("x", c.Size)}
				}
				value["options"] = options
			}
			if c.Drop != "" {
				delete(value, c.Drop)
			}
			record, e := PhysicalCheckFromValue(value)
			if c.Error != "" {
				if e == nil || e.Error() != c.Error {
					t.Fatalf("expected safe rejection: %v", e)
				}
			} else if e != nil || !reflect.DeepEqual(record.Value(), value) {
				t.Fatalf("changed bounded record: %v", e)
			}
		})
	}
	value := map[string]any{}
	for k, v := range fixture.Base {
		value[k] = v
	}
	value["expressionSql"] = string([]byte{0xff})
	if _, e := PhysicalCheckFromValue(value); e == nil || e.Error() != "SCHEMA_INVALID" {
		t.Fatal("invalid UTF-8 accepted")
	}
}
