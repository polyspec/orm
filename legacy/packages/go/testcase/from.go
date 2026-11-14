package testcase

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// RunFrom builds the test binary of the package in the working directory and runs the tests that pattern selects with
// directory as their working directory. A package test calls it to check that the files of the checkout that its tests read
// do not depend on the working directory, so that moving the package or the test does not change what they read. It
// returns the combined output and the error of the build or of the run.
func RunFrom(t testing.TB, directory, pattern string) (string, error) {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "package.test")
	if output, err := exec.Command("go", "test", "-c", "-o", binary, ".").CombinedOutput(); err != nil {
		return string(output), err
	}
	command := exec.Command(binary, "-test.run", pattern, "-test.count=1", "-test.v")
	command.Dir = directory
	output, err := command.CombinedOutput()
	return string(output), err
}

// PassFromRoot runs the tests of the package that pattern selects with the repository root as their working directory
// instead of the package directory, and fails t when they fail there or when no test ran: a package whose tests read files
// of the checkout calls it, so those tests find the files at any depth of the working directory (T448).
func PassFromRoot(t testing.TB, pattern string) {
	t.Helper()
	output, err := RunFrom(t, RepositoryRoot(), pattern)
	if err != nil {
		t.Fatalf("the tests %s run from the repository root: %v\n%s", pattern, err, output)
	}
	if !strings.Contains(output, "--- PASS") {
		t.Fatalf("the tests %s run from the repository root ran no test\n%s", pattern, output)
	}
}
