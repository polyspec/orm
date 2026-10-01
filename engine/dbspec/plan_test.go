package dbspec

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// planVectors는 tests/dbspec/plans.json이다(docs/plans.md).
type planVectors struct {
	Version int               `json:"version"`
	Cases   []planCase        `json:"cases"`
	Invalid []planInvalidCase `json:"invalid"`
	Chains  []planChainCase   `json:"chains"`
	Parse   []planParseCase   `json:"parse"`
	// Comparisons는 plan 없이 두 schema를 비교하는 case다(docs/plans.md "Comparison").
	Comparisons []comparisonCase `json:"comparisons"`
}

type comparisonCase struct {
	ID          string      `json:"id"`
	Source      []string    `json:"source"`
	Target      []string    `json:"target"`
	Differences [][3]string `json:"differences"`
	Errors      [][]any     `json:"errors"`
}

type planCase struct {
	ID         string              `json:"id"`
	Source     []string            `json:"source"`
	Plan       []string            `json:"plan"`
	Changes    [][3]string         `json:"changes"`
	Statements map[string][]string `json:"statements"`
}

type planInvalidCase struct {
	ID     string   `json:"id"`
	Source []string `json:"source"`
	Plan   []string `json:"plan"`
	Errors []string `json:"errors"`
}

type planChainCase struct {
	ID     string     `json:"id"`
	Plans  [][]string `json:"plans"`
	Order  []string   `json:"order"`
	Errors []string   `json:"errors"`
}

type planParseCase struct {
	ID     string   `json:"id"`
	Plan   []string `json:"plan"`
	Errors [][]any  `json:"errors"`
}

func loadPlanVectors(t *testing.T) planVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "dbspec", "plans.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v planVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Version != 1 || len(v.Cases) == 0 || len(v.Invalid) == 0 {
		t.Fatalf("tests/dbspec/plans.json has version %d, %d cases and %d invalid cases", v.Version, len(v.Cases), len(v.Invalid))
	}
	return v
}

// planSourceOf는 plan case의 source schema이고, source가 없으면 빈 schema(nil)이다.
func planSourceOf(lines []string) (*Document, error) {
	if lines == nil {
		return nil, nil
	}
	d, diagnostics := Parse(strings.Join(lines, "\n")+"\n", nil)
	if len(diagnostics) > 0 {
		return nil, fmt.Errorf("parse source: %v", diagnostics)
	}
	return d, nil
}

// TestPlanVectors는 모든 case의 diff와 세 dialect의 statement, 그리고 invalid
// case의 diagnostic이 vector와 같은지 확인한다.
func TestPlanVectors(t *testing.T) {
	v := loadPlanVectors(t)
	for _, c := range v.Cases {
		t.Run(c.ID, func(t *testing.T) { checkPlanCase(t, c) })
	}
	for _, c := range v.Invalid {
		t.Run("invalid/"+c.ID, func(t *testing.T) { checkPlanInvalid(t, c) })
	}
}

func checkPlanCase(t *testing.T, c planCase) {
	runTimed(t, "plan/"+c.ID, 5*time.Second, func() error {
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
			statements, diagnostics := PlanStatements(source, p, dialect)
			if len(diagnostics) > 0 {
				problems = append(problems, fmt.Errorf("%s statements: %v", dialect, diagnostics))
				continue
			}
			if !slices.Equal(statements, c.Statements[string(dialect)]) {
				problems = append(problems, fmt.Errorf("%s statements\nwant %q\ngot  %q", dialect, c.Statements[string(dialect)], statements))
			}
		}
		return errors.Join(problems...)
	})
}

func checkPlanInvalid(t *testing.T, c planInvalidCase) {
	runTimed(t, "plan/invalid/"+c.ID, 5*time.Second, func() error {
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

// TestPlanChains는 chains case의 순서나 chain diagnostic이 vector와 같은지
// 확인한다.
func TestPlanChains(t *testing.T) {
	v := loadPlanVectors(t)
	if len(v.Chains) == 0 {
		t.Fatal("tests/dbspec/plans.json has no chains")
	}
	for _, c := range v.Chains {
		t.Run(c.ID, func(t *testing.T) { checkPlanChain(t, c) })
	}
}

func checkPlanChain(t *testing.T, c planChainCase) {
	runTimed(t, "plan/chain/"+c.ID, 5*time.Second, func() error {
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

// TestPlanParseErrors는 parse case가 plan diagnostic을 rule, 줄, 칸, message까지,
// target diagnostic을 rule, 줄, 칸까지 vector와 같게 보고하는지 확인한다.
func TestPlanParseErrors(t *testing.T) {
	v := loadPlanVectors(t)
	if len(v.Parse) == 0 {
		t.Fatal("tests/dbspec/plans.json has no parse cases")
	}
	for _, c := range v.Parse {
		t.Run(c.ID, func(t *testing.T) { checkPlanParse(t, c) })
	}
}

func checkPlanParse(t *testing.T, c planParseCase) {
	runTimed(t, "plan/parse/"+c.ID, 5*time.Second, func() error {
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

// TestCompareSchemas는 comparison case의 차이와 diagnostic이 vector와 같은지
// 확인한다.
func TestCompareSchemas(t *testing.T) {
	v := loadPlanVectors(t)
	if len(v.Comparisons) == 0 {
		t.Fatal("tests/dbspec/plans.json has no comparisons")
	}
	for _, c := range v.Comparisons {
		t.Run(c.ID, func(t *testing.T) { checkComparison(t, c) })
	}
}

func checkComparison(t *testing.T, c comparisonCase) {
	runTimed(t, "plan/comparison/"+c.ID, 5*time.Second, func() error {
		source, diagnostics := Parse(strings.Join(c.Source, "\n")+"\n", nil)
		if len(diagnostics) > 0 {
			return fmt.Errorf("parse source: %v", diagnostics)
		}
		target, diagnostics := Parse(strings.Join(c.Target, "\n")+"\n", nil)
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
