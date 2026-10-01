package dbspec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// vectorReader는 tests/dbspec vector file 하나의 값을 위치를 밝히며 읽는다. 없거나
// type이 다른 값은 "<file>: <location> <problem>" error다.
type vectorReader struct {
	path string
}

// readVectorFile은 tests/dbspec/<name>을 JSON object로 읽는다.
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

// object는 raw가 JSON object인지 확인해 돌려준다.
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

// field는 object의 key 값을 돌려주고, key가 없으면 error다.
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

// integer는 value가 정수인 number인지 확인해 돌려준다.
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

// flag는 key가 없으면 false를, 있으면 boolean인지 확인한 값을 돌려준다.
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

// lines는 value가 string array인지 확인해 돌려준다. 빈 array는 빈 slice다.
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

// nullableLines는 null이면 nil을, 아니면 string array를 돌려준다. key는 있어야 한다.
func (r vectorReader) nullableLines(object map[string]any, location, key string) ([]string, error) {
	value, err := r.field(object, location, key)
	if err != nil || value == nil {
		return nil, err
	}
	return r.lines(value, vectorAt(location, key))
}

// linesMap은 이름마다 string array를 가진 object를 돌려준다.
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

// triples는 [kind, table, name] string 세 개짜리 array의 array를 돌려준다.
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

// diagnostics는 width가 4이면 [rule, line, column, message], 3이면 [rule, line,
// column] array의 array를 돌려준다. message는 string이거나 null이고, line과 column은
// JSON 비교를 위해 decode한 number 그대로 둔다.
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

// vectorCases는 section key의 각 case가 object인지와 그 id를 확인하고 read로 읽는다.
// 빈 section은 error다.
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

// version은 vector file의 version이 1인지 확인한다.
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

// locatedErrors는 {line, column, rule} object의 array를 돌려준다.
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
