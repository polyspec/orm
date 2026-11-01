package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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

// readPlans reads the cases of tests/dbspec/plans.json, and the validation sections from the four recipes beside it
// (plan-invalid, plan-chains, plan-parse, and plan-comparisons .json). A null source is the empty schema.
func readPlans(path string) (planVectors, error) {
	var plans planVectors
	if _, err := readVectors(path, "plans", &plans); err != nil {
		return plans, err
	}
	dir := filepath.Dir(path)
	var err error
	if plans.Invalid, err = readInvalidRecipe(filepath.Join(dir, "plan-invalid.json")); err != nil {
		return plans, err
	}
	if plans.Chains, err = readChainRecipe(filepath.Join(dir, "plan-chains.json")); err != nil {
		return plans, err
	}
	if plans.Parse, err = readParseRecipe(filepath.Join(dir, "plan-parse.json")); err != nil {
		return plans, err
	}
	plans.Comparisons, err = readComparisonRecipe(filepath.Join(dir, "plan-comparisons.json"))
	return plans, err
}

// recipeFile is the part of a recipe (scripts/features/schema/recipe.schema.json) that readPlans reads: each case's steps.
type recipeFile struct {
	Cases []struct {
		ID    string       `json:"id"`
		Steps []recipeStep `json:"steps"`
	} `json:"cases"`
}

// recipeStep is the part of a dbspec step that readPlans reads. A ref is {"ref": name}, and null is the empty schema.
type recipeStep struct {
	Op     string            `json:"op"`
	Lines  []string          `json:"lines"`
	As     string            `json:"as"`
	Source json.RawMessage   `json:"source"`
	Target json.RawMessage   `json:"target"`
	Plan   json.RawMessage   `json:"plan"`
	Plans  []json.RawMessage `json:"plans"`
}

func readRecipe(path string) (recipeFile, error) {
	var file recipeFile
	src, err := os.ReadFile(path)
	if err != nil {
		return file, err
	}
	if err := json.Unmarshal(src, &file); err != nil {
		return file, fmt.Errorf("%s: %w", path, err)
	}
	return file, nil
}

// boundLines maps the as of each dbspec.parse or dbspec.parse_plan step of a case to its lines, as the recipe runner binds them.
func boundLines(steps []recipeStep) map[string][]string {
	bound := map[string][]string{}
	for _, s := range steps {
		if (s.Op == "dbspec.parse" || s.Op == "dbspec.parse_plan") && s.As != "" {
			bound[s.As] = s.Lines
		}
	}
	return bound
}

// refLines returns the lines that a ref names, or nil and false for null.
func refLines(raw json.RawMessage, bound map[string][]string) ([]string, bool, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false, nil
	}
	var ref struct {
		Ref string `json:"ref"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		return nil, false, err
	}
	lines, ok := bound[ref.Ref]
	if !ok {
		return nil, false, fmt.Errorf("ref %s names no parsed schema or plan", ref.Ref)
	}
	return lines, true, nil
}

// readInvalidRecipe reads the cases of plan-invalid.json: the source and plan that each dbspec.diff step names.
func readInvalidRecipe(path string) ([]planCase, error) {
	file, err := readRecipe(path)
	if err != nil {
		return nil, err
	}
	cases := []planCase{}
	for _, c := range file.Cases {
		bound := boundLines(c.Steps)
		for _, s := range c.Steps {
			if s.Op != "dbspec.diff" {
				continue
			}
			pc := planCase{ID: c.ID}
			source, ok, err := refLines(s.Source, bound)
			if err != nil {
				return nil, fmt.Errorf("%s case %s: %w", path, c.ID, err)
			}
			if ok {
				pc.Source = &source
			}
			plan, _, err := refLines(s.Plan, bound)
			if err != nil {
				return nil, fmt.Errorf("%s case %s: %w", path, c.ID, err)
			}
			pc.Plan = plan
			cases = append(cases, pc)
		}
	}
	return cases, nil
}

// readChainRecipe reads the cases of plan-chains.json: the plans that each dbspec.chain step names, in order.
func readChainRecipe(path string) ([]chainCase, error) {
	file, err := readRecipe(path)
	if err != nil {
		return nil, err
	}
	cases := []chainCase{}
	for _, c := range file.Cases {
		bound := boundLines(c.Steps)
		for _, s := range c.Steps {
			if s.Op != "dbspec.chain" {
				continue
			}
			cc := chainCase{ID: c.ID, Plans: [][]string{}}
			for _, raw := range s.Plans {
				lines, _, err := refLines(raw, bound)
				if err != nil {
					return nil, fmt.Errorf("%s case %s: %w", path, c.ID, err)
				}
				cc.Plans = append(cc.Plans, lines)
			}
			cases = append(cases, cc)
		}
	}
	return cases, nil
}

// readParseRecipe reads the cases of plan-parse.json: the lines of the dbspec.parse_plan step of each case.
func readParseRecipe(path string) ([]parseCase, error) {
	file, err := readRecipe(path)
	if err != nil {
		return nil, err
	}
	cases := []parseCase{}
	for _, c := range file.Cases {
		for _, s := range c.Steps {
			if s.Op == "dbspec.parse_plan" {
				cases = append(cases, parseCase{ID: c.ID, Plan: s.Lines})
			}
		}
	}
	return cases, nil
}

// readComparisonRecipe reads the cases of plan-comparisons.json: the source and target that each dbspec.compare step names.
func readComparisonRecipe(path string) ([]comparisonCase, error) {
	file, err := readRecipe(path)
	if err != nil {
		return nil, err
	}
	cases := []comparisonCase{}
	for _, c := range file.Cases {
		bound := boundLines(c.Steps)
		for _, s := range c.Steps {
			if s.Op != "dbspec.compare" {
				continue
			}
			cc := comparisonCase{ID: c.ID}
			source, _, err := refLines(s.Source, bound)
			if err != nil {
				return nil, fmt.Errorf("%s case %s: %w", path, c.ID, err)
			}
			target, _, err := refLines(s.Target, bound)
			if err != nil {
				return nil, fmt.Errorf("%s case %s: %w", path, c.ID, err)
			}
			cc.Source, cc.Target = source, target
			cases = append(cases, cc)
		}
	}
	return cases, nil
}

// readMermaid reads tests/dbspec/mermaid.json.
func readMermaid(path string) (mermaidVectors, error) {
	var mermaid mermaidVectors
	_, err := readVectors(path, "mermaid", &mermaid)
	return mermaid, err
}
