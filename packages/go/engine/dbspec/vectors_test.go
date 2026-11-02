package dbspec

import (
	"fmt"
	"strings"
	"testing"
)

// vectorFile is what the engine tests read from tests/dbspec/cases.json: the hashes and sets cases. The canonical,
// normalize, invalid, positions and files cases are run by the recipes of tests/dbspec (recipe_*_test.go in package orm).
type vectorFile struct {
	Hashes []hashCase
	Sets   []setCase
}

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

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	r, object := readVectorFile(t, "cases.json")
	vectors, err := decodeCaseVectors(r, object)
	if err != nil {
		t.Fatal(err)
	}
	return vectors
}

// decodeCaseVectors reads the sections and fields of cases.json that the engine tests use, and rejects any that are
// missing or of another type with location. A section or field that the format does not name is refused too.
func decodeCaseVectors(r vectorReader, object map[string]any) (vectorFile, error) {
	var v vectorFile
	if err := r.fields(object, "", []string{"requirements", "version", "note", "hashes", "sets"}); err != nil {
		return v, err
	}
	if err := r.version(object); err != nil {
		return v, err
	}
	if _, err := r.string(object, "", "note"); err != nil {
		return v, err
	}
	var err error
	if v.Hashes, err = vectorCases(r, object, "hashes", func(c map[string]any, location, id string) (hashCase, error) {
		h := hashCase{ID: id}
		if err := r.fields(c, location, []string{"id", "documents", "manifestText", "schemaText", "manifestHash", "schemaHash"}); err != nil {
			return h, err
		}
		var err error
		if h.Documents, err = r.linesMap(c, location, "documents"); err != nil {
			return h, err
		}
		if h.ManifestText, err = r.linesField(c, location, "manifestText"); err != nil {
			return h, err
		}
		if h.SchemaText, err = r.linesField(c, location, "schemaText"); err != nil {
			return h, err
		}
		if h.ManifestHash, err = r.string(c, location, "manifestHash"); err != nil {
			return h, err
		}
		h.SchemaHash, err = r.string(c, location, "schemaHash")
		return h, err
	}); err != nil {
		return v, err
	}
	v.Sets, err = vectorCases(r, object, "sets", func(c map[string]any, location, id string) (setCase, error) {
		s := setCase{ID: id}
		if err := r.fields(c, location, []string{"id", "documents", "parsing", "errors"}, "external", "manifest"); err != nil {
			return s, err
		}
		items, err := r.arrayField(c, location, "documents")
		if err != nil {
			return s, err
		}
		for i, item := range items {
			lines, err := r.lines(item, fmt.Sprintf("%s[%d]", vectorAt(location, "documents"), i))
			if err != nil {
				return s, err
			}
			s.Documents = append(s.Documents, lines)
		}
		if s.Parsing, err = r.linesMap(c, location, "parsing"); err != nil {
			return s, err
		}
		// external and manifest exist only in cases that have external documents.
		if _, ok := c["external"]; ok {
			items, err := r.arrayField(c, location, "external")
			if err != nil {
				return s, err
			}
			for i, item := range items {
				lines, err := r.lines(item, fmt.Sprintf("%s[%d]", vectorAt(location, "external"), i))
				if err != nil {
					return s, err
				}
				s.External = append(s.External, lines)
			}
		}
		if _, ok := c["manifest"]; ok {
			field, err := r.field(c, location, "manifest")
			if err != nil {
				return s, err
			}
			object, ok := field.(map[string]any)
			if !ok {
				return s, r.fail(vectorAt(location, "manifest"), "is not an object")
			}
			at := vectorAt(location, "manifest")
			if err := r.fields(object, at, []string{"manifestText", "externalText", "schemaText", "created", "manifestHash", "schemaHash"}); err != nil {
				return s, err
			}
			m := &setManifest{}
			for key, target := range map[string]*[]string{"manifestText": &m.ManifestText, "externalText": &m.ExternalText, "schemaText": &m.SchemaText, "created": &m.Created} {
				if *target, err = r.linesField(object, at, key); err != nil {
					return s, err
				}
			}
			if m.ManifestHash, err = r.string(object, at, "manifestHash"); err != nil {
				return s, err
			}
			if m.SchemaHash, err = r.string(object, at, "schemaHash"); err != nil {
				return s, err
			}
			s.Manifest = m
		}
		s.Errors, err = r.locatedErrors(c, location, "errors")
		return s, err
	})
	if err != nil {
		return v, err
	}
	return v, err
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
