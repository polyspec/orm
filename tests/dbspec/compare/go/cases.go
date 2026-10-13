package main

import (
	"fmt"
	"sort"
)

// kind is the type of a field of cases.json: a scalar, an array of a type, or an object of fields.
type kind struct {
	scalar string // "string", "boolean", "integer", "lines" or "linesMap"; empty for an array or an object
	item   *kind  // the item type of an array
	fields []caseField
}

// caseField is a field of an object; an optional field may be absent.
type caseField struct {
	name     string
	optional bool
	kind     kind
}

var (
	stringKind   = kind{scalar: "string"}
	booleanKind  = kind{scalar: "boolean"}
	integerKind  = kind{scalar: "integer"}
	linesKind    = kind{scalar: "lines"}
	linesMapKind = kind{scalar: "linesMap"}
)

func arrayOf(item kind) kind { return kind{item: &item} }

func object(fields ...caseField) kind { return kind{fields: fields} }

func required(name string, k kind) caseField { return caseField{name: name, kind: k} }

func optional(name string, k kind) caseField { return caseField{name: name, optional: true, kind: k} }

// casesSchema is the format of tests/dbspec/cases.json (the Go reader engine/dbspec/vectors_test.go
// decodeCaseVectors reads the same fields).
var casesSchema = func() kind {
	errors := arrayOf(object(required("line", integerKind), required("column", integerKind), required("rule", stringKind)))
	document := []caseField{required("id", stringKind), required("documents", linesMapKind), required("main", stringKind), optional("crlf", booleanKind), optional("mixed", booleanKind)}
	with := func(f caseField) []caseField { return append(append([]caseField{}, document...), f) }
	return object(
		required("version", integerKind),
		required("note", stringKind),
		required("canonical", arrayOf(object(document...))),
		required("normalize", arrayOf(object(with(required("canonical", linesKind))...))),
		required("invalid", arrayOf(object(with(required("errors", errors))...))),
		required("hashes", arrayOf(object(required("id", stringKind), required("documents", linesMapKind), required("manifestText", linesKind),
			required("schemaText", linesKind), required("manifestHash", stringKind), required("schemaHash", stringKind)))),
		required("sets", arrayOf(object(required("id", stringKind), required("documents", arrayOf(linesKind)), required("parsing", linesMapKind),
			required("errors", errors), optional("external", arrayOf(linesKind)),
			optional("manifest", object(required("manifestText", linesKind), required("externalText", linesKind), required("schemaText", linesKind),
				required("created", linesKind), required("manifestHash", stringKind), required("schemaHash", stringKind)))))),
		required("files", arrayOf(object(required("id", stringKind), required("path", stringKind), required("errors", errors)))),
		required("positions", arrayOf(object(required("id", stringKind), required("documents", linesMapKind), required("main", stringKind),
			required("positions", arrayOf(object(required("kind", stringKind), required("path", linesKind), required("line", integerKind), required("column", integerKind))))))),
	)
}()

// sortedKeys gives the keys of object in order, so that the first refused field is the same in every run.
func sortedKeys[T any](object map[string]T) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// check refuses a value of cases.json that is not of type k: a missing field, a field that the format does not name,
// or a value of another type.
func (r vectorReader) check(value any, k kind, location string) error {
	where := location
	if where == "" {
		where = "$"
	}
	switch {
	case k.scalar == "string":
		if _, ok := value.(string); !ok {
			return r.fail(where, "is not a string")
		}
	case k.scalar == "boolean":
		if _, ok := value.(bool); !ok {
			return r.fail(where, "is not a boolean")
		}
	case k.scalar == "integer":
		if n, ok := value.(float64); !ok || n != float64(int(n)) {
			return r.fail(where, "is not an integer")
		}
	case k.scalar == "lines":
		return r.check(value, arrayOf(stringKind), location)
	case k.scalar == "linesMap":
		items, ok := value.(map[string]any)
		if !ok {
			return r.fail(where, "is not an object")
		}
		for _, key := range sortedKeys(items) {
			if err := r.check(items[key], linesKind, at(location, key)); err != nil {
				return err
			}
		}
	case k.item != nil:
		items, ok := value.([]any)
		if !ok {
			return r.fail(where, "is not an array")
		}
		for i, item := range items {
			if err := r.check(item, *k.item, fmt.Sprintf("%s[%d]", location, i)); err != nil {
				return err
			}
		}
	default:
		fields, ok := value.(map[string]any)
		if !ok {
			return r.fail(where, "is not an object")
		}
		known := map[string]bool{}
		for _, f := range k.fields {
			known[f.name] = true
			if _, ok := fields[f.name]; !ok && !f.optional {
				return r.fail(at(location, f.name), "is missing")
			}
		}
		for _, key := range sortedKeys(fields) {
			if !known[key] {
				return r.fail(at(location, key), "is not a known field")
			}
		}
		for _, f := range k.fields {
			if v, ok := fields[f.name]; ok {
				if err := r.check(v, f.kind, at(location, f.name)); err != nil {
					return err
				}
			}
		}
		if known["main"] {
			main := fields["main"].(string)
			if _, ok := fields["documents"].(map[string]any)[main]; !ok {
				return r.fail(at(at(location, "documents"), main), "is missing")
			}
		}
	}
	return nil
}

// checkCases reads cases.json strictly: every section and field of the format is present with its type, a section or
// field that the format does not name is refused, the version is 1 and no section is empty.
func (r vectorReader) checkCases(v map[string]any) error {
	if err := r.check(v, casesSchema, ""); err != nil {
		return err
	}
	if v["version"].(float64) != 1 {
		return r.fail("version", "is not 1")
	}
	for _, f := range casesSchema.fields {
		if items, ok := v[f.name].([]any); ok && len(items) == 0 {
			return r.fail(f.name, "is empty")
		}
	}
	return nil
}
