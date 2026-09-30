package orm

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPhysicalColumnVectors(t *testing.T) {
	started := time.Now()
	t.Log("RUN physical_column")
	defer func() {
		elapsed := time.Since(started)
		t.Logf("DONE physical_column %s", elapsed)
		if elapsed > 3*time.Second {
			t.Fatal("column deadline exceeded")
		}
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_columns.json")
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
	if len(fixture.Cases) != 25 {
		t.Fatal("missing vectors")
	}
	seen := map[string]bool{}
	for _, c := range fixture.Cases {
		if c.ID == "" || seen[c.ID] {
			t.Fatal("invalid case id")
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
			encoded, e := json.Marshal(value)
			if e != nil {
				t.Fatal(e)
			}
			if e = json.Unmarshal(encoded, &value); e != nil {
				t.Fatal(e)
			}
			column, err := PhysicalColumnFromValue(value)
			if c.Error != "" {
				if err == nil || err.Error() != c.Error {
					t.Fatalf("expected safe rejection: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(column.Value(), value) {
				t.Fatal("changed physical fields")
			}
			snapshot := column.Value()
			snapshot["default"].(map[string]any)["kind"] = "changed"
			if column.Value()["default"].(map[string]any)["kind"] == "changed" {
				t.Fatal("output alias")
			}
			value["comment"] = "changed"
			value["default"].(map[string]any)["kind"] = "changed"
			if column.Value()["comment"] == "changed" {
				t.Fatal("input alias")
			}
			if column.Value()["default"].(map[string]any)["kind"] == "changed" {
				t.Fatal("nested input alias")
			}
		})
	}
	invalid := map[string]any{}
	for k, v := range fixture.Base {
		invalid[k] = v
	}
	invalid["typeSql"] = strings.Repeat("x", 4097)
	if _, err := PhysicalColumnFromValue(invalid); err == nil {
		t.Fatal("oversized type accepted")
	}
	for _, name := range []string{strings.Repeat("한", 1366), string([]byte{0xff})} {
		invalid["typeSql"] = name
		if _, err := PhysicalColumnFromValue(invalid); err == nil {
			t.Fatal("invalid type encoding/byte limit accepted")
		}
	}
	invalid["typeSql"] = fixture.Base["typeSql"]
	options := make([]any, 64)
	for i := range options {
		options[i] = map[string]any{"name": "option", "value": strings.Repeat("x", 1100)}
	}
	invalid["options"] = options
	if _, err := PhysicalColumnFromValue(invalid); err == nil {
		t.Fatal("aggregate payload budget accepted")
	}
	invalid["options"] = append(options, map[string]any{"name": "option", "value": ""})
	if _, err := PhysicalColumnFromValue(invalid); err == nil {
		t.Fatal("option count accepted")
	}
}
