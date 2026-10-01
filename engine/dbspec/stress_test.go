package dbspec

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestStressDocument parses and emits the shared 2000-table, 60000-column,
// 10000-foreign-key document that node tests/dbspec/stress.mjs writes, and
// parses it five times. The median parse fails above parseBudget
// (docs/dbspec.md, "Verification"); the deadline only bounds a hang.
const (
	parseBudget = 100 * time.Millisecond
	parseRuns   = 5
)

func TestStressDocument(t *testing.T) {
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
			parseStarted := time.Now()
			document, diagnostics = Parse(text, nil)
			parses[i] = time.Since(parseStarted)
		}
		slices.Sort(parses)
		parseElapsed := parses[parseRuns/2]
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
		t.Logf("stress tables=%d columns=%d foreignKeys=%d parse min=%s median=%s max=%s emit=%s", len(document.Tables), columns, foreignKeys, parses[0], parseElapsed, parses[parseRuns-1], emitElapsed)
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
			return fmt.Errorf("stress median parse took %s, over the %s budget (docs/dbspec.md, Verification)", parseElapsed, parseBudget)
		}
		return nil
	})
}
