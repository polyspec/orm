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
