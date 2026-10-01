package dbspec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// planVectors는 tests/dbspec/plans.json이다(docs/plans.md).
type planVectors struct {
	Version int `json:"version"`
	Cases   []struct {
		ID         string              `json:"id"`
		Source     []string            `json:"source"`
		Plan       []string            `json:"plan"`
		Changes    [][3]string         `json:"changes"`
		Statements map[string][]string `json:"statements"`
	} `json:"cases"`
	Invalid []struct {
		ID     string   `json:"id"`
		Source []string `json:"source"`
		Plan   []string `json:"plan"`
		Errors []string `json:"errors"`
	} `json:"invalid"`
	Chains []struct {
		ID     string     `json:"id"`
		Plans  [][]string `json:"plans"`
		Order  []string   `json:"order"`
		Errors []string   `json:"errors"`
	} `json:"chains"`
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

func planSource(t *testing.T, lines []string) *Document {
	t.Helper()
	if lines == nil {
		return nil
	}
	d, diagnostics := Parse(strings.Join(lines, "\n")+"\n", nil)
	if len(diagnostics) > 0 {
		t.Fatal(diagnostics)
	}
	return d
}

// TestPlanVectors는 모든 case의 diff와 세 dialect의 statement, 그리고 invalid
// case의 diagnostic이 vector와 같은지 확인한다.
func TestPlanVectors(t *testing.T) {
	v := loadPlanVectors(t)
	for _, c := range v.Cases {
		t.Run(c.ID, func(t *testing.T) {
			start := time.Now()
			t.Logf("RUN plan/%s deadline=5s", c.ID)
			source := planSource(t, c.Source)
			p, diagnostics := ParsePlan(strings.Join(c.Plan, "\n") + "\n")
			if len(diagnostics) > 0 {
				t.Fatal(diagnostics)
			}
			if got := EmitPlan(p); got != strings.Join(c.Plan, "\n")+"\n" {
				t.Errorf("EmitPlan differs:\n%s", got)
			}
			changes, diagnostics := Diff(source, p)
			if len(diagnostics) > 0 {
				t.Fatal(diagnostics)
			}
			var got [][3]string
			for _, ch := range changes {
				got = append(got, [3]string{ch.Kind, ch.Table, ch.Name})
			}
			if !slices.Equal(got, c.Changes) {
				t.Errorf("changes\nwant %v\ngot  %v", c.Changes, got)
			}
			for _, dialect := range []Dialect{DialectMySQL, DialectPostgres, DialectSQLite} {
				statements, diagnostics := PlanStatements(source, p, dialect)
				if len(diagnostics) > 0 {
					t.Fatal(diagnostics)
				}
				if !slices.Equal(statements, c.Statements[string(dialect)]) {
					t.Errorf("%s statements\nwant %q\ngot  %q", dialect, c.Statements[string(dialect)], statements)
				}
			}
			if elapsed := time.Since(start); elapsed > 5*time.Second {
				t.Fatalf("plan/%s took %s", c.ID, elapsed)
			}
			t.Logf("PASS plan/%s elapsed=%s", c.ID, time.Since(start))
		})
	}
	for _, c := range v.Invalid {
		t.Run("invalid/"+c.ID, func(t *testing.T) {
			t.Logf("RUN plan/invalid/%s deadline=5s", c.ID)
			start := time.Now()
			source := planSource(t, c.Source)
			p, diagnostics := ParsePlan(strings.Join(c.Plan, "\n") + "\n")
			if len(diagnostics) == 0 {
				_, diagnostics = Diff(source, p)
			}
			var got []string
			for _, d := range diagnostics {
				if d.Rule != RulePlan {
					t.Errorf("rule %s, want %s", d.Rule, RulePlan)
				}
				got = append(got, d.Message)
			}
			if !slices.Equal(got, c.Errors) {
				t.Errorf("errors\nwant %q\ngot  %q", c.Errors, got)
			}
			t.Logf("PASS plan/invalid/%s elapsed=%s", c.ID, time.Since(start))
		})
	}
}

// TestPlanChains는 chains case의 순서나 chain diagnostic이 vector와 같은지
// 확인한다.
func TestPlanChains(t *testing.T) {
	v := loadPlanVectors(t)
	if len(v.Chains) == 0 {
		t.Fatal("tests/dbspec/plans.json has no chains")
	}
	for _, c := range v.Chains {
		t.Run(c.ID, func(t *testing.T) {
			t.Logf("RUN plan/chain/%s deadline=5s", c.ID)
			start := time.Now()
			var plans []*Plan
			for _, lines := range c.Plans {
				p, diagnostics := ParsePlan(strings.Join(lines, "\n") + "\n")
				if len(diagnostics) > 0 {
					t.Fatal(diagnostics)
				}
				plans = append(plans, p)
			}
			chain, diagnostics := Chain(plans)
			var got []string
			for _, d := range diagnostics {
				if d.Rule != RuleChain {
					t.Errorf("rule %s, want %s", d.Rule, RuleChain)
				}
				got = append(got, d.Message)
			}
			if !slices.Equal(got, c.Errors) {
				t.Errorf("errors\nwant %q\ngot  %q", c.Errors, got)
			}
			var order []string
			for _, p := range chain {
				order = append(order, p.Name)
			}
			if !slices.Equal(order, c.Order) {
				t.Errorf("order\nwant %q\ngot  %q", c.Order, order)
			}
			t.Logf("PASS plan/chain/%s elapsed=%s", c.ID, time.Since(start))
		})
	}
}

// TestPlanParseErrors는 parse case가 plan diagnostic을 rule, 줄, 칸, message까지,
// target diagnostic을 rule, 줄, 칸까지 vector와 같게 보고하는지 확인한다.
func TestPlanParseErrors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "dbspec", "plans.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Parse []struct {
			ID     string   `json:"id"`
			Plan   []string `json:"plan"`
			Errors [][]any  `json:"errors"`
		} `json:"parse"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Parse) == 0 {
		t.Fatal("tests/dbspec/plans.json has no parse cases")
	}
	for _, c := range v.Parse {
		t.Run(c.ID, func(t *testing.T) {
			t.Logf("RUN plan/parse/%s deadline=5s", c.ID)
			start := time.Now()
			_, diagnostics := ParsePlan(strings.Join(c.Plan, "\n") + "\n")
			var got [][]any
			for _, d := range diagnostics {
				var message any
				if d.Rule == RulePlan {
					message = d.Message
				}
				got = append(got, []any{d.Rule, float64(d.Line), float64(d.Column), message})
			}
			gj, _ := json.Marshal(got)
			wj, _ := json.Marshal(c.Errors)
			if string(gj) != string(wj) {
				t.Errorf("errors\nwant %s\ngot  %s", wj, gj)
			}
			t.Logf("PASS plan/parse/%s elapsed=%s", c.ID, time.Since(start))
		})
	}
}
