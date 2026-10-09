package dialects

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// stressStepBudget is the time that the stress case allows for each step of the plan. The MySQL plan applies 22000
// steps in about 10 minutes (28 ms a step), and the slowest CI run took more than 12 minutes (35 ms a step), so the
// budget is several times the slowest step rate. It is an upper bound for the case; a stuck statement is found by the
// stall guard long before.
const stressStepBudget = 250 * time.Millisecond

// stressFixedBudget is the time for the work around the apply: creating and dropping the database and reading the history.
const stressFixedBudget = time.Minute

// stressStallLimit is the time without any applied step after which the stress case fails: every step is one statement
// and its commit, so no step takes minutes on a database that works.
const stressStallLimit = 2 * time.Minute

// stressCaseBudget is the deadline of the stress case of a plan of the given number of steps.
func stressCaseBudget(steps int) time.Duration {
	return time.Duration(steps)*stressStepBudget + stressFixedBudget
}

// newStallGuard returns a context that is canceled, with a cause that names the limit, when progress is not called within
// limit. progress restarts the limit; stop releases the guard.
func newStallGuard(parent context.Context, limit time.Duration) (ctx context.Context, progress func(), stop func()) {
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
