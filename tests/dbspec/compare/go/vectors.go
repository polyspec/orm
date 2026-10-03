package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// vectorError는 vector file의 위치와 문제를 밝힌다.
type vectorError struct {
	path     string
	location string
	problem  string
}

func (e *vectorError) Error() string {
	return fmt.Sprintf("%s: %s %s", e.path, e.location, e.problem)
}

// vectorReader는 한 vector file의 값을 위치를 밝히며 읽는다.
type vectorReader struct {
	path string
}

// readVectors는 vector file을 JSON object로 읽어 그 reader와 함께 돌려준다.
func readVectors(path string) (vectorReader, map[string]any, error) {
	r := vectorReader{path: path}
	raw, err := os.ReadFile(path)
	if err != nil {
		return r, nil, err
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return r, nil, fmt.Errorf("%s: %w", path, err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return r, nil, r.fail("$", "is not an object")
	}
	return r, object, nil
}

func (r vectorReader) fail(location, problem string) error {
	return &vectorError{path: r.path, location: location, problem: problem}
}

func at(location, key string) string {
	if location == "" {
		return key
	}
	return location + "." + key
}

// field는 object의 key 값을 돌려주고, key가 없으면 error를 돌려준다.
func (r vectorReader) field(object map[string]any, location, key string) (any, error) {
	value, ok := object[key]
	if !ok {
		return nil, r.fail(at(location, key), "is missing")
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
		return "", r.fail(at(location, key), "is not a string")
	}
	return s, nil
}

// flag는 key가 없으면 false를, 있으면 boolean인지 확인한 값을 돌려준다.
func (r vectorReader) flag(object map[string]any, location, key string) (bool, error) {
	value, ok := object[key]
	if !ok {
		return false, nil
	}
	b, ok := value.(bool)
	if !ok {
		return false, r.fail(at(location, key), "is not a boolean")
	}
	return b, nil
}

// lines는 value가 string의 array인지 확인해 돌려준다.
func (r vectorReader) lines(value any, location string) ([]string, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, r.fail(location, "is not an array")
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
	return r.lines(value, at(location, key))
}

// documents는 이름마다 line array를 가진 object를 돌려준다.
func (r vectorReader) documents(object map[string]any, location, key string) (map[string][]string, error) {
	value, err := r.field(object, location, key)
	if err != nil {
		return nil, err
	}
	items, ok := value.(map[string]any)
	if !ok {
		return nil, r.fail(at(location, key), "is not an object")
	}
	documents := make(map[string][]string, len(items))
	for name, item := range items {
		lines, err := r.lines(item, at(at(location, key), name))
		if err != nil {
			return nil, err
		}
		documents[name] = lines
	}
	return documents, nil
}

// cases는 section key의 각 case가 object인지와 그 id를 확인하고 read로 case를 읽는다.
func cases[T any](r vectorReader, object map[string]any, key string, read func(c map[string]any, location, id string) (T, error)) ([]T, error) {
	value, err := r.field(object, "", key)
	if err != nil {
		return nil, err
	}
	items, ok := value.([]any)
	if !ok {
		return nil, r.fail(key, "is not an array")
	}
	result := make([]T, len(items))
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
		if result[i], err = read(c, location, id); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// readCases는 tests/dbspec/cases.json을 읽는다.
func readCases(path string) (sharedCases, error) {
	r, v, err := readVectors(path)
	if err != nil {
		return sharedCases{}, err
	}
	readCase := func(c map[string]any, location, id string) (testCase, error) {
		t := testCase{ID: id}
		var err error
		if t.Main, err = r.string(c, location, "main"); err != nil {
			return t, err
		}
		if t.Documents, err = r.documents(c, location, "documents"); err != nil {
			return t, err
		}
		if _, ok := t.Documents[t.Main]; !ok {
			return t, r.fail(at(at(location, "documents"), t.Main), "is missing")
		}
		if t.CRLF, err = r.flag(c, location, "crlf"); err != nil {
			return t, err
		}
		t.Mixed, err = r.flag(c, location, "mixed")
		return t, err
	}
	var all sharedCases
	if all.Canonical, err = cases(r, v, "canonical", readCase); err != nil {
		return all, err
	}
	if all.Normalize, err = cases(r, v, "normalize", readCase); err != nil {
		return all, err
	}
	if all.Invalid, err = cases(r, v, "invalid", readCase); err != nil {
		return all, err
	}
	if all.Hashes, err = cases(r, v, "hashes", r.hashCase); err != nil {
		return all, err
	}
	all.Files, err = cases(r, v, "files", func(c map[string]any, location, id string) (fileCase, error) {
		path, err := r.string(c, location, "path")
		return fileCase{ID: id, Path: path}, err
	})
	return all, err
}

// hashCase는 id와 documents만 가진 case를 읽는다.
func (r vectorReader) hashCase(c map[string]any, location, id string) (hashCase, error) {
	documents, err := r.documents(c, location, "documents")
	return hashCase{ID: id, Documents: documents}, err
}

// readDDL은 tests/dbspec/ddl.json의 cases를 읽는다.
func readDDL(path string) ([]hashCase, error) {
	r, v, err := readVectors(path)
	if err != nil {
		return nil, err
	}
	return cases(r, v, "cases", r.hashCase)
}

// readPlans는 tests/dbspec/plans.json을 읽는다. source는 빈 schema를 뜻하는 null이거나 line array이다.
func readPlans(path string) (planVectors, error) {
	r, v, err := readVectors(path)
	if err != nil {
		return planVectors{}, err
	}
	readPlanCase := func(c map[string]any, location, id string) (planCase, error) {
		p := planCase{ID: id}
		source, err := r.field(c, location, "source")
		if err != nil {
			return p, err
		}
		if source != nil {
			lines, err := r.lines(source, at(location, "source"))
			if err != nil {
				return p, err
			}
			p.Source = &lines
		}
		p.Plan, err = r.linesField(c, location, "plan")
		return p, err
	}
	var plans planVectors
	if plans.Cases, err = cases(r, v, "cases", readPlanCase); err != nil {
		return plans, err
	}
	if plans.Invalid, err = cases(r, v, "invalid", readPlanCase); err != nil {
		return plans, err
	}
	plans.Chains, err = cases(r, v, "chains", func(c map[string]any, location, id string) (chainCase, error) {
		chain := chainCase{ID: id}
		value, err := r.field(c, location, "plans")
		if err != nil {
			return chain, err
		}
		items, ok := value.([]any)
		if !ok {
			return chain, r.fail(at(location, "plans"), "is not an array")
		}
		for i, item := range items {
			lines, err := r.lines(item, fmt.Sprintf("%s[%d]", at(location, "plans"), i))
			if err != nil {
				return chain, err
			}
			chain.Plans = append(chain.Plans, lines)
		}
		return chain, nil
	})
	if err != nil {
		return plans, err
	}
	plans.Parse, err = cases(r, v, "parse", func(c map[string]any, location, id string) (parseCase, error) {
		plan, err := r.linesField(c, location, "plan")
		return parseCase{ID: id, Plan: plan}, err
	})
	if err != nil {
		return plans, err
	}
	plans.Comparisons, err = cases(r, v, "comparisons", func(c map[string]any, location, id string) (comparisonCase, error) {
		comparison := comparisonCase{ID: id}
		var err error
		if comparison.Source, err = r.linesField(c, location, "source"); err != nil {
			return comparison, err
		}
		comparison.Target, err = r.linesField(c, location, "target")
		return comparison, err
	})
	return plans, err
}

// readMermaid는 tests/dbspec/mermaid.json을 읽는다.
func readMermaid(path string) (mermaidVectors, error) {
	r, v, err := readVectors(path)
	if err != nil {
		return mermaidVectors{}, err
	}
	var mermaid mermaidVectors
	mermaid.Export, err = cases(r, v, "export", func(c map[string]any, location, id string) (exportCase, error) {
		e := exportCase{ID: id}
		var err error
		if e.Document, err = r.linesField(c, location, "document"); err != nil {
			return e, err
		}
		e.Documents, err = r.documents(c, location, "documents")
		return e, err
	})
	if err != nil {
		return mermaid, err
	}
	readImport := func(c map[string]any, location, id string) (importCase, error) {
		lines, err := r.linesField(c, location, "mermaid")
		return importCase{ID: id, Mermaid: lines}, err
	}
	if mermaid.Import, err = cases(r, v, "import", readImport); err != nil {
		return mermaid, err
	}
	if mermaid.Invalid, err = cases(r, v, "invalid", readImport); err != nil {
		return mermaid, err
	}
	mermaid.RoundTrip, err = cases(r, v, "round_trip", func(c map[string]any, location, id string) (roundTripCase, error) {
		path, err := r.string(c, location, "path")
		return roundTripCase{ID: id, Path: path}, err
	})
	return mermaid, err
}
