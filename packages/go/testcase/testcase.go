// Package testcase is a helper that gives each go test case a deadline and records its steps in the test's log.
//
// The report is the native output of go test. The results of the cases started with Start (`--- PASS`, `--- FAIL`, `--- SKIP`) and
// the steps (lines of t.Log) are printed as they are by go test -json or -v. Group marks a group without a deadline of its own and writes
// no line either. Each grouped case has its own deadline.
//
// Run and RunLong of the non-test runner run a case without a test and write its steps to stdout as they are. The result is
// decided by the error returned. Long runner jobs (build, install, tool run) run without a deadline with RunLong.
//
// The deadline is wall-clock time, because it is the timer that ends a stuck case, not a limit that measures the case's own computation time (AGENTS.md testing rule).
package testcase

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"runtime/pprof"
	"strings"
	"sync"
	"testing"
	"time"
)

// The deadline tiers. A case uses the tier that fits its work; work that takes longer than its tier uses
// its own deadline, with the basis stated in a comment.
const (
	// Compute is the deadline of a case that only computes in memory and reads repository files. Basis:
	// the largest of such cases (parse and emit of the dbspec stress document, the fuzz seed corpus) finishes
	// within seconds, so a case that exceeds one minute is stuck.
	Compute = time.Minute
	// Database is the deadline of a case that connects to the database of TEST_ENV and runs a fixed number of statements.
	// Basis: such a case runs up to a few hundred statements, including creating and dropping databases,
	// and two minutes is ample, including the time spent waiting for locks on a shared server.
	Database = 2 * time.Minute
	// Process is the deadline of a case that runs subprocesses such as `go build`, `go run`, php, node, and Rust binaries.
	// Basis: `go run` and `go build` take minutes to recompile the packages and
	// dependencies when the build cache is empty.
	Process = 5 * time.Minute
)

// Grace is the time to wait for the process to end after the deadline has passed. A case that follows Context
// can fail with its own error at the deadline and finish its cleanup; only a stuck case that does not follow Context
// ends after Grace.
const Grace = 5 * time.Second

var output sync.Mutex

// emit writes one line to stdout. It locks so that lines from several goroutines are not mixed.
func emit(format string, args ...any) {
	output.Lock()
	defer output.Unlock()
	if _, err := fmt.Fprintf(os.Stdout, format+"\n", args...); err != nil {
		// The lines of stdout are the report of the run; a run that cannot write them has no result to report.
		panic(fmt.Sprintf("testcase: write stdout: %v", err))
	}
}

// Warn writes the line `WARNING <message>` saying that a performance measurement exceeded the document's reference value. It measures and reports performance but does not fail the test
// (AGENTS.md): a warning is not a failure. The message carries the measured value, the reference value, and the machine. The check runner collects this line
// into the run record and summary, and also writes it as a GitHub Actions `::warning::` annotation.
func Warn(format string, args ...any) {
	emit("WARNING "+format, args...)
}

// Case is one running case. log takes one step line: in a test it is the test's log, and in a runner it is stdout.
type Case struct {
	name     string
	deadline time.Duration
	ctx      context.Context
	cancel   context.CancelFunc
	watchdog *time.Timer
	log      func(line string)
}

// Start starts t as a case under a deadline. Context ends at the deadline. Adding Grace to the deadline
// If it has not ended after that time, it writes the diagnostic and the stacks of all goroutines to stderr and ends the test binary,
// because a stuck case does not return by itself. The result is reported to t by go test.
func Start(t testing.TB, deadline time.Duration) *Case {
	t.Helper()
	if deadline <= 0 {
		t.Fatalf("testcase.Start: deadline %s is not positive", deadline)
	}
	c := &Case{name: t.Name(), deadline: deadline, log: func(line string) { t.Log(line) }}
	c.ctx, c.cancel = context.WithTimeout(context.Background(), deadline)
	c.watchdog = time.AfterFunc(deadline+Grace, c.expire)
	started.Store(c.name, c)
	t.Cleanup(func() {
		started.Delete(c.name)
		c.watchdog.Stop()
		c.cancel()
	})
	return c
}

// started finds, by test name, a case started with Start that has not yet ended.
var started sync.Map

// Of is the case started on t, or otherwise the case started on the nearest enclosing test wrapping t. It is used
// by a helper that does not take a case value to log its steps to that case's log. If no case was started, it fails t.
func Of(t testing.TB) *Case {
	t.Helper()
	for name := t.Name(); ; {
		if c, ok := started.Load(name); ok {
			return c.(*Case)
		}
		i := strings.LastIndexByte(name, '/')
		if i < 0 {
			t.Fatalf("testcase.Of: no case started for %s", t.Name())
			return nil
		}
		name = name[:i]
	}
}

// Close closes c and fails t with the error of its Close. A test defers it, or calls it in t.Cleanup, for the
// resources it opens, so that a failed Close is a failure of the test and not a lost error.
func Close(t testing.TB, c io.Closer) {
	t.Helper()
	if err := c.Close(); err != nil {
		t.Errorf("close %T: %v", c, err)
	}
}

// Group marks a test that groups cases, each started with Start. The group itself has no deadline and writes no line.
func Group(t testing.TB) {
	t.Helper()
}

// Run runs one case for a non-test runner (the check command). work must follow c.Context().
// If work has not returned after the deadline plus Grace, it returns an error. The error of work is the result.
func Run(name string, deadline time.Duration, work func(c *Case) error) error {
	if deadline <= 0 {
		return fmt.Errorf("testcase.Run %s: deadline %s is not positive", name, deadline)
	}
	c := &Case{name: name, deadline: deadline, log: func(line string) { emit("%s", line) }}
	c.ctx, c.cancel = context.WithTimeout(context.Background(), deadline)
	defer c.cancel()
	done := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- fmt.Errorf("panic: %v", recovered)
			}
		}()
		done <- work(c)
	}()
	timer := time.NewTimer(deadline + Grace)
	defer timer.Stop()
	var err error
	select {
	case err = <-done:
	case <-timer.C:
		err = fmt.Errorf("deadline %s exceeded", deadline)
	}
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// RunLong runs one long job (build, install, tool run) for a non-test runner without a deadline. So that a slow but normal
// job does not fail because of the clock, no timer is set. Success and failure are decided by the result work observed (the command's exit code and
// errors). c.Context() never ends.
func RunLong(name string, work func(c *Case) error) error {
	c := &Case{name: name, log: func(line string) { emit("%s", line) }}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	defer c.cancel()
	err := func() (err error) {
		defer func() {
			if recovered := recover(); recovered != nil {
				err = fmt.Errorf("panic: %v", recovered)
			}
		}()
		return work(c)
	}()
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// Step writes one step to the case's log. In a test it is t.Log, so go test -v and -json show it; in a runner it is
// one line on stdout. A case that can run longer than a minute calls Step at each step.
func (c *Case) Step(format string, args ...any) {
	c.log(fmt.Sprintf(format, args...))
}

// StepWriter is a writer that, for each non-blank line written, records one Step line. It records the progress output
// of a subprocess such as a build as the case's steps. When the process ends, Flush writes the final line.
type StepWriter struct {
	c       *Case
	mu      sync.Mutex
	partial []byte
}

// StepWriter returns a writer that records lines as steps of c.
func (c *Case) StepWriter() *StepWriter { return &StepWriter{c: c} }

func (w *StepWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.partial = append(w.partial, p...)
	for {
		i := bytes.IndexByte(w.partial, '\n')
		if i < 0 {
			return len(p), nil
		}
		if line := strings.TrimRight(string(w.partial[:i]), "\r"); strings.TrimSpace(line) != "" {
			w.c.Step("%s", line)
		}
		w.partial = w.partial[i+1:]
	}
}

// Flush records the output left without a line ending as a step line.
func (w *StepWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(bytes.TrimSpace(w.partial)) > 0 {
		w.c.Step("%s", w.partial)
	}
	w.partial = nil
}

// Context is the context that ends at the case's deadline.
func (c *Case) Context() context.Context { return c.ctx }

// Deadline is the deadline of the case.
func (c *Case) Deadline() time.Duration { return c.deadline }

// expire reports a case past its deadline as a diagnostic and ends the process. go test reports a test that has not ended as a failure.
func (c *Case) expire() {
	output.Lock()
	fmt.Fprintf(os.Stderr, "testcase %s: deadline %s exceeded and the case did not stop\n", c.name, c.deadline)
	_ = pprof.Lookup("goroutine").WriteTo(os.Stderr, 2)
	os.Exit(1)
}
