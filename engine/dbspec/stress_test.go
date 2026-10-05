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

	"github.com/polyspec/orm/internal/testcase"
)

// TestStressDocument parses and emits the shared 2000-table, 60000-column,
// 10000-foreign-key document that node tests/dbspec/stress.mjs writes, and
// parses it five times. The median CPU time of the parsing thread fails above
// parseBudget (docs/dbspec.md, "Verification"); the wall-clock deadline only
// bounds a hang.
const (
	parseBudget = 100 * time.Millisecond
	parseRuns   = 5
)

func TestStressDocument(t *testing.T) {
	testcase.Start(t, testcase.Process)
	root := repositoryRoot(t)
	runTimed(t, "stress", 120*time.Second, func() error {
		generated := time.Now()
		command := exec.Command("node", filepath.Join(root, "tests", "dbspec", "stress.mjs"))
		var stdout, stderr bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		if err := command.Run(); err != nil {
			return fmt.Errorf("node tests/dbspec/stress.mjs: %w: %s", err, stderr.String())
		}
		text := stdout.String()
		t.Logf("stress generate bytes=%d lines=%d elapsed=%s", len(text), strings.Count(text, "\n"), time.Since(generated))

		var document *Document
		var diagnostics []Diagnostic
		parses := make([]time.Duration, parseRuns)
		for i := range parses {
			clock := startCaseClock(t)
			document, diagnostics = Parse(text, nil)
			cpu, wall := clock.elapsed(t)
			runtime.UnlockOSThread()
			t.Logf("stress parse cpu=%s wall=%s", cpu, wall)
			parses[i] = cpu
		}
		slices.Sort(parses)
		parseElapsed := parses[parseRuns/2]
		// 기준 작업은 같은 문서의 byte마다 checksum을 갱신하는 loop다. 네 client가 같은 계산을 같은 시계로 재고, parse
		// 시간과의 비율을 적는다. 비율은 아직 판정에 쓰지 않는다(docs/dbspec.md, Verification).
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
		// The allocating reference splits the document into lines and words and counts each word in a map: string
		// slicing, allocation and hashing, the kind of work a parse does. It is printed and not asserted until the
		// development machine and CI show whether its ratio holds across machines.
		allocations := make([]time.Duration, parseRuns)
		for i := range allocations {
			clock := startCaseClock(t)
			referenceWords = allocatingReference(text)
			allocations[i], _ = clock.elapsed(t)
			runtime.UnlockOSThread()
		}
		slices.Sort(allocations)
		allocation := allocations[parseRuns/2]
		t.Logf("stress allocating reference cpu median=%s ratio=%.2f words=%d", allocation, float64(parseElapsed)/float64(allocation), referenceWords)
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
		if parseElapsed > parseBudget {
			return fmt.Errorf("stress median parse used %s of CPU, over the %s budget (docs/dbspec.md, Verification)", parseElapsed, parseBudget)
		}
		return nil
	})
}

// referenceSum은 기준 작업의 결과다. compiler가 loop를 지우지 못하게 package 변수에 둔다.
var referenceSum uint32

// referenceScan은 stress 문서의 기준 작업이다: byte마다 h = h*31 + b(mod 2^32)를 차례로 계산한다. 앞 값에 기대는
// 계산이라 병렬로 줄일 수 없다.
func referenceScan(text string) uint32 {
	var h uint32
	for i := 0; i < len(text); i++ {
		h = h*31 + uint32(text[i])
	}
	return h
}

// referenceWords is the result of the allocating reference, kept in a package variable so the work is not removed.
var referenceWords int

// allocatingReference splits text into lines and the lines into words, and counts each word in a map; it returns
// the number of distinct words.
func allocatingReference(text string) int {
	counts := map[string]int{}
	for _, line := range strings.Split(text, "\n") {
		for _, word := range strings.Fields(line) {
			counts[word]++
		}
	}
	return len(counts)
}
