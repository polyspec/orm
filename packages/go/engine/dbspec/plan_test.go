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
	Cases   []planCase
	Invalid []planInvalidCase
	Chains  []planChainCase
	Parse   []planParseCase
	// Comparisons are the cases that compare two schemas without a plan (docs/spec/plans.md "Comparison").
	Comparisons []comparisonCase
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

type planInvalidCase struct {
	ID     string
	Source []string
	Plan   []string
	Errors []string
}

// planChainCase has only one of Order and Errors.
type planChainCase struct {
	ID     string
	Plans  [][]string
	Order  []string
	Errors []string
}

type planParseCase struct {
	ID     string
	Plan   []string
	Errors [][]any
}

type comparisonCase struct {
	ID          string
	Source      []string
	Target      []string
	Differences [][3]string
	Errors      [][]any
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
		if p.Source, err = r.nullableLines(c, location, "source"); err != nil {
			return p, err
		}
		if p.Plan, err = r.linesField(c, location, "plan"); err != nil {
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
	if v.Invalid, err = vectorCases(r, object, "invalid", func(c map[string]any, location, id string) (planInvalidCase, error) {
		p := planInvalidCase{ID: id}
		var err error
		if p.Source, err = r.nullableLines(c, location, "source"); err != nil {
			return p, err
		}
		if p.Plan, err = r.linesField(c, location, "plan"); err != nil {
			return p, err
		}
		p.Errors, err = r.linesField(c, location, "errors")
		return p, err
	}); err != nil {
		return v, err
	}
	if v.Chains, err = vectorCases(r, object, "chains", func(c map[string]any, location, id string) (planChainCase, error) {
		p := planChainCase{ID: id}
		items, err := r.arrayField(c, location, "plans")
		if err != nil {
			return p, err
		}
		for i, item := range items {
			lines, err := r.lines(item, fmt.Sprintf("%s[%d]", vectorAt(location, "plans"), i))
			if err != nil {
				return p, err
			}
			p.Plans = append(p.Plans, lines)
		}
		_, hasOrder := c["order"]
		_, hasErrors := c["errors"]
		switch {
		case hasOrder == hasErrors:
			return p, r.fail(location, "has neither or both of order and errors")
		case hasOrder:
			p.Order, err = r.linesField(c, location, "order")
		default:
			p.Errors, err = r.linesField(c, location, "errors")
		}
		return p, err
	}); err != nil {
		return v, err
	}
	if v.Parse, err = vectorCases(r, object, "parse", func(c map[string]any, location, id string) (planParseCase, error) {
		p := planParseCase{ID: id}
		var err error
		if p.Plan, err = r.linesField(c, location, "plan"); err != nil {
			return p, err
		}
		p.Errors, err = r.diagnostics(c, location, "errors", 4)
		return p, err
	}); err != nil {
		return v, err
	}
	v.Comparisons, err = vectorCases(r, object, "comparisons", func(c map[string]any, location, id string) (comparisonCase, error) {
		p := comparisonCase{ID: id}
		var err error
		if p.Source, err = r.linesField(c, location, "source"); err != nil {
			return p, err
		}
		if p.Target, err = r.linesField(c, location, "target"); err != nil {
			return p, err
		}
		if p.Differences, err = r.triples(c, location, "differences"); err != nil {
			return p, err
		}
		p.Errors, err = r.diagnostics(c, location, "errors", 4)
		return p, err
	})
	return v, err
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

// TestPlanVectors checks whether the diff of every case and the statements of the three dialects equal the vector.
// TestPlanInvalidVectors checks the diagnostics of the invalid cases.
func TestPlanVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, c := range loadPlanVectors(t).Cases {
		t.Run(c.ID, func(t *testing.T) { checkPlanCase(t, c) })
	}
}

func TestPlanInvalidVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, c := range loadPlanVectors(t).Invalid {
		t.Run(c.ID, func(t *testing.T) { checkPlanInvalid(t, c) })
	}
}

func checkPlanCase(t *testing.T, c planCase) {
	runTimed(t, c.ID, 5*time.Second, func() error {
		source, err := planSourceOf(c.Source)
		if err != nil {
			return err
		}
		p, diagnostics := ParsePlan(strings.Join(c.Plan, "\n") + "\n")
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
}

func checkPlanInvalid(t *testing.T, c planInvalidCase) {
	runTimed(t, c.ID, 5*time.Second, func() error {
		source, err := planSourceOf(c.Source)
		if err != nil {
			return err
		}
		p, diagnostics := ParsePlan(strings.Join(c.Plan, "\n") + "\n")
		if len(diagnostics) == 0 {
			_, diagnostics = Diff(source, p)
		}
		var problems []error
		var got []string
		for _, d := range diagnostics {
			if d.Rule != RulePlan {
				problems = append(problems, fmt.Errorf("rule %s, want %s", d.Rule, RulePlan))
			}
			got = append(got, d.Message)
		}
		if !slices.Equal(got, c.Errors) {
			problems = append(problems, fmt.Errorf("errors\nwant %q\ngot  %q", c.Errors, got))
		}
		return errors.Join(problems...)
	})
}

// TestPlanChains checks whether the order or chain diagnostic of the chains case equals the vector.
// It checks that.
func TestPlanChains(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	v := loadPlanVectors(t)
	if len(v.Chains) == 0 {
		t.Fatal("tests/dbspec/plans.json has no chains")
	}
	for _, c := range v.Chains {
		t.Run(c.ID, func(t *testing.T) { checkPlanChain(t, c) })
	}
}

func checkPlanChain(t *testing.T, c planChainCase) {
	runTimed(t, c.ID, 5*time.Second, func() error {
		var plans []*Plan
		for i, lines := range c.Plans {
			p, diagnostics := ParsePlan(strings.Join(lines, "\n") + "\n")
			if len(diagnostics) > 0 {
				return fmt.Errorf("parse plan %d: %v", i, diagnostics)
			}
			plans = append(plans, p)
		}
		chain, diagnostics := Chain(plans)
		var problems []error
		var got []string
		for _, d := range diagnostics {
			if d.Rule != RuleChain {
				problems = append(problems, fmt.Errorf("rule %s, want %s", d.Rule, RuleChain))
			}
			got = append(got, d.Message)
		}
		if !slices.Equal(got, c.Errors) {
			problems = append(problems, fmt.Errorf("errors\nwant %q\ngot  %q", c.Errors, got))
		}
		var order []string
		for _, p := range chain {
			order = append(order, p.Name)
		}
		if !slices.Equal(order, c.Order) {
			problems = append(problems, fmt.Errorf("order\nwant %q\ngot  %q", c.Order, order))
		}
		return errors.Join(problems...)
	})
}

// TestPlanParseErrors checks that a parse case reports the plan diagnostic, down to its rule, line, column, and message,
// and that a target diagnostic reports down to its rule, line, and column, the same as the vector.
func TestPlanParseErrors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	v := loadPlanVectors(t)
	if len(v.Parse) == 0 {
		t.Fatal("tests/dbspec/plans.json has no parse cases")
	}
	for _, c := range v.Parse {
		t.Run(c.ID, func(t *testing.T) { checkPlanParse(t, c) })
	}
}

func checkPlanParse(t *testing.T, c planParseCase) {
	runTimed(t, c.ID, 5*time.Second, func() error {
		_, diagnostics := ParsePlan(strings.Join(c.Plan, "\n") + "\n")
		var got [][]any
		for _, d := range diagnostics {
			var message any
			if d.Rule == RulePlan {
				message = d.Message
			}
			got = append(got, []any{d.Rule, float64(d.Line), float64(d.Column), message})
		}
		return jsonEqual("errors", got, c.Errors)
	})
}

// TestCompareSchemas checks whether the differences and diagnostics of the comparison case equal the vector.
// It checks that.
func TestCompareSchemas(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	v := loadPlanVectors(t)
	if len(v.Comparisons) == 0 {
		t.Fatal("tests/dbspec/plans.json has no comparisons")
	}
	for _, c := range v.Comparisons {
		t.Run(c.ID, func(t *testing.T) { checkComparison(t, c) })
	}
}

func checkComparison(t *testing.T, c comparisonCase) {
	runTimed(t, c.ID, 5*time.Second, func() error {
		source, _, diagnostics := Parse(strings.Join(c.Source, "\n")+"\n", nil)
		if len(diagnostics) > 0 {
			return fmt.Errorf("parse source: %v", diagnostics)
		}
		target, _, diagnostics := Parse(strings.Join(c.Target, "\n")+"\n", nil)
		if len(diagnostics) > 0 {
			return fmt.Errorf("parse target: %v", diagnostics)
		}
		differences, diagnostics := CompareSchemas(source, target)
		got := [][3]string{}
		for _, d := range differences {
			got = append(got, [3]string{d.Kind, d.Table, d.Name})
		}
		var problems []error
		if !slices.Equal(got, c.Differences) {
			problems = append(problems, fmt.Errorf("differences\nwant %v\ngot  %v", c.Differences, got))
		}
		errs := [][]any{}
		for _, d := range diagnostics {
			errs = append(errs, []any{d.Rule, float64(d.Line), float64(d.Column), d.Message})
		}
		if err := jsonEqual("errors", errs, c.Errors); err != nil {
			problems = append(problems, err)
		}
		return errors.Join(problems...)
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
