package testcase

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"
)

// fixtureVariable is the environment variable that makes the fixture test below run. Only TestReportForm
// runs as a subprocess with this variable given.
const fixtureVariable = "TESTCASE_FIXTURE"

func fixture(t *testing.T, name string) {
	if os.Getenv(fixtureVariable) != name {
		t.Skipf("runs only as the child process of TestReportForm (%s=%s)", fixtureVariable, name)
	}
}

func TestFixturePass(t *testing.T) {
	fixture(t, "report")
	c := Start(t, Compute)
	c.Step("first step of %d", 2)
	// Of finds, in a subtest that did not start a case, the case wrapping that subtest.
	t.Run("inner", func(t *testing.T) { Of(t).Step("step of the enclosing case") })
}

func TestFixtureFail(t *testing.T) {
	fixture(t, "report")
	Start(t, Compute)
	t.Error("fixture failure reason")
}

func TestFixtureSkip(t *testing.T) {
	fixture(t, "report")
	Start(t, Compute)
	t.Skip("fixture skip reason")
}

func TestFixtureGroup(t *testing.T) {
	fixture(t, "report")
	Group(t)
	for _, name := range []string{"one", "two"} {
		t.Run(name, func(t *testing.T) { Start(t, Database) })
	}
}

// TestFixtureRun shows the non-test runner's Run returning pass, failure, and deadline-exceeded. Steps are lines on stdout.
func TestFixtureRun(t *testing.T) {
	fixture(t, "report")
	if err := Run("runner/pass", time.Minute, func(c *Case) error {
		c.Step("built %s", "runner")
		w := c.StepWriter()
		if _, err := fmt.Fprint(w, "child line one\n\nchild "); err != nil {
			return err
		}
		if _, err := fmt.Fprint(w, "line two\nchild tail"); err != nil {
			return err
		}
		w.Flush()
		return nil
	}); err != nil {
		t.Errorf("runner/pass: %v", err)
	}
	if err := Run("runner/fail", time.Minute, func(*Case) error { return errors.New("runner failure reason") }); err == nil {
		t.Error("runner/fail returned no error")
	}
	if err := Run("runner/context", 100*time.Millisecond, func(c *Case) error {
		<-c.Context().Done()
		return c.Context().Err()
	}); err == nil {
		t.Error("runner/context returned no error")
	}
	// A slow but normal long job runs to the end without a deadline.
	if err := RunLong("runner/long", func(c *Case) error {
		c.Step("building")
		time.Sleep(1500 * time.Millisecond)
		c.Step("exit 0")
		return nil
	}); err != nil {
		t.Errorf("runner/long: %v", err)
	}
	if err := RunLong("runner/long-fail", func(*Case) error { return errors.New("build exited with 3") }); err == nil {
		t.Error("runner/long-fail returned no error")
	}
	if err := Run("runner/stuck", 100*time.Millisecond, func(*Case) error {
		time.Sleep(time.Minute)
		return nil
	}); err == nil {
		t.Error("runner/stuck returned no error")
	}
}

func TestFixtureDeadline(t *testing.T) {
	fixture(t, "deadline")
	Start(t, 200*time.Millisecond)
	time.Sleep(time.Minute)
}

// runFixture runs the fixture test with a child `go test -v` and returns its output and exit error.
func runFixture(name string) (string, error) {
	command := exec.Command("go", "test", "-run", "^TestFixture", "-count=1", "-v", ".")
	command.Env = append(os.Environ(), fixtureVariable+"="+name)
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
