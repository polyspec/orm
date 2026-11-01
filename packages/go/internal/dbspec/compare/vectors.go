package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The vector files as their schemas declare them (tests/dbspec/schema); readVectors has checked every field before it
// decodes one, so these readers check only what a schema cannot state.

type caseFile struct {
	Canonical []documentCase `json:"canonical"`
	Normalize []documentCase `json:"normalize"`
	Invalid   []documentCase `json:"invalid"`
	Hashes    []hashCase     `json:"hashes"`
	Files     []fileCase     `json:"files"`
	Sets      []struct {
		ID        string              `json:"id"`
		Documents [][]string          `json:"documents"`
		Parsing   map[string][]string `json:"parsing"`
		External  [][]string          `json:"external"`
	} `json:"sets"`
	Positions []documentCase `json:"positions"`
}

type documentCase struct {
	ID        string              `json:"id"`
	Main      string              `json:"main"`
	Documents map[string][]string `json:"documents"`
	CRLF      bool                `json:"crlf"`
	Mixed     bool                `json:"mixed"`
}

// readCases reads tests/dbspec/cases.json against its schema, then refuses a case whose main document is not one of
// its documents and a sets document whose header names no document, which the schema cannot state.
func readCases(path string) (sharedCases, error) {
	var file caseFile
	r, err := readVectors(path, "cases", &file)
	if err != nil {
		return sharedCases{}, err
	}
	for _, section := range []struct {
		name  string
		cases []documentCase
	}{{"canonical", file.Canonical}, {"normalize", file.Normalize}, {"invalid", file.Invalid}, {"positions", file.Positions}} {
		for i, c := range section.cases {
			if _, ok := c.Documents[c.Main]; !ok {
				return sharedCases{}, r.fail(fmt.Sprintf("%s[%d].documents.%s", section.name, i, c.Main), "is missing")
			}
		}
	}
	all := sharedCases{Hashes: file.Hashes, Files: file.Files}
	for _, section := range []struct {
		cases []documentCase
		into  *[]testCase
	}{{file.Canonical, &all.Canonical}, {file.Normalize, &all.Normalize}, {file.Invalid, &all.Invalid}} {
		for _, c := range section.cases {
			*section.into = append(*section.into, testCase(c))
		}
	}
	for i, c := range file.Sets {
		s := setCase{ID: c.ID, Parsing: c.Parsing}
		if s.Documents, err = r.namedDocuments(c.Documents, fmt.Sprintf("sets[%d].documents", i)); err != nil {
			return all, err
		}
		if s.External, err = r.namedDocuments(c.External, fmt.Sprintf("sets[%d].external", i)); err != nil {
			return all, err
		}
		all.Sets = append(all.Sets, s)
	}
	for _, c := range file.Positions {
		all.Positions = append(all.Positions, positionCase{ID: c.ID, Main: c.Main, Documents: c.Documents})
	}
	return all, nil
}

// namedDocuments names each document of a sets case by its header; a header that names no document is refused.
func (r vectorReader) namedDocuments(documents [][]string, location string) ([]namedDocument, error) {
	named := make([]namedDocument, len(documents))
	for i, lines := range documents {
		name, ok := headerName(lines)
		if !ok {
			return nil, r.fail(fmt.Sprintf("%s[%d][0]", location, i), "has no document name")
		}
		named[i] = namedDocument{Name: name, Lines: lines}
	}
	return named, nil
}

// headerName is the third word of the first line, the document name of a dbspec header, split at single spaces.
func headerName(lines []string) (string, bool) {
	if len(lines) == 0 {
		return "", false
	}
	words := strings.Split(lines[0], " ")
	if len(words) < 3 {
		return "", false
	}
	return words[2], true
}

// readSyntax reads the case ids of tests/dbspec/syntax.json in file order. The expected tokens are the runtime
// tests' to check; this runner compares what each client gives.
func readSyntax(path string) (vectorReader, []string, error) {
	var file struct {
		Cases []struct {
			ID string `json:"id"`
		} `json:"cases"`
	}
	r, err := readVectors(path, "syntax", &file)
	if err != nil {
		return r, nil, err
	}
	ids := make([]string, len(file.Cases))
	for i, c := range file.Cases {
		ids[i] = c.ID
	}
	return r, ids, nil
}

// readDDL reads the cases of tests/dbspec/ddl.json.
func readDDL(path string) ([]hashCase, error) {
	var file struct {
		Cases []hashCase `json:"cases"`
	}
	_, err := readVectors(path, "ddl", &file)
	return file.Cases, err
}

// readPlans reads tests/dbspec/plans.json. A null source is the empty schema.
func readPlans(path string) (planVectors, error) {
	var plans planVectors
	_, err := readVectors(path, "plans", &plans)
	return plans, err
}

// mermaidRecipe is tests/dbspec/mermaid.json, a recipe of the dbspec.export_mermaid and dbspec.import_mermaid ops
// (docs/spec/feature-coverage.md, FCV-4). The recipe schema has checked every field before it decodes one.
type mermaidRecipe struct {
	Cases []mermaidCase `json:"cases"`
}

type mermaidCase struct {
	ID    string        `json:"id"`
	Steps []mermaidStep `json:"steps"`
}

// mermaidStep holds the fields that the two Mermaid ops read; a field that the op does not use is left empty.
type mermaidStep struct {
	Op         string            `json:"op"`
	Document   string            `json:"document"`
	Documents  map[string]string `json:"documents"`
	Path       string            `json:"path"`
	As         string            `json:"as"`
	Mermaid    json.RawMessage   `json:"mermaid"`
	Name       string            `json:"name"`
	SkeletonOf string            `json:"skeleton_of"`
	Expect     struct {
		None struct {
			Value map[string]json.RawMessage `json:"value"`
		} `json:"none"`
	} `json:"expect"`
}

// readMermaid reads tests/dbspec/mermaid.json against the recipe schema.
func readMermaid(path string) (mermaidRecipe, error) {
	var recipe mermaidRecipe
	_, err := readRecipe(path, &recipe)
	return recipe, err
}
