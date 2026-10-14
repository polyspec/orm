package testcasestart

import (
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestStarted(t *testing.T) {
	testcase.Start(t, time.Minute)
}

func TestGrouped(t *testing.T) {
	testcase.Group(t)
	t.Run("a", func(t *testing.T) { testcase.Of(t) })
}

func TestBare(t *testing.T) { // want `TestBare does not start its case with packages/go/testcase, so it runs without a deadline or RUN line`
	t.Log("no case")
}

func FuzzBare(f *testing.F) { // want `FuzzBare does not start its case with packages/go/testcase`
	f.Fuzz(func(t *testing.T, b []byte) {})
}

// Go source that a generator test writes is a string, not a test of this file.
func TestGenerated(t *testing.T) {
	testcase.Start(t, time.Minute)
	_ = `package model
func TestInside(t *testing.T) { _ = 1 }
`
}

// A shadowing function named like the package's is no start of a case.
func TestShadowed(t *testing.T) { // want `TestShadowed does not start its case`
	start := func(*testing.T) {}
	start(t)
}

// TestMain and a helper with other parameters are no tests of a case.
func TestMain(m *testing.M) { m.Run() }

func Testing(t *testing.T, n int) {}

type suite struct{}

func (suite) TestMethod(t *testing.T) {}

// A start in a comment starts no case.
func TestCommented(t *testing.T) { // want `TestCommented does not start its case`
	// testcase.Start(t, time.Minute)
}
