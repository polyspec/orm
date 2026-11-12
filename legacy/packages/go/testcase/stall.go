package testcase

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"
)

// stepBudget is the time that a case allows for each step of its work. The MySQL stress plan applies 22000 steps in about
// 10 minutes (28 ms a step), and the slowest CI run took more than 12 minutes (35 ms a step), so the budget is several
// times the slowest step rate. It is an upper bound for the case; a stuck statement is found by StepGuard long before.
const stepBudget = 250 * time.Millisecond

// fixedBudget is the time for the work around the steps, such as creating and dropping a database.
const fixedBudget = time.Minute

// StepBudget is the deadline of a case that does the given number of steps one after another.
func StepBudget(steps int) time.Duration {
	return time.Duration(steps)*stepBudget + fixedBudget
}

// seconds writes d as seconds, with the digits it needs (120s, 60.25s): the form of the failure texts of the step guard,
// which every runtime writes alike.
func seconds(d time.Duration) string {
	return strconv.FormatFloat(d.Seconds(), 'f', -1, 64) + "s"
}

// StallText is the failure text of a case whose guard saw no step within limit (StepGuard).
func StallText(limit time.Duration) string {
	return "no step was applied within " + seconds(limit)
}

// BudgetText is the failure text of a case that kept applying steps past its step budget (StepGuard).
func BudgetText(budget time.Duration) string {
	return "step budget " + seconds(budget) + " exceeded"
}

// StepGuard returns the context of a case with a step deadline. It is canceled, with a cause of StallText, when progress is
// not called within stall, and with a cause of BudgetText when budget has passed. progress restarts the stall limit; stop
// releases the guard. The context ends only by these two limits and by stop, not by the end of parent, so that its cause
// always names the limit that ended the case: parent is the case's own context, whose deadline is the same budget, and the
// watchdog of the case (Start) still ends a case that does not stop.
func StepGuard(parent context.Context, budget, stall time.Duration) (ctx context.Context, progress func(), stop func()) {
	ctx, cancel := context.WithCancelCause(context.WithoutCancel(parent))
	var mutex sync.Mutex
	stalled := time.AfterFunc(stall, func() { cancel(errors.New(StallText(stall))) })
	spent := time.AfterFunc(budget, func() { cancel(errors.New(BudgetText(budget))) })
	progress = func() {
		mutex.Lock()
		defer mutex.Unlock()
		stalled.Reset(stall)
	}
	stop = func() {
		mutex.Lock()
		defer mutex.Unlock()
		stalled.Stop()
		spent.Stop()
		cancel(context.Canceled)
	}
	return ctx, progress, stop
}
