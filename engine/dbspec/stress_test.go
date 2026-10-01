package dbspec

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestStressDocument parses and emits the shared 2000-table, 60000-column,
// 10000-foreign-key document that node tests/dbspec/stress.mjs writes, and
// logs the parse and emit times. The deadline only bounds a hang; the parse
// budget is recorded from measurement.
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

		parseStarted := time.Now()
		document, diagnostics := Parse(text, nil)
		parseElapsed := time.Since(parseStarted)
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
		t.Logf("stress tables=%d columns=%d foreignKeys=%d parse=%s emit=%s", len(document.Tables), columns, foreignKeys, parseElapsed, emitElapsed)
		if len(document.Tables) != 2000 || columns != 60000 || foreignKeys != 10000 {
			return fmt.Errorf("stress document has %d tables, %d columns, %d foreign keys", len(document.Tables), columns, foreignKeys)
		}
		if first != text {
			return fmt.Errorf("emit(parse(stress)) differs from the generated canonical document")
		}
		if second != first {
			return fmt.Errorf("two emissions of the stress document differ")
		}
		return nil
	})
}
