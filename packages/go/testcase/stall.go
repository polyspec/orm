package testcase

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// stepBudget is the time that a case allows for each step of its work. The MySQL stress plan applies 22000 steps in about
// 10 minutes (28 ms a step), and the slowest CI run took more than 12 minutes (35 ms a step), so the budget is several
// times the slowest step rate. It is an upper bound for the case; a stuck statement is found by StallGuard long before.
const stepBudget = 250 * time.Millisecond

// fixedBudget is the time for the work around the steps, such as creating and dropping a database.
const fixedBudget = time.Minute

// StepBudget is the deadline of a case that does the given number of steps one after another.
func StepBudget(steps int) time.Duration {
	return time.Duration(steps)*stepBudget + fixedBudget
}

// StallGuard returns a context that is canceled, with a cause that names the limit, when progress is not called within
// limit. progress restarts the limit; stop releases the guard.
func StallGuard(parent context.Context, limit time.Duration) (ctx context.Context, progress func(), stop func()) {
	ctx, cancel := context.WithCancelCause(parent)
	var mutex sync.Mutex
	timer := time.AfterFunc(limit, func() { cancel(fmt.Errorf("no step was applied within %s", limit)) })
	progress = func() {
		mutex.Lock()
		defer mutex.Unlock()
		timer.Reset(limit)
	}
	stop = func() {
		mutex.Lock()
		defer mutex.Unlock()
		timer.Stop()
		cancel(context.Canceled)
	}
	return ctx, progress, stop
}
