package main

import (
	"fmt"
	"path/filepath"
	"strings"
)

// The vector files as their schemas declare them (tests/dbspec/schema); readVectors has checked every field before it
// decodes one, so these readers check only what a schema cannot state.

type caseFile struct {
	Hashes []hashCase `json:"hashes"`
	Sets   []struct {
		ID        string              `json:"id"`
		Documents [][]string          `json:"documents"`
		Parsing   map[string][]string `json:"parsing"`
		External  [][]string          `json:"external"`
	} `json:"sets"`
}

// recipeFile is the part of a recipe file of tests/dbspec that the compare tool reads: its cases and their steps.
type recipeFile struct {
	Cases []struct {
		ID    string       `json:"id"`
		Steps []recipeStep `json:"steps"`
	} `json:"cases"`
}

type recipeStep struct {
	Op    string              `json:"op"`
	Text  []string            `json:"text"`
	Set   map[string][]string `json:"set"`
	Path  string              `json:"path"`
	CRLF  bool                `json:"crlf"`
	Mixed bool                `json:"mixed"`
}

// readRecipe reads the cases of one recipe file of tests/dbspec/<name>. Each case has one step of op, which holds the
// input that the compare tool runs: the main text and the other documents of its set. The recipe runners check the
// rest of each case.
func readRecipe(dir, name, op string) ([]testCase, error) {
	var file recipeFile
	if err := readRecipeFile(filepath.Join(dir, name), &file); err != nil {
		return nil, err
	}
	var cases []testCase
	for _, c := range file.Cases {
		var found *recipeStep
		for i := range c.Steps {
			if c.Steps[i].Op == op {
				found = &c.Steps[i]
				break
			}
		}
		if found == nil {
			return nil, fmt.Errorf("%s: case %s has no %s step", name, c.ID, op)
		}
		documents := map[string][]string{"main": found.Text}
		for other, lines := range found.Set {
			if other == "main" {
				return nil, fmt.Errorf("%s: case %s names a document main, which is the main document", name, c.ID)
			}
			documents[other] = lines
		}
		cases = append(cases, testCase{ID: c.ID, Main: "main", Documents: documents, CRLF: found.CRLF, Mixed: found.Mixed})
	}
	return cases, nil
}

// readFiles reads the files cases of tests/dbspec/files.json: each names a file by its path (read_file step), relative to tests/dbspec.
func readFiles(dir string) ([]fileCase, error) {
	var file recipeFile
	if err := readRecipeFile(filepath.Join(dir, "files.json"), &file); err != nil {
		return nil, err
	}
	var files []fileCase
	for _, c := range file.Cases {
		for _, s := range c.Steps {
			if s.Op == "dbspec.read_file" {
				files = append(files, fileCase{ID: c.ID, Path: s.Path})
				break
			}
		}
	}
	return files, nil
}

// readCases reads tests/dbspec/cases.json against its schema, then reads the recipe files of the same directory for
// the canonical, normalize, invalid, positions and files cases. It refuses a sets document whose header names no
// document, which the schema cannot state.
func readCases(path string) (sharedCases, error) {
	var file caseFile
	r, err := readVectors(path, "cases", &file)
	if err != nil {
		return sharedCases{}, err
	}
	dir := filepath.Dir(path)
	all := sharedCases{Hashes: file.Hashes}
	for _, section := range []struct {
		name string
		op   string
		into *[]testCase
	}{{"canonical.json", "dbspec.format", &all.Canonical}, {"normalize.json", "dbspec.format", &all.Normalize}, {"invalid.json", "dbspec.format", &all.Invalid}} {
		if *section.into, err = readRecipe(dir, section.name, section.op); err != nil {
			return all, err
		}
	}
	positions, err := readRecipe(dir, "positions.json", "dbspec.parse_positions")
	if err != nil {
		return all, err
	}
	for _, c := range positions {
		all.Positions = append(all.Positions, positionCase{ID: c.ID, Main: c.Main, Documents: c.Documents})
	}
	if all.Files, err = readFiles(dir); err != nil {
		return all, err
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
	return all, nil
}

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

// readMermaid reads tests/dbspec/mermaid.json.
func readMermaid(path string) (mermaidVectors, error) {
	var mermaid mermaidVectors
	_, err := readVectors(path, "mermaid", &mermaid)
	return mermaid, err
}
