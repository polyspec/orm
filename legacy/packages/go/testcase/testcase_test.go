package testcase

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

// fixtures maps each fixture run to the fixture tests it selects. The fixtures (testdata/fixture/fixture_test.go) live in
// testdata, which go test ./... never matches, so only runFixture runs them, with a child go test of that directory.
var fixtures = map[string]string{
	"report": "^TestFixture(Pass|Fail|Skip|Group|Run)$",
}

// runFixture runs the fixture tests of name with a child `go test -v` and returns its output and exit error.
func runFixture(name string) (string, error) {
	command := exec.Command("go", "test", "-run", fixtures[name], "-count=1", "-v", "./testdata/fixture")
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
// and that groups and the runner's steps and results also come out as native output.
func TestReportForm(t *testing.T) {
	Start(t)
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
}

// TestRunAndGroupAndWarn calls the entry points that the tagged fixtures reach through a child go test, in the default
// build, and checks the result of each: a non-test runner's result is the error of its work.
func TestRunAndGroupAndWarn(t *testing.T) {
	Group(t)
	Warn("warning %d", 1)
	if err := Run("passing", func(c *Case) error {
		c.Step("step of %s", c.name)
		return nil
	}); err != nil {
		t.Fatalf("Run of a passing case returned %v", err)
	}
	sentinel := errors.New("work failed")
	if err := Run("failing", func(c *Case) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatalf("Run of a failing case returned %v, want the work's error", err)
	}
	if err := RunLong("long", func(c *Case) error {
		c.Step("long step")
		return nil
	}); err != nil {
		t.Fatalf("RunLong of a passing job returned %v", err)
	}
	if err := RunLong("long failing", func(c *Case) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatalf("RunLong of a failing job returned %v, want the work's error", err)
	}
}

// TestNoClockEndsACase checks that no clock ends a case (T474): in a synctest bubble the fake clock moves a week past the
// start of a case and of a runner case, and the context of each is still open, so the result of a case does not depend on
// the time that the machine gives its work.
func TestNoClockEndsACase(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := Start(t)
		time.Sleep(7 * 24 * time.Hour)
		synctest.Wait()
		if err := c.Context().Err(); err != nil {
			t.Fatalf("the context of a case ended after a week of the clock: %v", context.Cause(c.Context()))
		}
		if err := Run("long runner case", func(c *Case) error {
			time.Sleep(7 * 24 * time.Hour)
			return c.Context().Err()
		}); err != nil {
			t.Fatalf("a runner case failed after a week of the clock: %v", err)
		}
	})
}
