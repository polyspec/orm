package dbspec

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

// asFixture returns v as T. A test table names the shape it expects of a fixture value; another shape is a broken
// table, which panics and that runTimed reports as a failed case.
func asFixture[T any](v any) T {
	t, ok := v.(T)
	if !ok {
		panic(fmt.Sprintf("the test table expects %T, found %T", *new(T), v))
	}
	return t
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

// failingCaseFixture is the build tag that makes TestFailingCaseFixture (harness_fixture_test.go) build.
// Only TestCaseHarnessReportsOnlyFailure gives this tag, to the go test that it runs as a subprocess.
const failingCaseFixture = "dbspecfixture"

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

// TestCaseHarnessReportsOnlyFailure checks that a failed case prints only FAIL lines and not PASS lines,
// by running TestFailingCaseFixture as a subprocess.
func TestCaseHarnessReportsOnlyFailure(t *testing.T) {
	testcase.Start(t, testcase.Process)
	names := failingCaseNames(t)
	runTimed(t, "harness-only-failure", 2*time.Minute, func() error {
		command := exec.Command("go", "test", "-tags", failingCaseFixture, "-run", "^TestFailingCaseFixture$", "-count=1", "-v", ".")
		output, err := command.CombinedOutput()
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			if err == nil {
				return fmt.Errorf("fixture run: want a failing exit, got success\n%s", output)
			}
			return fmt.Errorf("fixture run: want a failing exit: %w\n%s", err, output)
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
