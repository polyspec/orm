package testcase

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestStepBudgetScalesWithTheSteps checks that the deadline of a stepwise case grows with the number of steps of
// the plan and leaves room for a run that is slower than the slowest run seen in CI.
func TestStepBudgetScalesWithTheSteps(t *testing.T) {
	Start(t, Compute)
	// CI run 37862550011 applied 22000 steps of the MySQL plan in more than 12m07s, 31% slower than the 10m12s of run
	// 37860518631 on the same image, so the budget of 22000 steps has to be several times the slower run.
	slowest := 13 * time.Minute
	if budget := StepBudget(22000); budget < 3*slowest {
		t.Fatalf("the budget of 22000 steps is %s; expected at least %s", budget, 3*slowest)
	}
	if small, large := StepBudget(100), StepBudget(22000); !(small < large) {
		t.Fatalf("the budget of 100 steps is %s and of 22000 steps %s; expected the budget to grow with the steps", small, large)
	}
	if StepBudget(0) <= 0 {
		t.Fatal("the budget of a plan without steps is not positive")
	}
}

// TestStallGuardCancelsAStalledCase checks that the guard cancels the context with a cause when no step is reported within
// its limit, and that it stays open while steps are reported.
func TestStallGuardCancelsAStalledCase(t *testing.T) {
	c := Start(t, Compute)
	ctx, progress, stop := StallGuard(c.Context(), 500*time.Millisecond)
	for range 10 {
		progress()
		time.Sleep(5 * time.Millisecond)
		if err := ctx.Err(); err != nil {
			t.Fatalf("the guard canceled the context while steps were reported: %v", context.Cause(ctx))
		}
	}
	select {
	case <-ctx.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("the guard did not cancel the context after the limit without a step")
	}
	if cause := context.Cause(ctx); cause == nil || !strings.Contains(cause.Error(), "no step was applied within 500ms") {
		t.Fatalf("cause = %v, expected it to name the limit", cause)
	}
	stop()
	if ctx2, _, stop2 := StallGuard(c.Context(), time.Hour); ctx2.Err() != nil {
		t.Fatal("a new guard starts canceled")
	} else {
		stop2()
		if ctx2.Err() == nil {
			t.Fatal("stop did not cancel the context")
		}
	}
}
