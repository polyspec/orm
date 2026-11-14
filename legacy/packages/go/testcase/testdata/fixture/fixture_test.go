// The fixture tests of TestReportForm. They live in testdata, which go test ./... never matches, and runFixture runs them
// with a child go test of this directory, since some of them fail by design.
package fixture

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

func TestFixturePass(t *testing.T) {
	c := testcase.Start(t)
	c.Step("first step of %d", 2)
	// Of finds, in a subtest that did not start a case, the case wrapping that subtest.
	t.Run("inner", func(t *testing.T) { testcase.Of(t).Step("step of the enclosing case") })
}

func TestFixtureFail(t *testing.T) {
	testcase.Start(t)
	t.Error("fixture failure reason")
}

func TestFixtureSkip(t *testing.T) {
	testcase.Start(t)
	t.Skip("fixture skip reason")
}

func TestFixtureGroup(t *testing.T) {
	testcase.Group(t)
	for _, name := range []string{"one", "two"} {
		t.Run(name, func(t *testing.T) { testcase.Start(t) })
	}
}

// TestFixtureRun shows the non-test runner's Run returning pass and failure. Steps are lines on stdout.
func TestFixtureRun(t *testing.T) {
	if err := testcase.Run("runner/pass", func(c *testcase.Case) error {
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
	if err := testcase.Run("runner/fail", func(*testcase.Case) error { return errors.New("runner failure reason") }); err == nil {
		t.Error("runner/fail returned no error")
	}
	// A slow but normal long job runs to the end.
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
}
