package schema

import (
	"errors"
	"strings"
	"unicode/utf8"
)

type physicalRecordValidator struct{ bytes int }

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
func (v *physicalRecordValidator) text(value any, min, max int) (string, error) {
	text, ok := value.(string)
	if !ok || len(text) < min || len(text) > max || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return "", errors.New("SCHEMA_INVALID")
	}
	v.bytes += len(text)
	if v.bytes > 65536 {
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
func (v *physicalRecordValidator) id(value any) (string, error) {
	id, err := v.text(value, 1, 128)
	if err != nil || !physicalStableID(id) {
		return "", errors.New("SCHEMA_INVALID")
	}
	return id, nil
}
func (v *physicalRecordValidator) ids(value any) ([]any, error) {
	ids, ok := value.([]any)
	if !ok || len(ids) < 1 || len(ids) > 64 {
		return nil, errors.New("SCHEMA_INVALID")
	}
	seen := map[string]bool{}
	for _, value := range ids {
		id, err := v.id(value)
		if err != nil || seen[id] {
			return nil, errors.New("SCHEMA_INVALID")
		}
		seen[id] = true
	}
	return ids, nil
}
func (v *physicalRecordValidator) options(value any) error {
	options, ok := value.([]any)
	if !ok || options == nil || len(options) > 64 {
		return errors.New("SCHEMA_INVALID")
	}
	for _, option := range options {
		entry, err := physicalObject(option, "name", "value")
		if err != nil {
			return err
		}
		if _, err = v.text(entry["name"], 1, 128); err != nil {
			return err
		}
		if _, err = v.text(entry["value"], 0, 4096); err != nil {
			return err
		}
	}
	return nil
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
