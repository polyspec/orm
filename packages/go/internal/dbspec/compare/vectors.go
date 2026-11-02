package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/polyspec/orm/packages/go/internal/dbspec/plancases"
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

// recipeStep is the part of a dbspec step that the compare tool reads: the text and set of a document op, and the lines,
// binding and refs of a plan op. A ref is {"ref": name}, and null is the empty schema.
type recipeStep struct {
	Op     string              `json:"op"`
	Text   []string            `json:"text"`
	Set    map[string][]string `json:"set"`
	Path   string              `json:"path"`
	CRLF   bool                `json:"crlf"`
	Mixed  bool                `json:"mixed"`
	Lines  []string            `json:"lines"`
	As     string              `json:"as"`
	Source json.RawMessage     `json:"source"`
	Target json.RawMessage     `json:"target"`
	Plan   json.RawMessage     `json:"plan"`
	Plans  []json.RawMessage   `json:"plans"`
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
// the hashes of hashes.json, and the analyses of sets.json and hashes.json in the order of syntax.json. A dir that cannot be
// read as a directory is refused as "<dir>: <reason>" before any of its files is read.
func readCases(dir string) (sharedCases, error) {
	all := sharedCases{}
	if _, err := os.ReadDir(dir); err != nil {
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) {
			err = pathErr.Err
		}
		return all, fmt.Errorf("%s: %w", dir, err)
	}
	var err error
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

// readPlans checks tests/dbspec/plan-cases.json against its schema, reads the cases from the file itself, and reads the
// validation sections from the four recipes beside it (plan-invalid, plan-chains, plan-parse, and plan-comparisons .json).
// A null source is the empty schema.
func readPlans(path string) (planVectors, error) {
	var plans planVectors
	if _, err := readVectors(path, "plans", &struct{}{}); err != nil {
		return plans, err
	}
	cases, err := plancases.Read(path)
	if err != nil {
		return plans, err
	}
	for _, c := range cases {
		pc := planCase{ID: c.ID, Plan: c.Plan}
		if c.Source != nil {
			source := c.Source
			pc.Source = &source
		}
		plans.Cases = append(plans.Cases, pc)
	}
	dir := filepath.Dir(path)
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
	var file recipeFile
	if err := readRecipeFile(path, &file); err != nil {
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
	var file recipeFile
	if err := readRecipeFile(path, &file); err != nil {
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
	var file recipeFile
	if err := readRecipeFile(path, &file); err != nil {
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
	var file recipeFile
	if err := readRecipeFile(path, &file); err != nil {
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
	Op         string              `json:"op"`
	Text       []string            `json:"text"`
	Set        map[string][]string `json:"set"`
	Document   string              `json:"document"`
	As         string              `json:"as"`
	Mermaid    json.RawMessage     `json:"mermaid"`
	Name       string              `json:"name"`
	SkeletonOf string              `json:"skeleton_of"`
	Expect     struct {
		None struct {
			Value map[string]json.RawMessage `json:"value"`
		} `json:"none"`
	} `json:"expect"`
}

// readMermaid reads tests/dbspec/mermaid.json against the recipe schema.
func readMermaid(path string) (mermaidRecipe, error) {
	var recipe mermaidRecipe
	err := readRecipeFile(path, &recipe)
	return recipe, err
}
