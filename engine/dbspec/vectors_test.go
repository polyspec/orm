package dbspec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type vectorFile struct {
	Version   int          `json:"version"`
	Canonical []vectorCase `json:"canonical"`
	Normalize []vectorCase `json:"normalize"`
	Invalid   []vectorCase `json:"invalid"`
}

type vectorCase struct {
	ID        string              `json:"id"`
	CRLF      bool                `json:"crlf"`
	Mixed     bool                `json:"mixed"`
	Documents map[string][]string `json:"documents"`
	Main      string              `json:"main"`
	Canonical []string            `json:"canonical"`
	Errors    []vectorError       `json:"errors"`
}

type vectorError struct {
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Rule   string `json:"rule"`
}

func joinLines(lines []string, crlf bool) string {
	end := "\n"
	if crlf {
		end = "\r\n"
	}
	return strings.Join(lines, end) + end
}

// join writes the lines of one case document: with LF, with CRLF, or for a
// mixed case alternating CRLF and LF from CRLF without a final line end.
func (c vectorCase) join(lines []string) string {
	if !c.Mixed {
		return joinLines(lines, c.CRLF)
	}
	var b strings.Builder
	for i, line := range lines {
		if i > 0 {
			if i%2 == 1 {
				b.WriteString("\r\n")
			} else {
				b.WriteString("\n")
			}
		}
		b.WriteString(line)
	}
	return b.String()
}

// documentSet returns the main text and the declared document set: every
// document of the case other than main.
func (c vectorCase) documentSet() (string, map[string]string, error) {
	main, ok := c.Documents[c.Main]
	if !ok {
		return "", nil, fmt.Errorf("main document %q is not listed", c.Main)
	}
	set := map[string]string{}
	for name, lines := range c.Documents {
		if name != c.Main {
			set[name] = c.join(lines)
		}
	}
	return c.join(main), set, nil
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repositoryRoot(t), "tests", "dbspec", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors vectorFile
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("tests/dbspec/cases.json: %v", err)
	}
	if vectors.Version != 1 {
		t.Fatalf("tests/dbspec/cases.json version = %d, want 1", vectors.Version)
	}
	if len(vectors.Canonical) == 0 || len(vectors.Normalize) == 0 || len(vectors.Invalid) == 0 {
		t.Fatal("tests/dbspec/cases.json has an empty case group")
	}
	seen := map[string]bool{}
	for _, group := range [][]vectorCase{vectors.Canonical, vectors.Normalize, vectors.Invalid} {
		for _, c := range group {
			if c.ID == "" || seen[c.ID] {
				t.Fatalf("case id %q is empty or repeated", c.ID)
			}
			seen[c.ID] = true
		}
	}
	return vectors
}

// emitStable parses text, emits it, and checks that parsing and emitting the
// emission again reproduces it byte for byte.
func emitStable(text string, set map[string]string) (string, error) {
	document, diagnostics := Parse(text, set)
	if err := expectDocument(document, diagnostics); err != nil {
		return "", err
	}
	first := Emit(document)
	again, diagnostics := Parse(first, set)
	if err := expectDocument(again, diagnostics); err != nil {
		return "", fmt.Errorf("parse of the emission: %w", err)
	}
	if second := Emit(again); second != first {
		return "", fmt.Errorf("emission is not idempotent:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
	return first, nil
}

func expectDocument(document *Document, diagnostics []Diagnostic) error {
	if len(diagnostics) != 0 {
		return fmt.Errorf("unexpected diagnostics %+v", diagnostics)
	}
	if document == nil {
		return fmt.Errorf("Parse returned neither a document nor diagnostics")
	}
	return nil
}

func TestSharedVectors(t *testing.T) {
	vectors := loadVectors(t)
	for _, c := range vectors.Canonical {
		t.Run("canonical/"+c.ID, func(t *testing.T) {
			runTimed(t, "canonical/"+c.ID, 5*time.Second, func() error {
				text, set, err := c.documentSet()
				if err != nil {
					return err
				}
				got, err := emitStable(text, set)
				if err != nil {
					return err
				}
				if want := joinLines(c.Documents[c.Main], false); got != want {
					return fmt.Errorf("emission differs:\ngot:\n%s\nwant:\n%s", got, want)
				}
				return nil
			})
		})
	}
	for _, c := range vectors.Normalize {
		t.Run("normalize/"+c.ID, func(t *testing.T) {
			runTimed(t, "normalize/"+c.ID, 5*time.Second, func() error {
				text, set, err := c.documentSet()
				if err != nil {
					return err
				}
				got, err := emitStable(text, set)
				if err != nil {
					return err
				}
				if want := joinLines(c.Canonical, false); got != want {
					return fmt.Errorf("emission differs:\ngot:\n%s\nwant:\n%s", got, want)
				}
				return nil
			})
		})
	}
	for _, c := range vectors.Invalid {
		t.Run("invalid/"+c.ID, func(t *testing.T) {
			runTimed(t, "invalid/"+c.ID, 5*time.Second, func() error {
				text, set, err := c.documentSet()
				if err != nil {
					return err
				}
				return expectDiagnostics(text, set, c.Errors)
			})
		})
	}
}

// expectDiagnostics parses text and compares rule, line and column of every
// diagnostic, in order, with want.
func expectDiagnostics(text string, set map[string]string, want []vectorError) error {
	document, diagnostics := Parse(text, set)
	if document != nil {
		return fmt.Errorf("Parse returned a document for an invalid source")
	}
	got := make([]vectorError, len(diagnostics))
	for i, d := range diagnostics {
		if d.Message == "" {
			return fmt.Errorf("diagnostic %+v has no message", d)
		}
		got[i] = vectorError{Line: d.Line, Column: d.Column, Rule: d.Rule}
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		return fmt.Errorf("diagnostics = %+v, want %+v (messages %+v)", got, want, diagnostics)
	}
	return nil
}
