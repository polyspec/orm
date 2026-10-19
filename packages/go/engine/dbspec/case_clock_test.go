package dbspec

import (
	"runtime"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// caseClock measures a case's wall-clock time and the CPU time of the OS thread that ran the case
// together. A test's time limit on its own computation is measured in CPU time (docs/spec/dbspec.md,
// "Verification"). On a shared machine wall-clock time includes the time spent waiting while other processes use the CPU,
// so it does not measure what the code did. Process CPU time includes the time of parallel work on other cores,
// and garbage collector worker time too, so, as with the Rust and TypeScript clients, it measures the case's thread.
// runTimed's timer that cuts off a stuck case uses wall-clock time.
type caseClock struct {
	wall time.Time
	cpu  time.Duration
}

// startCaseClock pins the goroutine to the current OS thread and starts the clock. The calling goroutine
// unpins by calling runtime.UnlockOSThread after it calls elapsed.
func startCaseClock(t *testing.T) caseClock {
	t.Helper()
	runtime.LockOSThread()
	return caseClock{wall: time.Now(), cpu: threadCPU(t)}
}

// elapsed is the user and system CPU time, and the wall-clock time, that this thread used since the start.
func (c caseClock) elapsed(t *testing.T) (cpu, wall time.Duration) {
	t.Helper()
	return threadCPU(t) - c.cpu, time.Since(c.wall)
}

// threadCPU is the CPU time this OS thread has used so far.
func threadCPU(t *testing.T) time.Duration {
	t.Helper()
	var now unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_THREAD_CPUTIME_ID, &now); err != nil {
		t.Fatalf("clock_gettime(CLOCK_THREAD_CPUTIME_ID): %v", err)
	}
	return time.Duration(now.Nano())
}
