package dbspec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// vectorReader reads one value of a tests/dbspec vector file, with its location. A value that is missing or
// of the wrong type is a "<file>: <location> <problem>" error.
type vectorReader struct {
	path string
}

// readVectorFile reads tests/dbspec/<name> as a JSON object.
func readVectorFile(t *testing.T, name string) (vectorReader, map[string]any) {
	t.Helper()
	r := vectorReader{path: filepath.Join("tests", "dbspec", name)}
	raw, err := os.ReadFile(filepath.Join(repositoryRoot(t), r.path))
	if err != nil {
		t.Fatal(err)
	}
	object, err := r.object(raw)
	if err != nil {
		t.Fatal(err)
	}
	return r, object
}

// object checks that raw is a JSON object and returns it.
func (r vectorReader) object(raw []byte) (map[string]any, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%s: %w", r.path, err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, r.fail("$", "is not an object")
	}
	return object, nil
}

func (r vectorReader) fail(location, problem string) error {
	return fmt.Errorf("%s: %s %s", r.path, location, problem)
}

func vectorAt(location, key string) string {
	if location == "" {
		return key
	}
	return location + "." + key
}

// fields reports a missing required field or an unknown field of object: a field that is
// neither required nor optional.
func (r vectorReader) fields(object map[string]any, location string, required []string, optional ...string) error {
	allowed := map[string]bool{}
	for _, k := range optional {
		allowed[k] = true
	}
	for _, k := range required {
		allowed[k] = true
		if _, ok := object[k]; !ok {
			return r.fail(vectorAt(location, k), "is missing")
		}
	}
	names := make([]string, 0, len(object))
	for k := range object {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		if !allowed[k] {
			return r.fail(vectorAt(location, k), "is not a known field")
		}
	}
	return nil
}

// field returns the value of the object's key; if the key is missing, it is an error.
func (r vectorReader) field(object map[string]any, location, key string) (any, error) {
	value, ok := object[key]
	if !ok {
		return nil, r.fail(vectorAt(location, key), "is missing")
	}
	return value, nil
}

func (r vectorReader) string(object map[string]any, location, key string) (string, error) {
	value, err := r.field(object, location, key)
	if err != nil {
		return "", err
	}
	s, ok := value.(string)
	if !ok {
		return "", r.fail(vectorAt(location, key), "is not a string")
	}
	return s, nil
}

// integer checks that the value is a number that is an integer, and returns it.
func (r vectorReader) integer(value any, location string) (int, error) {
	n, ok := value.(float64)
	if !ok || n != float64(int(n)) {
		return 0, r.fail(location, "is not an integer")
	}
	return int(n), nil
}

func (r vectorReader) integerField(object map[string]any, location, key string) (int, error) {
	value, err := r.field(object, location, key)
	if err != nil {
		return 0, err
	}
	return r.integer(value, vectorAt(location, key))
}

// flag returns false if the key is missing, and otherwise the value, after checking that it is a boolean.
func (r vectorReader) flag(object map[string]any, location, key string) (bool, error) {
	value, ok := object[key]
	if !ok {
		return false, nil
	}
	b, ok := value.(bool)
	if !ok {
		return false, r.fail(vectorAt(location, key), "is not a boolean")
	}
	return b, nil
}

func (r vectorReader) array(value any, location string) ([]any, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, r.fail(location, "is not an array")
	}
	return items, nil
}

func (r vectorReader) arrayField(object map[string]any, location, key string) ([]any, error) {
	value, err := r.field(object, location, key)
	if err != nil {
		return nil, err
	}
	return r.array(value, vectorAt(location, key))
}

// lines checks that the value is an array of strings and returns it. An empty array is an empty slice.
func (r vectorReader) lines(value any, location string) ([]string, error) {
	items, err := r.array(value, location)
	if err != nil {
		return nil, err
	}
	lines := make([]string, len(items))
	for i, item := range items {
		line, ok := item.(string)
		if !ok {
			return nil, r.fail(fmt.Sprintf("%s[%d]", location, i), "is not a string")
		}
		lines[i] = line
	}
	return lines, nil
}

func (r vectorReader) linesField(object map[string]any, location, key string) ([]string, error) {
	value, err := r.field(object, location, key)
	if err != nil {
		return nil, err
	}
	return r.lines(value, vectorAt(location, key))
}

// nullableLines returns nil if the value is null, and otherwise an array of strings. The key must exist.
func (r vectorReader) nullableLines(object map[string]any, location, key string) ([]string, error) {
	value, err := r.field(object, location, key)
	if err != nil || value == nil {
		return nil, err
	}
	return r.lines(value, vectorAt(location, key))
}

// linesMap returns an object whose each name holds an array of strings.
func (r vectorReader) linesMap(object map[string]any, location, key string) (map[string][]string, error) {
	value, err := r.field(object, location, key)
	if err != nil {
		return nil, err
	}
	items, ok := value.(map[string]any)
	if !ok {
		return nil, r.fail(vectorAt(location, key), "is not an object")
	}
	out := make(map[string][]string, len(items))
	for name, item := range items {
		if out[name], err = r.lines(item, vectorAt(vectorAt(location, key), name)); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// stepsMap returns an object that holds, per dialect, an array of step objects. A step object
// has statement and effect strings, and only the keys of docs/spec/plans.md "Steps".
func (r vectorReader) stepsMap(object map[string]any, location, key string) (map[string][]any, error) {
	value, err := r.field(object, location, key)
	if err != nil {
		return nil, err
	}
	items, ok := value.(map[string]any)
	if !ok {
		return nil, r.fail(vectorAt(location, key), "is not an object")
	}
	allowed := map[string]bool{"statement": true, "rollback": true, "irreversible": true, "effect": true, "restore": true, "rollback_restore": true, "restore_if": true, "null_checks": true, "finalize": true}
	out := make(map[string][]any, len(items))
	for name, item := range items {
		at := vectorAt(vectorAt(location, key), name)
		steps, err := r.array(item, at)
		if err != nil {
			return nil, err
		}
		for i, step := range steps {
			stepAt := fmt.Sprintf("%s[%d]", at, i)
			fields, ok := step.(map[string]any)
			if !ok {
				return nil, r.fail(stepAt, "is not an object")
			}
			for k := range fields {
				if !allowed[k] {
					return nil, r.fail(stepAt, "has the unknown key "+k)
				}
			}
			for _, k := range []string{"statement", "effect"} {
				if _, err := r.string(fields, stepAt, k); err != nil {
					return nil, err
				}
			}
		}
		out[name] = steps
	}
	return out, nil
}

// triples returns an array of arrays of three strings: [kind, table, name].
func (r vectorReader) triples(object map[string]any, location, key string) ([][3]string, error) {
	items, err := r.arrayField(object, location, key)
	if err != nil {
		return nil, err
	}
	out := make([][3]string, len(items))
	for i, item := range items {
		at := fmt.Sprintf("%s[%d]", vectorAt(location, key), i)
		lines, err := r.lines(item, at)
		if err != nil {
			return nil, err
		}
		if len(lines) != 3 {
			return nil, r.fail(at, "does not have 3 strings")
		}
		out[i] = [3]string(lines)
	}
	return out, nil
}

// diagnostics returns an array of arrays: [rule, line, column, message] if width is 4, and [rule, line,
// column] if 3. message is a string or null, and line and column are
// kept as the numbers decoded for JSON comparison.
func (r vectorReader) diagnostics(object map[string]any, location, key string, width int) ([][]any, error) {
	items, err := r.arrayField(object, location, key)
	if err != nil {
		return nil, err
	}
	out := make([][]any, len(items))
	for i, item := range items {
		at := fmt.Sprintf("%s[%d]", vectorAt(location, key), i)
		parts, err := r.array(item, at)
		if err != nil {
			return nil, err
		}
		if len(parts) != width {
			return nil, r.fail(at, fmt.Sprintf("does not have %d items", width))
		}
		if _, ok := parts[0].(string); !ok {
			return nil, r.fail(at+"[0]", "is not a string")
		}
		for k := 1; k <= 2; k++ {
			if _, err := r.integer(parts[k], fmt.Sprintf("%s[%d]", at, k)); err != nil {
				return nil, err
			}
		}
		if width == 4 {
			if _, ok := parts[3].(string); !ok && parts[3] != nil {
				return nil, r.fail(at+"[3]", "is not a string or null")
			}
		}
		out[i] = parts
	}
	return out, nil
}

// vectorCases checks that each case under a section key is an object, checks its id, and reads it with read.
// An empty section is an error.
func vectorCases[T any](r vectorReader, object map[string]any, key string, read func(c map[string]any, location, id string) (T, error)) ([]T, error) {
	items, err := r.arrayField(object, "", key)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, r.fail(key, "is empty")
	}
	out := make([]T, len(items))
	for i, item := range items {
		location := fmt.Sprintf("%s[%d]", key, i)
		c, ok := item.(map[string]any)
		if !ok {
			return nil, r.fail(location, "is not an object")
		}
		id, err := r.string(c, location, "id")
		if err != nil {
			return nil, err
		}
		if out[i], err = read(c, location, id); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// version checks that the vector file's version is 1.
func (r vectorReader) version(object map[string]any) error {
	version, err := r.integerField(object, "", "version")
	if err != nil {
		return err
	}
	if version != 1 {
		return r.fail("version", "is not 1")
	}
	return nil
}

// locatedErrors returns an array of {line, column, rule} objects.
func (r vectorReader) locatedErrors(object map[string]any, location, key string) ([]vectorError, error) {
	items, err := r.arrayField(object, location, key)
	if err != nil {
		return nil, err
	}
	out := make([]vectorError, len(items))
	for i, item := range items {
		at := fmt.Sprintf("%s[%d]", vectorAt(location, key), i)
		e, ok := item.(map[string]any)
		if !ok {
			return nil, r.fail(at, "is not an object")
		}
		if err := r.fields(e, at, []string{"line", "column", "rule"}); err != nil {
			return nil, err
		}
		if out[i].Line, err = r.integerField(e, at, "line"); err != nil {
			return nil, err
		}
		if out[i].Column, err = r.integerField(e, at, "column"); err != nil {
			return nil, err
		}
		if out[i].Rule, err = r.string(e, at, "rule"); err != nil {
			return nil, err
		}
	}
	return out, nil
}
