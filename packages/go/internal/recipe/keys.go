package recipe

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
)

// keysName is the key table of the recipe format, generated from scripts/features/schema/recipe.schema.json (recipe-keys.mts).
const keysName = "recipe-keys.json"

// keyTable holds the keys that the file, each case and each op of the recipe format accept (FCV-2 to FCV-4).
type keyTable struct {
	File []string            `json:"file"`
	Case []string            `json:"case"`
	Step map[string][]string `json:"step"`
}

// loadKeyTable reads the key table beside the recipe schema that the $schema of the recipe at path names (FCV-2).
func loadKeyTable(path, schema string) (*keyTable, error) {
	table := filepath.Join(filepath.Dir(path), filepath.Dir(schema), keysName)
	src, err := os.ReadFile(table)
	if err != nil {
		return nil, err
	}
	var t keyTable
	if err := json.Unmarshal(src, &t); err != nil {
		return nil, fmt.Errorf("recipe key table %s: %w", table, err)
	}
	return &t, nil
}

// unknownKey returns the first key of object, in sorted order, that keys does not hold.
func unknownKey(object map[string]json.RawMessage, keys []string) (string, bool) {
	names := make([]string, 0, len(object))
	for name := range object {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		if !slices.Contains(keys, name) {
			return name, true
		}
	}
	return "", false
}

// checkKeys refuses each file, case or step key of the recipe at path that its key table does not hold, and each op that the
// table does not hold, by name. It runs before any case, so a recipe with an unknown key never passes by skipping it (T334-3-5-6).
func checkKeys(path string, src []byte) error {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(src, &top); err != nil {
		return fmt.Errorf("recipe %s: %w", path, err)
	}
	var schema string
	if err := json.Unmarshal(top["$schema"], &schema); err != nil || schema == "" {
		return fmt.Errorf("recipe %s: no $schema names the recipe key table", path)
	}
	table, err := loadKeyTable(path, schema)
	if err != nil {
		return err
	}
	if key, ok := unknownKey(top, table.File); ok {
		return fmt.Errorf("recipe %s: unknown key %s", path, key)
	}
	var cases []json.RawMessage
	if err := json.Unmarshal(top["cases"], &cases); err != nil {
		return fmt.Errorf("recipe %s: cases: %w", path, err)
	}
	for index, rawCase := range cases {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(rawCase, &object); err != nil {
			return fmt.Errorf("recipe %s case %d: %w", path, index, err)
		}
		var id string
		if err := json.Unmarshal(object["id"], &id); err != nil {
			id = fmt.Sprint(index)
		}
		if key, ok := unknownKey(object, table.Case); ok {
			return fmt.Errorf("recipe %s case %s: unknown key %s", path, id, key)
		}
		var steps []json.RawMessage
		if err := json.Unmarshal(object["steps"], &steps); err != nil {
			return fmt.Errorf("recipe %s case %s: steps: %w", path, id, err)
		}
		for step, rawStep := range steps {
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(rawStep, &fields); err != nil {
				return fmt.Errorf("recipe %s case %s step %d: %w", path, id, step, err)
			}
			var op string
			if err := json.Unmarshal(fields["op"], &op); err != nil {
				return fmt.Errorf("recipe %s case %s step %d: no op: %w", path, id, step, err)
			}
			keys, known := table.Step[op]
			if !known {
				return fmt.Errorf("recipe %s case %s step %d: unknown op %s", path, id, step, op)
			}
			if key, ok := unknownKey(fields, keys); ok {
				return fmt.Errorf("recipe %s case %s step %d (%s): unknown key %s", path, id, step, op, key)
			}
		}
	}
	return nil
}
