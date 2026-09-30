package orm

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestPhysicalForeignKeyVectors(t *testing.T) {
	started := time.Now()
	t.Log("RUN physical_foreign_key")
	defer func() {
		elapsed := time.Since(started)
		t.Logf("DONE physical_foreign_key %s", elapsed)
		if elapsed > 3*time.Second {
			t.Fatal("FK deadline exceeded")
		}
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_foreign_keys.json")
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
	if len(fixture.Cases) != 26 {
		t.Fatal("missing FK vectors")
	}
	seen := map[string]bool{}
	for _, c := range fixture.Cases {
		if c.ID == "" || seen[c.ID] {
			t.Fatal("invalid vector id")
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
			fk, e := PhysicalForeignKeyFromValue(value)
			if c.Error != "" {
				if e == nil || e.Error() != c.Error {
					t.Fatalf("expected safe rejection: %v", e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if !reflect.DeepEqual(fk.Value(), value) {
				t.Fatal("changed FK fields/order")
			}
			snapshot := fk.Value()
			snapshot["target"].(map[string]any)["tableId"] = "changed"
			value["columns"].([]any)[0] = "changed"
			if fk.Value()["target"].(map[string]any)["tableId"] == "changed" || fk.Value()["columns"].([]any)[0] == "changed" {
				t.Fatal("aliased FK")
			}
		})
	}
	ids := make([]any, 64)
	for index := range ids {
		ids[index] = fmt.Sprintf("column-%d", index)
	}
	bounded := map[string]any{}
	for key, value := range fixture.Base {
		bounded[key] = value
	}
	bounded["columns"] = ids
	bounded["target"] = map[string]any{"tableId": "parent", "columns": ids}
	if _, err := PhysicalForeignKeyFromValue(bounded); err != nil {
		t.Fatal("valid 64-column FK rejected")
	}
	oversized := append(ids, "column-64")
	bounded["columns"] = oversized
	bounded["target"] = map[string]any{"tableId": "parent", "columns": oversized}
	if _, err := PhysicalForeignKeyFromValue(bounded); err == nil {
		t.Fatal("oversized FK accepted")
	}
	scaleStarted := time.Now()
	retained := make([]*PhysicalForeignKey, 0, 2000)
	for index := 0; index < 2000; index++ {
		value := map[string]any{}
		for key, item := range fixture.Base {
			value[key] = item
		}
		value["id"] = fmt.Sprintf("fk-%d", index)
		value["name"] = fmt.Sprintf("FK.%d", index)
		fk, err := PhysicalForeignKeyFromValue(value)
		if err != nil {
			t.Fatal(err)
		}
		retained = append(retained, fk)
	}
	for index, fk := range retained {
		if fk.Value()["id"] != fmt.Sprintf("fk-%d", index) {
			t.Fatal("lost retained FK")
		}
	}
	t.Logf("PASS physical_fk_retention records=%d elapsed=%s", len(retained), time.Since(scaleStarted))
}
