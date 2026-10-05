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
// parses it five times. It prints the median CPU time of the parsing thread,
// the median CPU time of the reference work and their ratio, and a warning when
// the ratio exceeds referenceRatio (docs/dbspec.md, "Verification"); a
// measurement never fails the test. The wall-clock deadline only bounds a hang.
const (
	referenceRatio = 63.0
	parseRuns      = 5
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
		// 기준 작업은 같은 문서의 byte마다 checksum을 갱신하는 loop다. 같은 process에서 같은 시계로 재고, parse 시간과의
		// 비율을 출력한다(docs/dbspec.md, Verification).
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
			testcase.Warn("stress median parse CPU of %s is %.2f times the reference CPU of %s, above the reference ratio %.0f (docs/dbspec.md, Verification); machine %s", parseElapsed, ratio, reference, referenceRatio, machine)
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
