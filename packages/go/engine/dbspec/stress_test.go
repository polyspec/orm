//go:build bench

package dbspec

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
	"golang.org/x/sys/unix"
)

// TestStressDocument parses and emits the shared 2000-table, 60000-column,
// 10000-foreign-key document that node tests/dbspec/stress.mts writes, and
// parses it five times. It prints the median CPU time of the parsing thread,
// the median CPU time of the reference work and their ratio, and a warning when
// the ratio exceeds referenceRatio (docs/spec/dbspec.md, "Verification"); a
// measurement never fails the test. The wall-clock deadline only bounds a hang.
const (
	referenceRatio = 63.0
	parseRuns      = 5
)

// Requirements: DBS-123.
func TestStressDocument(t *testing.T) {
	testcase.Start(t, testcase.Process)
	root := repositoryRoot(t)
	runTimed(t, "stress", 120*time.Second, func() error {
		generated := time.Now()
		command := exec.Command("node", filepath.Join(root, "tests", "dbspec", "stress.mts"))
		var stdout, stderr bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		if err := command.Run(); err != nil {
			return fmt.Errorf("node tests/dbspec/stress.mts: %w: %s", err, stderr.String())
		}
		text := stdout.String()
		t.Logf("stress generate bytes=%d lines=%d elapsed=%s", len(text), strings.Count(text, "\n"), time.Since(generated))

		var document *Document
		var diagnostics []Diagnostic
		parses := make([]time.Duration, parseRuns)
		for i := range parses {
			clock := startCaseClock(t)
			document, _, diagnostics = Parse(text, nil)
			cpu, wall := clock.elapsed(t)
			runtime.UnlockOSThread()
			t.Logf("stress parse cpu=%s wall=%s", cpu, wall)
			parses[i] = cpu
		}
		slices.Sort(parses)
		parseElapsed := parses[parseRuns/2]
		// The reference work is a loop that updates a checksum for each byte of the same document. It is timed with the same clock in the same process, and it prints the ratio of the parse time to
		// that work (docs/spec/dbspec.md, Verification).
		references := make([]time.Duration, parseRuns)
		for i := range references {
			clock := startCaseClock(t)
			referenceSum = referenceScan(text)
			references[i], _ = clock.elapsed(t)
			runtime.UnlockOSThread()
		}
		slices.Sort(references)
		reference := references[parseRuns/2]
		t.Logf("stress reference cpu median=%s ratio=%.2f", reference, float64(parseElapsed)/float64(reference))
		if err := expectDocument(document, diagnostics); err != nil {
			return err
		}
		emitStarted := time.Now()
		first := Emit(document)
		emitElapsed := time.Since(emitStarted)
		second := Emit(document)
		columns, foreignKeys := 0, 0
		for _, table := range document.Tables {
			columns += len(table.Columns)
			foreignKeys += len(table.ForeignKeys)
		}
		t.Logf("stress tables=%d columns=%d foreignKeys=%d parse cpu min=%s median=%s max=%s emit=%s", len(document.Tables), columns, foreignKeys, parses[0], parseElapsed, parses[parseRuns-1], emitElapsed)
		if len(document.Tables) != 2000 || columns != 60000 || foreignKeys != 10000 {
			return fmt.Errorf("stress document has %d tables, %d columns, %d foreign keys", len(document.Tables), columns, foreignKeys)
		}
		if first != text {
			return fmt.Errorf("emit(parse(stress)) differs from the generated canonical document")
		}
		if second != first {
			return fmt.Errorf("two emissions of the stress document differ")
		}
		ratio := float64(parseElapsed) / float64(reference)
		machine := runtime.GOOS + " " + runtime.GOARCH
		t.Logf("stress parse ratio %.2f to the reference on %s (reference ratio %.0f)", ratio, machine, referenceRatio)
		if ratio > referenceRatio {
			testcase.Warn("stress median parse CPU of %s is %.2f times the reference CPU of %s, above the reference ratio %.0f (docs/spec/dbspec.md, Verification); machine %s", parseElapsed, ratio, reference, referenceRatio, machine)
		}
		return nil
	})
}

// referenceSum is the result of the reference work. It is kept in a package variable so the compiler cannot delete the loop.
var referenceSum uint32

// referenceScan is the reference work for the stress document: for each byte it computes h = h*31 + b (mod 2^32) in order. It depends on the previous value,
// so it cannot be reduced in parallel.
func referenceScan(text string) uint32 {
	var h uint32
	for i := 0; i < len(text); i++ {
		h = h*31 + uint32(text[i])
	}
	return h
}

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
