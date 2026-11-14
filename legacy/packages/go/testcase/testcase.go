// Package testcase is a helper that starts each go test case and records its steps in the test's log.
//
// The report is the native output of go test. The results of the cases started with Start (`--- PASS`, `--- FAIL`, `--- SKIP`) and
// the steps (lines of t.Log) are printed as they are by go test -json or -v. Group marks a group and writes no line.
//
// Run and RunLong of the non-test runner run a case without a test and write its steps to stdout as they are. The result is
// decided by the error returned. Long runner jobs (build, install, tool run) run with RunLong.
//
// No clock ends a case (T474): a machine under load runs the same work more slowly, and the result of a case must not change
// with that load. A case ends when its work ends; a run that does not end is stopped with its run.
package testcase

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
)

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
	name   string
	ctx    context.Context
	cancel context.CancelFunc
	log    func(line string)
}

// Start starts t as a case. Its Context ends when the test ends; no clock ends it. The result is reported to t by go test.
func Start(t testing.TB) *Case {
	t.Helper()
	c := &Case{name: t.Name(), log: func(line string) { t.Log(line) }}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	started.Store(c.name, c)
	t.Cleanup(func() {
		started.Delete(c.name)
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
			cs, ok := c.(*Case)
			if !ok {
				t.Fatalf("testcase.Of: the value started for %s is %T, not a *Case", name, c)
			}
			return cs
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

// Group marks a test that groups cases, each started with Start. The group itself writes no line.
func Group(t testing.TB) {
	t.Helper()
}

// Run runs one case for a non-test runner (the check command). The error of work is the result; no clock ends the case.
func Run(name string, work func(c *Case) error) error {
	return run(name, work)
}

// RunLong runs one long job (build, install, tool run) for a non-test runner. Success and failure are decided by the result
// work observed (the command's exit code and errors).
func RunLong(name string, work func(c *Case) error) error {
	return run(name, work)
}

// run runs work as the case name and returns its error, with a panic of work as its error. c.Context() ends when work returns.
func run(name string, work func(c *Case) error) error {
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
// one line on stdout. A case that runs long calls Step at each step, so that its progress is observable.
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

// Context is the context of the case, which ends when the case ends.
func (c *Case) Context() context.Context { return c.ctx }
