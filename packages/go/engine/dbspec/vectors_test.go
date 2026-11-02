package dbspec

import (
	"fmt"
	"slices"
	"strings"
)

type vectorError struct {
	Line   int
	Column int
	Rule   string
}

func joinLines(lines []string, crlf bool) string {
	end := "\n"
	if crlf {
		end = "\r\n"
	}
	return strings.Join(lines, end) + end
}

// emitStable parses the text and emits it, and checks that parsing the emission again and emitting it yields the same
// bytes.
func emitStable(text string, set map[string]string) (string, error) {
	document, _, diagnostics := Parse(text, set)
	if err := expectDocument(document, diagnostics); err != nil {
		return "", err
	}
	first := Emit(document)
	again, _, diagnostics := Parse(first, set)
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

// expectDiagnostics parses the text and compares the rule, line, and column of every diagnostic, in order,
// with want.
func expectDiagnostics(text string, set map[string]string, want []vectorError) error {
	document, _, diagnostics := Parse(text, set)
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

// parseDocumentSet parses all documents of a case, in document-name order, each
// against the other documents of the case.
func parseDocumentSet(docs map[string][]string) ([]*Document, error) {
	names := make([]string, 0, len(docs))
	for name := range docs {
		names = append(names, name)
	}
	slices.Sort(names)
	documents := make([]*Document, 0, len(names))
	for _, name := range names {
		set := map[string]string{}
		for other, lines := range docs {
			if other != name {
				set[other] = joinLines(lines, false)
			}
		}
		document, _, diagnostics := Parse(joinLines(docs[name], false), set)
		if err := expectDocument(document, diagnostics); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		documents = append(documents, document)
	}
	return documents, nil
}
