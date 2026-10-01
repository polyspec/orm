// Package dbspec parses, validates and emits dbspec documents, the schema
// language that docs/dbspec.md specifies.
//
// Parse reads one document together with the declared document set that its
// `use` lines name, validates every rule of the specification and returns
// either the document or every diagnostic in source order. Emit writes a
// document in its one canonical text, so Emit(Parse(s)) == s for canonical s.
package dbspec

import "sort"

// Code is the error code of every dbspec diagnostic.
const Code = "SCHEMA_INVALID"

// Rules of a diagnostic, as listed in docs/dbspec.md "Limits and errors".
const (
	RuleHeader        = "header"
	RuleSyntax        = "syntax"
	RuleOrder         = "order"
	RuleNameFormat    = "name.format"
	RuleNameLength    = "name.length"
	RuleNameDuplicate = "name.duplicate"
	RuleType          = "type"
	RuleColumn        = "column"
	RuleKey           = "key"
	RuleForeignKey    = "foreign_key"
	RuleCheck         = "check"
	RuleSetting       = "setting"
	RuleUse           = "use"
	RuleDiagram       = "diagram"
	RuleLimit         = "limit"
	RuleEncoding      = "encoding"
)

// Diagnostic is one SCHEMA_INVALID error: the rule it breaks, the 1-based
// line and column (in Unicode code points) of the offending token, and a
// message.
type Diagnostic struct {
	Rule    string
	Line    int
	Column  int
	Message string
}

// Parse parses and validates text. documents is the declared document set:
// each document name that a `use` line may name, mapped to its text. Parse
// returns the document and nil diagnostics, or nil and every diagnostic of
// the document in source order; never both. An encoding, header or limit
// error stops parsing, so later lines are not diagnosed.
func Parse(text string, documents map[string]string) (*Document, []Diagnostic) {
	s := &session{set: documents, parsed: map[string]*parsedDocument{}}
	parsed := parseStructure(text)
	diagnostics := parsed.diagnostics
	if !parsed.stopped {
		diagnostics = append(diagnostics, s.validate(parsed.document, true)...)
	}
	if len(diagnostics) > 0 {
		sort.SliceStable(diagnostics, func(i, j int) bool {
			if diagnostics[i].Line != diagnostics[j].Line {
				return diagnostics[i].Line < diagnostics[j].Line
			}
			return diagnostics[i].Column < diagnostics[j].Column
		})
		return nil, diagnostics
	}
	return parsed.document.model(), nil
}

// Emit writes document in canonical form (docs/dbspec.md "Canonical form").
// It writes the model as given and does not validate it; a document returned
// by Parse is valid and its literals are already in canonical form.
func Emit(document *Document) string {
	return emitDocument(document)
}
