package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
)

// The vector files are read against their JSON Schemas (tests/dbspec/schema, draft 2020-12), the schemas that the
// TypeScript runner reads them with (tests/dbspec/vectors.mts). A refused file is reported in the form that every compare
// runner shares (tests/dbspec/compare/runners.test.mts): one "<file>: <location> <problem>" line per refusal, where the
// location is the dotted path of the value (`canonical[0].documents.shop`).

// schemaDirectory is tests/dbspec/schema of the working directory, the root of the checkout, where the usage
// `go run ./packages/go/internal/dbspec/compare` runs this runner.
func schemaDirectory() (string, error) {
	root, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "tests", "dbspec", "schema"), nil
}

// vectorError is a vector file that cannot be read or that its schema refuses: one line per problem.
type vectorError struct {
	lines []string
}

func (e *vectorError) Error() string {
	return strings.Join(e.lines, "\n")
}

// vectorReader names the places of one vector file.
type vectorReader struct {
	path string
}

func (r vectorReader) fail(location, problem string) error {
	return &vectorError{lines: []string{fmt.Sprintf("%s: %s %s", r.path, location, problem)}}
}

// readVectors reads the vector file at path, checks it against the schema `name` and decodes it into value.
func readVectors(path, name string, value any) (vectorReader, error) {
	r := vectorReader{path: path}
	raw, err := os.ReadFile(path)
	if err != nil {
		return r, err
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return r, fmt.Errorf("%s: %w", path, err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	directory, err := schemaDirectory()
	if err != nil {
		return r, err
	}
	schema, err := compiler.Compile(filepath.Join(directory, name+".schema.json"))
	if err != nil {
		return r, err
	}
	if err := schema.Validate(instance); err != nil {
		var refused *jsonschema.ValidationError
		if !errors.As(err, &refused) {
			return r, fmt.Errorf("%s: %w", path, err)
		}
		var lines []string
		for _, leaf := range leaves(refused) {
			found, err := problems(leaf)
			if err != nil {
				return r, fmt.Errorf("%s: %w", path, err)
			}
			for _, p := range found {
				lines = append(lines, fmt.Sprintf("%s: %s", path, p))
			}
		}
		return r, &vectorError{lines: lines}
	}
	if err := json.Unmarshal(raw, value); err != nil {
		return r, fmt.Errorf("%s: %w", path, err)
	}
	return r, nil
}

// leaves are the refusals of a validation error that hold no nested error: the keywords that refused a value.
func leaves(e *jsonschema.ValidationError) []*jsonschema.ValidationError {
	if len(e.Causes) == 0 {
		return []*jsonschema.ValidationError{e}
	}
	var all []*jsonschema.ValidationError
	for _, cause := range e.Causes {
		all = append(all, leaves(cause)...)
	}
	return all
}

var index = regexp.MustCompile(`^\d+$`)

// location is the dotted path of an instance location: object keys joined with ".", array indexes in brackets.
func location(segments []string, property ...string) string {
	path := ""
	for _, segment := range append(append([]string{}, segments...), property...) {
		switch {
		case index.MatchString(segment):
			path += "[" + segment + "]"
		case path == "":
			path = segment
		default:
			path += "." + segment
		}
	}
	return path
}

var articles = map[string]string{"integer": "an integer", "object": "an object", "array": "an array", "string": "a string", "boolean": "a boolean", "number": "a number", "null": "null"}

// problems is the shared form of one refusal: the location of each value it refuses and what is wrong there.
func problems(e *jsonschema.ValidationError) ([]string, error) {
	at := e.InstanceLocation
	switch k := e.ErrorKind.(type) {
	case *kind.Required:
		var lines []string
		for _, missing := range k.Missing {
			lines = append(lines, location(at, missing)+" is missing")
		}
		return lines, nil
	case *kind.AdditionalProperties:
		var lines []string
		for _, property := range k.Properties {
			lines = append(lines, location(at, property)+" is not a known field")
		}
		return lines, nil
	case *kind.FalseSchema:
		if strings.HasSuffix(e.SchemaURL, "/unevaluatedProperties") {
			return []string{location(at) + " is not a known field"}, nil
		}
	case *kind.Type:
		words := make([]string, len(k.Want))
		for i, want := range k.Want {
			words[i] = want
			if article, ok := articles[want]; ok {
				words[i] = article
			}
		}
		return []string{location(at) + " is not " + strings.Join(words, " or ")}, nil
	case *kind.MinItems:
		return []string{location(at) + " is empty"}, nil
	case *kind.Const:
		want, err := json.Marshal(k.Want)
		if err != nil {
			return nil, fmt.Errorf("%s: the const value of the schema: %w", location(at), err)
		}
		return []string{location(at) + " is not " + string(want)}, nil
	}
	keyword := strings.Join(e.ErrorKind.KeywordPath(), "/")
	return []string{fmt.Sprintf("%s fails the %s rule of its schema: %s", location(at), keyword, e.Error())}, nil
}
