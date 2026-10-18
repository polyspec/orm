package dbspec

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// repositoryRoot is the module root. go test runs tests in the package directory (engine/dbspec), so it goes up two levels
// from there. It is the path of the checkout being run, not the path where the binary was compiled (runtime.Caller).
func repositoryRoot(t *testing.T) string {
	t.Helper()
	directory, err := os.Getwd()
	if err != nil {
		t.Fatalf("cannot read the working directory of the dbspec test: %v", err)
	}
	return filepath.Clean(filepath.Join(directory, "..", "..", "..", ".."))
}

// runTimed runs work under its own deadline and records its start, result, and elapsed time. work runs
// in its own goroutine and reports failure by returning an error, so the deadline holds even if work is stuck.
func runTimed(t *testing.T, name string, deadline time.Duration, work func() error) {
	t.Helper()
	started := time.Now()
	t.Logf("RUN %s deadline=%s", name, deadline)
	done := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- fmt.Errorf("panic: %v", recovered)
			}
		}()
		done <- work()
	}()
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	select {
	case err := <-done:
		elapsed := time.Since(started)
		if err != nil {
			t.Errorf("FAIL %s elapsed=%s: %v", name, elapsed, err)
			return
		}
		t.Logf("PASS %s elapsed=%s", name, elapsed)
	case <-timer.C:
		t.Fatalf("FAIL %s: deadline %s exceeded", name, deadline)
	}
}

// failingCaseFixture is the environment variable that makes TestFailingCaseFixture run.
// Only TestCaseHarnessReportsOnlyFailure sets this variable and runs it as a subprocess.
const failingCaseFixture = "DBSPEC_FAILING_CASE_FIXTURE"

// failingCaseNames is the name of the case that TestFailingCaseFixture runs with a wrong expected value.
func failingCaseNames(t *testing.T) []string {
	t.Helper()
	m := loadMermaidVectors(t)
	p := loadPlanVectors(t)
	return []string{
		m.Export[0].ID,
		m.Import[0].ID,
		m.Invalid[0].ID,
		m.RoundTrip[0].ID,
		p.Cases[0].ID,
		p.Invalid[0].ID,
		p.Chains[0].ID,
		p.Parse[0].ID,
		p.Comparisons[1].ID,
	}
}

// TestFailingCaseFixture runs each case check with a vector that is wrong in only one expected value.
// Every case must fail, so it is skipped if failingCaseFixture is absent.
func TestFailingCaseFixture(t *testing.T) {
	testcase.Start(t, testcase.Process)
	if os.Getenv(failingCaseFixture) != "1" {
		t.Skipf("runs only as the child process of TestCaseHarnessReportsOnlyFailure (%s=1)", failingCaseFixture)
	}
	m := loadMermaidVectors(t)
	p := loadPlanVectors(t)
	export := m.Export[0]
	export.Mermaid = append(slices.Clone(export.Mermaid), "%% wrong")
	imported := m.Import[0]
	imported.Document = append(slices.Clone(imported.Document), "wrong")
	invalid := m.Invalid[0]
	invalid.Errors = nil
	roundTrip := m.RoundTrip[0]
	roundTrip.Dropped = nil
	planCase := p.Cases[0]
	planCase.Changes = nil
	planInvalid := p.Invalid[0]
	planInvalid.Errors = nil
	chain := p.Chains[0]
	chain.Order = []string{"wrong"}
	parse := p.Parse[0]
	parse.Errors = nil
	// The first comparison has no differences, so the second case, which has differences, is emptied.
	comparison := p.Comparisons[1]
	comparison.Differences = nil
	t.Run("export", func(t *testing.T) { checkMermaidExport(t, export) })
	t.Run("import", func(t *testing.T) { checkMermaidImport(t, imported) })
	t.Run("invalid", func(t *testing.T) { checkMermaidInvalid(t, invalid) })
	t.Run("round_trip", func(t *testing.T) { checkMermaidRoundTrip(t, roundTrip) })
	t.Run("plan", func(t *testing.T) { checkPlanCase(t, planCase) })
	t.Run("plan_invalid", func(t *testing.T) { checkPlanInvalid(t, planInvalid) })
	t.Run("chain", func(t *testing.T) { checkPlanChain(t, chain) })
	t.Run("parse", func(t *testing.T) { checkPlanParse(t, parse) })
	t.Run("comparison", func(t *testing.T) { checkComparison(t, comparison) })
}

// TestCaseHarnessReportsOnlyFailure checks that a failed case prints only FAIL lines and not PASS lines,
// by running TestFailingCaseFixture as a subprocess.
func TestCaseHarnessReportsOnlyFailure(t *testing.T) {
	testcase.Start(t, testcase.Process)
	names := failingCaseNames(t)
	runTimed(t, "harness-only-failure", 2*time.Minute, func() error {
		command := exec.Command("go", "test", "-run", "^TestFailingCaseFixture$", "-count=1", "-v", ".")
		command.Env = append(os.Environ(), failingCaseFixture+"=1")
		output, err := command.CombinedOutput()
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return fmt.Errorf("fixture run: want a failing exit, got %v\n%s", err, output)
		}
		var problems []error
		for _, name := range names {
			if !strings.Contains(string(output), "FAIL "+name+" ") {
				problems = append(problems, fmt.Errorf("no FAIL line for %s", name))
			}
			if strings.Contains(string(output), "PASS "+name+" ") || strings.Contains(string(output), "PASS "+name+"\n") {
				problems = append(problems, fmt.Errorf("PASS line for the failing case %s", name))
			}
		}
		if len(problems) > 0 {
			return fmt.Errorf("%w\n%s", errors.Join(problems...), output)
		}
		return nil
	})
}
