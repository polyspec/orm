package dbspec

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// planVectors is tests/dbspec/plans.json (docs/spec/plans.md).
type planVectors struct {
	Cases []planCase
}

// If the Source of a planCase is nil, it is an empty schema.
type planCase struct {
	ID      string
	Source  []string
	Plan    []string
	Changes [][3]string
	// Steps is an array of step objects per dialect (docs/spec/plans.md "Steps").
	Steps map[string][]any
}

func loadPlanVectors(t *testing.T) planVectors {
	t.Helper()
	r, object := readVectorFile(t, "plans.json")
	v, err := decodePlanVectors(r, object)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// decodePlanVectors reads all sections and fields of plans.json, and rejects, with location, any that are missing or whose type
// is different.
func decodePlanVectors(r vectorReader, object map[string]any) (planVectors, error) {
	var v planVectors
	if err := r.version(object); err != nil {
		return v, err
	}
	var err error
	if v.Cases, err = vectorCases(r, object, "cases", func(c map[string]any, location, id string) (planCase, error) {
		p := planCase{ID: id}
		var err error
		if p.Source, p.Plan, err = r.sourceAndPlan(c, location); err != nil {
			return p, err
		}
		if p.Changes, err = r.triples(c, location, "changes"); err != nil {
			return p, err
		}
		p.Steps, err = r.stepsMap(c, location, "steps")
		return p, err
	}); err != nil {
		return v, err
	}
	return v, nil
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

// Requirements: PLN-73, PLN-74, PLN-75, PLN-76, PLN-77, PLN-78, PLN-79, PLN-80, PLN-81, PLN-82, PLN-83.
// TestPlanVectors checks whether the diff of every case and the statements of the three dialects equal the vector.
func TestPlanVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, c := range loadPlanVectors(t).Cases {
		t.Run(c.ID, func(t *testing.T) { checkPlanCase(t, c) })
	}
}

// Requirements: DBS-174.
func TestPlanStepsRejectsUnknownDialect(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	runTimed(t, "plan steps reject an unknown dialect", 5*time.Second, func() (err error) {
		c := loadPlanVectors(t).Cases[0]
		return withPlanCase(c.Source, c.Plan, func(source *Document, plan *Plan, diagnostics []Diagnostic) (err error) {
			if len(diagnostics) != 0 {
				return fmt.Errorf("parse plan: %v", diagnostics)
			}
			return unknownDialectPanic("PlanSteps", func() {
				_, _ = PlanSteps(source, plan, Dialect("oracle"))
			})
		})
	})
}

func checkPlanCase(t *testing.T, c planCase) {
	runTimed(t, c.ID, 5*time.Second, func() error {
		return withPlanCase(c.Source, c.Plan, func(source *Document, p *Plan, diagnostics []Diagnostic) error {
			if len(diagnostics) > 0 {
				return fmt.Errorf("parse plan: %v", diagnostics)
			}
			var problems []error
			if got := EmitPlan(p); got != strings.Join(c.Plan, "\n")+"\n" {
				problems = append(problems, fmt.Errorf("EmitPlan differs:\n%s", got))
			}
			changes, diagnostics := Diff(source, p)
			if len(diagnostics) > 0 {
				return errors.Join(append(problems, fmt.Errorf("diff: %v", diagnostics))...)
			}
			var got [][3]string
			for _, ch := range changes {
				got = append(got, [3]string{ch.Kind, ch.Table, ch.Name})
			}
			if !slices.Equal(got, c.Changes) {
				problems = append(problems, fmt.Errorf("changes\nwant %v\ngot  %v", c.Changes, got))
			}
			for _, dialect := range []Dialect{DialectMySQL, DialectPostgres, DialectSQLite} {
				steps, diagnostics := PlanSteps(source, p, dialect)
				if len(diagnostics) > 0 {
					problems = append(problems, fmt.Errorf("%s steps: %v", dialect, diagnostics))
					continue
				}
				got := make([]any, len(steps))
				for i, step := range steps {
					got[i] = stepFields(step)
				}
				if err := jsonEqual(string(dialect)+" steps", got, c.Steps[string(dialect)]); err != nil {
					problems = append(problems, err)
				}
			}
			return errors.Join(problems...)
		})
	})
}

// stepFields is the plans.json object of a step (docs/spec/plans.md "Steps").
func stepFields(s PlanStep) map[string]any {
	out := map[string]any{"statement": s.Statement, "effect": s.Effect.String()}
	switch {
	case s.Rollback != "":
		out["rollback"] = s.Rollback
	case s.Irreversible != "":
		out["irreversible"] = s.Irreversible
	}
	if s.Restore != "" {
		out["restore"] = s.Restore
	}
	if s.RollbackRestore != "" {
		out["rollback_restore"] = s.RollbackRestore
	}
	if s.Restore != "" || s.RollbackRestore != "" {
		out["restore_if"] = s.RestoreIf.String()
	}
	if len(s.NullChecks) > 0 {
		var checks []any
		for _, c := range s.NullChecks {
			var def any
			if c.HasDefault {
				def = c.Default
			}
			checks = append(checks, []any{c.Table, c.Column, def})
		}
		out["null_checks"] = checks
	}
	if s.Finalize {
		out["finalize"] = true
	}
	return out
}

// sourceAndPlan reads the source (null or lines) and the plan lines of a plan case.
func (r vectorReader) sourceAndPlan(c map[string]any, location string) ([]string, []string, error) {
	source, err := r.nullableLines(c, location, "source")
	if err != nil {
		return nil, nil, err
	}
	plan, err := r.linesField(c, location, "plan")
	return source, plan, err
}

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
