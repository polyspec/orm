package testcase

import (
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

// fixtures maps each fixture run to the fixture tests it selects. The fixtures (testcase_fixture_test.go) build only with
// the tag testcasefixture, which only runFixture gives to the child go test.
var fixtures = map[string]string{
	"report":   "^TestFixture(Pass|Fail|Skip|Group|Run)$",
	"deadline": "^TestFixtureDeadline$",
}

// runFixture runs the fixture tests of name with a child `go test -v` and returns its output and exit error.
func runFixture(name string) (string, error) {
	command := exec.Command("go", "test", "-tags", "testcasefixture", "-run", fixtures[name], "-count=1", "-v", ".")
	output, err := command.CombinedOutput()
	return string(output), err
}

// inOrder checks whether patterns each appear as one line in output, in this order.
func inOrder(output string, patterns ...string) error {
	lines := strings.Split(output, "\n")
	at := 0
	for _, pattern := range patterns {
		re := regexp.MustCompile("^" + pattern + "$")
		found := false
		for at < len(lines) {
			line := strings.TrimSpace(lines[at])
			at++
			if re.MatchString(line) {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("no line matching %q in order", pattern)
		}
	}
	return nil
}

// TestReportForm checks that the steps of a case started with Start come out as t.Log and the results come out as go test's `--- PASS`, `--- FAIL`, `--- SKIP`,
// that groups and the runner's steps and results also come out as native output, and that a case past its
// deadline ends the process with a diagnostic.
func TestReportForm(t *testing.T) {
	Start(t, Process)
	output, err := runFixture("report")
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("report fixture: want a failing exit for TestFixtureFail, got %v\n%s", err, output)
	}
	checks := [][]string{
		{`=== RUN   TestFixturePass`, `.*first step of 2`, `.*step of the enclosing case`, `--- PASS: TestFixturePass \(\S+\)`},
		{`=== RUN   TestFixtureFail`, `.*fixture failure reason`, `--- FAIL: TestFixtureFail \(\S+\)`},
		{`=== RUN   TestFixtureSkip`, `.*fixture skip reason`, `--- SKIP: TestFixtureSkip \(\S+\)`},
		{`=== RUN   TestFixtureGroup/one`, `=== RUN   TestFixtureGroup/two`, `--- PASS: TestFixtureGroup \(\S+\)`,
			`--- PASS: TestFixtureGroup/one \(\S+\)`, `--- PASS: TestFixtureGroup/two \(\S+\)`},
		{`built runner`, `child line one`, `child line two`, `child tail`},
		{`building`, `exit 0`},
	}
	for _, patterns := range checks {
		if err := inOrder(output, patterns...); err != nil {
			t.Errorf("%v\n%s", err, output)
		}
	}
	if regexp.MustCompile(`(?m)\.go:\d+: *$`).MatchString(output) {
		t.Errorf("empty log line from the StepWriter\n%s", output)
	}
	output, err = runFixture("deadline")
	if !errors.As(err, &exit) {
		t.Fatalf("deadline fixture: want a failing exit, got %v\n%s", err, output)
	}
	if err := inOrder(output, `testcase TestFixtureDeadline: deadline 200ms exceeded and the case did not stop`, `goroutine [0-9]+ \[.*\]:`); err != nil {
		t.Errorf("%v\n%s", err, output)
	}
	if strings.Contains(output, "--- PASS: TestFixtureDeadline") {
		t.Errorf("PASS result for the expired case\n%s", output)
	}
}
