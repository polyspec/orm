package testcase

import (
	"context"
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
	if small, large := StepBudget(100), StepBudget(22000); small >= large {
		t.Fatalf("the budget of 100 steps is %s and of 22000 steps %s; expected the budget to grow with the steps", small, large)
	}
	if StepBudget(0) <= 0 {
		t.Fatal("the budget of a plan without steps is not positive")
	}
}

// TestStepGuardEndsAStalledCase checks that the guard cancels the context with the stall text when no step is reported within
// its stall limit, and that it stays open while steps are reported. The text is the same in every runtime.
func TestStepGuardEndsAStalledCase(t *testing.T) {
	c := Start(t, Compute)
	ctx, progress, stop := StepGuard(c.Context(), time.Hour, 500*time.Millisecond)
	defer stop()
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
	if cause := context.Cause(ctx); cause == nil || cause.Error() != "no step was applied within 0.5s" {
		t.Fatalf("cause = %v, want no step was applied within 0.5s", cause)
	}
}

// TestStepGuardEndsACaseThatPassesItsBudget checks that a case that keeps reporting steps is ended at its step budget with
// the budget text, which is the same in every runtime.
func TestStepGuardEndsACaseThatPassesItsBudget(t *testing.T) {
	c := Start(t, Compute)
	ctx, progress, stop := StepGuard(c.Context(), 250*time.Millisecond, time.Hour)
	defer stop()
	deadline := time.After(10 * time.Second)
	for ctx.Err() == nil {
		select {
		case <-deadline:
			t.Fatal("the guard did not cancel the context after its budget")
		case <-time.After(5 * time.Millisecond):
			progress()
		}
	}
	if cause := context.Cause(ctx); cause == nil || cause.Error() != "step budget 0.25s exceeded" {
		t.Fatalf("cause = %v, want step budget 0.25s exceeded", cause)
	}
}

// TestStepGuardNamesItsLimitsInSeconds checks the texts of the limits of a recipe case: the 120 second stall limit and the
// step budget of one step.
func TestStepGuardNamesItsLimitsInSeconds(t *testing.T) {
	Start(t, Compute)
	if got := StallText(Database); got != "no step was applied within 120s" {
		t.Fatalf("StallText(Database) = %q", got)
	}
	if got := BudgetText(StepBudget(1)); got != "step budget 60.25s exceeded" {
		t.Fatalf("BudgetText(StepBudget(1)) = %q", got)
	}
}

// TestStepGuardOutlivesItsParentAndStops checks that the guard's context does not end with its parent, whose deadline is the
// same budget, so that the cause names the guard's limit, and that stop cancels it.
func TestStepGuardOutlivesItsParentAndStops(t *testing.T) {
	c := Start(t, Compute)
	parent, cancel := context.WithCancel(c.Context())
	ctx, _, stop := StepGuard(parent, time.Hour, time.Hour)
	cancel()
	if ctx.Err() != nil {
		t.Fatalf("the guard ended with its parent: %v", context.Cause(ctx))
	}
	stop()
	if ctx.Err() == nil {
		t.Fatal("stop did not cancel the context")
	}
}
