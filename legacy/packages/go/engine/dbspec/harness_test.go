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

	"github.com/polyspec/orm/legacy/packages/go/testcase"
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
	ok, err := testcase.Bounded(deadline, work)
	if !ok {
		t.Fatalf("FAIL %s: deadline %s exceeded", name, deadline)
	}
	elapsed := time.Since(started)
	if err != nil {
		t.Errorf("FAIL %s elapsed=%s: %v", name, elapsed, err)
		return
	}
	t.Logf("PASS %s elapsed=%s", name, elapsed)
}

// failingCaseNames is the name of the case that TestFailingCaseFixture runs with a wrong expected value.
func failingCaseNames(t *testing.T) []string {
	t.Helper()
	return []string{
		loadPlanCases(t)[0].ID,
	}
}

// TestCaseHarnessReportsOnlyFailure checks that a failed case prints only FAIL lines and not PASS lines,
// by running TestFailingCaseFixture as a subprocess.
func TestCaseHarnessReportsOnlyFailure(t *testing.T) {
	testcase.Start(t, testcase.Process)
	names := failingCaseNames(t)
	runTimed(t, "harness-only-failure", 2*time.Minute, func() error {
		command := exec.Command("go", "test", "-run", "^TestFailingCaseFixture$", "-count=1", "-v", "./testdata/fixture")
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

// TestLegacyRootFromAnyDirectory checks that the root that the tests of this package read their vectors from does not
// depend on the depth of the working directory: run from the repository root, it is still the legacy directory (T447).
func TestLegacyRootFromAnyDirectory(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	want := testcase.LegacyRoot()
	t.Chdir(testcase.RepositoryRoot())
	if got := repositoryRoot(t); got != want {
		t.Fatalf("the root of the vectors from the repository root is %q, want %q", got, want)
	}
}

// TestFixtureFindsTheRootFromAnyDirectory builds the fixture of TestCaseHarnessReportsOnlyFailure and runs it from the
// repository root instead of its package directory: it must still read plan-cases.json and report its one failing
// case, so the fixture finds the legacy directory at any depth of the working directory (T447).
func TestFixtureFindsTheRootFromAnyDirectory(t *testing.T) {
	testcase.Start(t, testcase.Process)
	names := failingCaseNames(t)
	binary := filepath.Join(t.TempDir(), "fixture.test")
	runTimed(t, "fixture-from-root", 2*time.Minute, func() error {
		if output, err := exec.Command("go", "test", "-c", "-o", binary, "./testdata/fixture").CombinedOutput(); err != nil {
			return fmt.Errorf("build the fixture: %w\n%s", err, output)
		}
		command := exec.Command(binary, "-test.run", "^TestFailingCaseFixture$", "-test.count=1", "-test.v")
		command.Dir = testcase.RepositoryRoot()
		output, err := command.CombinedOutput()
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return fmt.Errorf("fixture run from the repository root: want a failing exit, got %v\n%s", err, output)
		}
		for _, name := range names {
			if !strings.Contains(string(output), "FAIL "+name+" ") {
				return fmt.Errorf("fixture run from the repository root: no FAIL line for %s\n%s", name, output)
			}
		}
		return nil
	})
}
