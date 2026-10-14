package timefailure

import (
	"fmt"
	"testing"
	"time"
)

const parseBudget = 2 * time.Second

func TestBudget(t *testing.T) {
	var elapsed time.Duration
	if elapsed > parseBudget { // want `fails a test on a measured time above a bound; report it with a warning instead \(AGENTS.md\)`
		t.Fatalf("slow")
	}
}

func TestSince(t *testing.T) {
	start := time.Now()
	if time.Since(start) >= 5*time.Second { // want `fails a test on a measured time above a bound`
		panic("slow")
	}
}

func measure() error {
	var took time.Duration
	if took > 100 { // want `fails a test on a measured time above a bound`
		return fmt.Errorf("slow")
	}
	return nil
}

func TestBelow(t *testing.T) {
	var cpu time.Duration
	check(cpu < time.Second) // want `fails a test on a measured time above a bound`
}

// A warning, a lower bound, a comparison of two measurements and a comparison with zero are no failures on a bound.
func TestAccepted(t *testing.T) {
	var elapsed, waited, cpu, wall time.Duration
	if elapsed > parseBudget {
		warn("slow")
	}
	if waited < 200*time.Millisecond {
		t.Fatal("too early")
	}
	if cpu*4 > wall {
		t.Fatal("clock")
	}
	if elapsed > 0 {
		err := fmt.Errorf("not returned")
		_ = err
	}
	check(elapsed >= 0)
}

func check(bool)  {}
func warn(string) {}

// A failure further down the body of the if fails the test too.
func TestLongBody(t *testing.T) {
	var elapsed time.Duration
	if elapsed > parseBudget { // want `fails a test on a measured time above a bound`
		message := "slow"
		message += " parse"
		message += " of the corpus"
		t.Error(message)
	}
}
