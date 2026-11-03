package dbspec

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/internal/dbspec/plancases"
)

// loadPlanCases reads the cases of tests/dbspec/plan-cases.json, the recipe in plan-cases.json. Its cases are run by
// the recipe TestRecipeDbspecPlanCases (packages/go/orm), so this package reads them only for its own checks.
func loadPlanCases(t *testing.T) []plancases.Case {
	t.Helper()
	cases, err := plancases.Read(filepath.Join(repositoryRoot(t), "tests", "dbspec", "plan-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	return cases
}

// decodePlanVectors reads the section of plan-cases.json that this package checks: its version. The cases are the recipe
// plan-cases.json, and the other fields are checked by the schema.
func decodePlanVectors(r vectorReader, object map[string]any) error {
	return r.version(object)
}

// planSourceOf is the source schema of a plan case; if there is no source, it is an empty schema (nil).
func planSourceOf(lines []string) (*Document, error) {
	if lines == nil {
		return nil, nil
	}
	d, _, diagnostics := Parse(strings.Join(lines, "\n")+"\n", nil)
	if len(diagnostics) > 0 {
		return nil, fmt.Errorf("parse source: %v", diagnostics)
	}
	return d, nil
}

// Requirements: DBS-174.
// parsePlanCase returns the source document and the parsed plan of a plan case
// given as its source and plan lines, with the diagnostics of the parse.
func parsePlanCase(source, plan []string) (*Document, *Plan, []Diagnostic, error) {
	doc, err := planSourceOf(source)
	if err != nil {
		return nil, nil, nil, err
	}
	p, diagnostics := ParsePlan(strings.Join(plan, "\n") + "\n")
	return doc, p, diagnostics, nil
}

// withPlanCase parses a plan case given as its source and plan lines, and calls fn
// with the source, the plan, and the diagnostics of the parse.
func withPlanCase(source, plan []string, fn func(source *Document, p *Plan, diagnostics []Diagnostic) error) error {
	doc, p, diagnostics, err := parsePlanCase(source, plan)
	if err != nil {
		return err
	}
	return fn(doc, p, diagnostics)
}
