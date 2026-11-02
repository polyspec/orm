package main

import (
	"fmt"
	"path/filepath"
	"strings"
)

// The vector files as their schemas declare them (tests/dbspec/schema); readVectors has checked every field before it
// decodes one, so these readers check only what a schema cannot state.

// setRecipeFile is the part of tests/dbspec/hashes.json and sets.json that the compare tool reads: the owned texts of
// the set step of each case, and each analyze step with its text and the set it is analyzed against.
type setRecipeFile struct {
	Cases []struct {
		ID    string `json:"id"`
		Steps []struct {
			Op    string              `json:"op"`
			Owned []string            `json:"owned"`
			Text  []string            `json:"text"`
			Set   map[string][]string `json:"set"`
		} `json:"steps"`
	} `json:"cases"`
}

// analysis is one analyze step of a set recipe file, with the id that the compare output names it by.
type analysis struct {
	id    string
	input syntaxInput
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

// readCases reads the recipe files of tests/dbspec in dir: the canonical, normalize, invalid, positions and files cases,
// the hashes of hashes.json, and the analyses of sets.json and hashes.json in the order of syntax.json.
func readCases(dir string) (sharedCases, error) {
	var err error
	all := sharedCases{}
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
	var setAnalyses, hashAnalyses []analysis
	if all.Hashes, hashAnalyses, err = readSetRecipe(dir, "hashes.json", "hashes"); err != nil {
		return all, err
	}
	if _, setAnalyses, err = readSetRecipe(dir, "sets.json", "sets"); err != nil {
		return all, err
	}
	all.Analyses = append(setAnalyses, hashAnalyses...)
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

// readSetRecipe reads tests/dbspec/<name> (hashes.json or sets.json) against the recipe schema. Its analyses are returned
// in file order with the ids that syntax.json gave them: sets.<case>.<n>, n being the place of the analyzed document in
// the set, and hashes.<case>.<name>, name being the header name of the analyzed document. A hashes case's documents
// are the owned texts of its set step, each named by its header.
func readSetRecipe(dir, name, kind string) ([]hashCase, []analysis, error) {
	var file setRecipeFile
	if err := readRecipeFile(filepath.Join(dir, name), &file); err != nil {
		return nil, nil, err
	}
	var cases []hashCase
	var analyses []analysis
	for _, c := range file.Cases {
		var documents map[string][]string
		n := 0
		for _, step := range c.Steps {
			switch step.Op {
			case "dbspec.set":
				documents = map[string][]string{}
				for _, text := range step.Owned {
					lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
					header, ok := headerName(lines)
					if !ok {
						return nil, nil, fmt.Errorf("%s: case %s has a document without a header name", name, c.ID)
					}
					documents[header] = lines
				}
			case "dbspec.analyze":
				n++
				set := map[string]string{}
				for other, lines := range step.Set {
					set[other] = join(lines, false, false)
				}
				in := syntaxInput{Text: join(step.Text, false, false), Documents: set}
				id := fmt.Sprintf("%s.%s.%d", kind, c.ID, n)
				if kind == "hashes" {
					header, _ := headerName(step.Text)
					id = "hashes." + c.ID + "." + header
				}
				analyses = append(analyses, analysis{id: id, input: in})
			}
		}
		if kind == "hashes" {
			cases = append(cases, hashCase{ID: c.ID, Documents: documents})
		}
	}
	return cases, analyses, nil
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
