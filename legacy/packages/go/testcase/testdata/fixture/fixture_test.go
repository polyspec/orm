// The fixture tests of TestReportForm. They live in testdata, which go test ./... never matches, and runFixture runs them
// with a child go test of this directory, since some of them fail or stall by design.
package fixture

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestFixturePass(t *testing.T) {
	c := testcase.Start(t, testcase.Compute)
	c.Step("first step of %d", 2)
	// Of finds, in a subtest that did not start a case, the case wrapping that subtest.
	t.Run("inner", func(t *testing.T) { testcase.Of(t).Step("step of the enclosing case") })
}

func TestFixtureFail(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	t.Error("fixture failure reason")
}

func TestFixtureSkip(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	t.Skip("fixture skip reason")
}

func TestFixtureGroup(t *testing.T) {
	testcase.Group(t)
	for _, name := range []string{"one", "two"} {
		t.Run(name, func(t *testing.T) { testcase.Start(t, testcase.Database) })
	}
}

// TestFixtureRun shows the non-test runner's Run returning pass, failure, and deadline-exceeded. Steps are lines on stdout.
func TestFixtureRun(t *testing.T) {
	if err := testcase.Run("runner/pass", time.Minute, func(c *testcase.Case) error {
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
	if err := testcase.Run("runner/fail", time.Minute, func(*testcase.Case) error { return errors.New("runner failure reason") }); err == nil {
		t.Error("runner/fail returned no error")
	}
	if err := testcase.Run("runner/context", 100*time.Millisecond, func(c *testcase.Case) error {
		<-c.Context().Done()
		return c.Context().Err()
	}); err == nil {
		t.Error("runner/context returned no error")
	}
	// A slow but normal long job runs to the end without a deadline.
	if err := testcase.RunLong("runner/long", func(c *testcase.Case) error {
		c.Step("building")
		time.Sleep(1500 * time.Millisecond)
		c.Step("exit 0")
		return nil
	}); err != nil {
		t.Errorf("runner/long: %v", err)
	}
	if err := testcase.RunLong("runner/long-fail", func(*testcase.Case) error { return errors.New("build exited with 3") }); err == nil {
		t.Error("runner/long-fail returned no error")
	}
	if err := testcase.Run("runner/stuck", 100*time.Millisecond, func(*testcase.Case) error {
		time.Sleep(time.Minute)
		return nil
	}); err == nil {
		t.Error("runner/stuck returned no error")
	}
}

func TestFixtureDeadline(t *testing.T) {
	testcase.Start(t, 200*time.Millisecond)
	time.Sleep(time.Minute)
}
