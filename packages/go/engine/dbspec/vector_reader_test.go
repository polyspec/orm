package dbspec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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

// fieldObject returns the object that the key of object holds; a key that is not an
// object fails.
func (r vectorReader) fieldObject(object map[string]any, location, key string) (map[string]any, error) {
	value, err := r.field(object, location, key)
	if err != nil {
		return nil, err
	}
	items, ok := value.(map[string]any)
	if !ok {
		return nil, r.fail(vectorAt(location, key), "is not an object")
	}
	return items, nil
}

// linesMap returns an object whose each name holds an array of strings.
func (r vectorReader) linesMap(object map[string]any, location, key string) (map[string][]string, error) {
	items, err := r.fieldObject(object, location, key)
	if err != nil {
		return nil, err
	}
	out := make(map[string][]string, len(items))
	for name, item := range items {
		if out[name], err = r.lines(item, vectorAt(vectorAt(location, key), name)); err != nil {
			return nil, err
		}
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
