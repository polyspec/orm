package schema

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// PhysicalColumn is structural data only, not SQL execution permission.
type PhysicalColumn struct{ value map[string]any }
type physicalColumnValidator struct{ bytes int }

func physicalObject(value any, fields ...string) (map[string]any, error) {
	object, ok := value.(map[string]any)
	if !ok || len(object) != len(fields) {
		return nil, errors.New("SCHEMA_INVALID")
	}
	for _, field := range fields {
		if _, ok := object[field]; !ok {
			return nil, errors.New("SCHEMA_INVALID")
		}
	}
	return object, nil
}
func (validator *physicalColumnValidator) text(value any, min, max int) (string, error) {
	text, ok := value.(string)
	if !ok || len(text) < min || len(text) > max || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return "", errors.New("SCHEMA_INVALID")
	}
	validator.bytes += len(text)
	if validator.bytes > 65536 {
		return "", errors.New("SCHEMA_INVALID")
	}
	return text, nil
}
func physicalStableID(id string) bool {
	for _, r := range id {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func PhysicalColumnFromValue(value map[string]any) (*PhysicalColumn, error) {
	object, err := physicalObject(value, "id", "name", "typeSql", "nullable", "default", "generation", "comment", "options")
	if err != nil {
		return nil, err
	}
	validator := physicalColumnValidator{}
	id, err := validator.text(object["id"], 1, 128)
	if err != nil || !physicalStableID(id) {
		return nil, errors.New("SCHEMA_INVALID")
	}
	name, err := validator.text(object["name"], 1, 1024)
	if err != nil {
		return nil, err
	}
	if _, err = NewPhysicalIdentity(nil, nil, name, nil); err != nil {
		return nil, err
	}
	if _, err = validator.text(object["typeSql"], 1, 4096); err != nil {
		return nil, err
	}
	if _, ok := object["nullable"].(bool); !ok {
		return nil, errors.New("SCHEMA_INVALID")
	}
	if _, err = validator.text(object["comment"], 0, 8192); err != nil {
		return nil, err
	}
	def, ok := object["default"].(map[string]any)
	if !ok {
		return nil, errors.New("SCHEMA_INVALID")
	}
	kind, err := validator.text(def["kind"], 1, 16)
	if err != nil {
		return nil, err
	}
	switch kind {
	case "absent", "null":
		if _, err = physicalObject(def, "kind"); err != nil {
			return nil, err
		}
	case "literal", "expression":
		if _, err = physicalObject(def, "kind", "sql"); err != nil {
			return nil, err
		}
		if _, err = validator.text(def["sql"], 1, 16384); err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("SCHEMA_INVALID")
	}
	generation, ok := object["generation"].(map[string]any)
	if !ok {
		return nil, errors.New("SCHEMA_INVALID")
	}
	kind, err = validator.text(generation["kind"], 1, 16)
	if err != nil {
		return nil, err
	}
	switch kind {
	case "none":
		if _, err = physicalObject(generation, "kind"); err != nil {
			return nil, err
		}
	case "identity":
		if _, err = physicalObject(generation, "kind", "sql"); err != nil {
			return nil, err
		}
		if _, err = validator.text(generation["sql"], 1, 16384); err != nil {
			return nil, err
		}
	case "computed":
		if _, err = physicalObject(generation, "kind", "sql", "storage"); err != nil {
			return nil, err
		}
		if _, err = validator.text(generation["sql"], 1, 16384); err != nil {
			return nil, err
		}
		storage, e := validator.text(generation["storage"], 1, 16)
		if e != nil || !(storage == "stored" || storage == "virtual" || storage == "unspecified") {
			return nil, errors.New("SCHEMA_INVALID")
		}
	default:
		return nil, errors.New("SCHEMA_INVALID")
	}
	options, ok := object["options"].([]any)
	if !ok || options == nil || len(options) > 64 {
		return nil, errors.New("SCHEMA_INVALID")
	}
	for _, option := range options {
		entry, e := physicalObject(option, "name", "value")
		if e != nil {
			return nil, e
		}
		if _, err = validator.text(entry["name"], 1, 128); err != nil {
			return nil, err
		}
		if _, err = validator.text(entry["value"], 0, 4096); err != nil {
			return nil, err
		}
	}
	return &PhysicalColumn{value: clonePhysicalValue(object).(map[string]any)}, nil
}
func clonePhysicalValue(value any) any {
	switch value := value.(type) {
	case map[string]any:
		copy := make(map[string]any, len(value))
		for key, item := range value {
			copy[key] = clonePhysicalValue(item)
		}
		return copy
	case []any:
		copy := make([]any, len(value))
		for i, item := range value {
			copy[i] = clonePhysicalValue(item)
		}
		return copy
	default:
		return value
	}
}
func (column *PhysicalColumn) Value() map[string]any {
	return clonePhysicalValue(column.value).(map[string]any)
}
