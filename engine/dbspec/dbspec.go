// Package dbspec parses, validates and emits dbspec documents, the schema
// language that docs/dbspec.md specifies.
//
// Parse reads one document together with the declared document set that its
// `use` lines name, validates every rule of the specification and returns
// either the document or every diagnostic in source order. Emit writes a
// document in its one canonical text, so Emit(Parse(s)) == s for canonical s.
package dbspec

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"sort"
	"strings"
)

// Code is the error code of every dbspec diagnostic.
const Code = "SCHEMA_INVALID"

// Rules of a diagnostic, as listed in docs/dbspec.md "Limits and errors".
const (
	RuleSignature     = "signature"
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
// the document ordered by line, column and rule; never both. An encoding,
// header or limit error stops parsing: it follows the diagnostics found
// before it, and later lines are not diagnosed.
func Parse(text string, documents map[string]string) (*Document, []Diagnostic) {
	s := &session{set: documents, parsed: map[string]*parsedDocument{}}
	parsed := parseStructure(text)
	diagnostics := parsed.diagnostics
	if !parsed.stopped {
		diagnostics = append(diagnostics, s.validate(parsed.document, []string{parsed.document.name.text})...)
	}
	if len(diagnostics) > 0 {
		sortDiagnostics(diagnostics)
		return nil, diagnostics
	}
	return parsed.document.model(), nil
}

// ruleOrder is the order of the rule table, which breaks ties between
// diagnostics at one position.
var ruleOrder = map[string]int{
	RuleHeader: 0, RuleSyntax: 1, RuleOrder: 2, RuleNameFormat: 3, RuleNameLength: 4,
	RuleNameDuplicate: 5, RuleType: 6, RuleColumn: 7, RuleKey: 8, RuleForeignKey: 9,
	RuleCheck: 10, RuleSetting: 11, RuleUse: 12, RuleDiagram: 13, RuleLimit: 14, RuleEncoding: 15,
}

// sortDiagnostics orders diagnostics by line, column and rule table order,
// keeping the order of equal diagnostics.
func sortDiagnostics(diagnostics []Diagnostic) {
	sort.SliceStable(diagnostics, func(i, j int) bool {
		a, b := diagnostics[i], diagnostics[j]
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		if a.Column != b.Column {
			return a.Column < b.Column
		}
		return ruleOrder[a.Rule] < ruleOrder[b.Rule]
	})
}

// Emit writes document in canonical form (docs/dbspec.md "Canonical form").
// It writes the model as given and does not validate it; a document returned
// by Parse is valid and its literals are already in canonical form.
func Emit(document *Document) string {
	return emitDocument(document, viewCanonical)
}

// Manifest holds the manifest and schema texts of a document set and their
// hashes (docs/dbspec.md, "Manifest and hashes").
type Manifest struct {
	ManifestText string
	SchemaText   string
	ManifestHash string
	SchemaHash   string
}

// checkSet reports a document name that repeats and a used document missing
// from the set, at the header name of the later or the using document
// (docs/dbspec.md, "Manifest and hashes"). It returns the documents in name
// order.
func checkSet(documents []*Document) ([]*Document, []Diagnostic) {
	ordered := slices.Clone(documents)
	slices.SortStableFunc(ordered, func(a, b *Document) int { return cmp.Compare(a.Name, b.Name) })
	names := map[string]bool{}
	for _, d := range ordered {
		names[d.Name] = true
	}
	header := len("dbspec 1 ") + 1
	var out []Diagnostic
	for i, d := range ordered {
		if i > 0 && ordered[i-1].Name == d.Name {
			out = append(out, Diagnostic{Rule: RuleNameDuplicate, Line: 1, Column: header, Message: "document " + d.Name + " appears twice in the document set"})
		}
		used := make([]string, 0, len(d.Uses))
		for _, u := range d.Uses {
			used = append(used, u.Document)
		}
		slices.Sort(used)
		for _, name := range used {
			if !names[name] {
				out = append(out, Diagnostic{Rule: RuleUse, Line: 1, Column: header, Message: "document " + d.Name + " uses " + name + ", which is not in the document set"})
			}
		}
	}
	return ordered, out
}

// ManifestOf returns the manifest of the document set, whose documents are
// taken in document name order, or the diagnostics of an invalid set.
func ManifestOf(documents []*Document) (*Manifest, []Diagnostic) {
	ordered, diagnostics := checkSet(documents)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	var manifest strings.Builder
	schema := &Document{Name: "schema"}
	for _, d := range ordered {
		manifest.WriteString(emitDocument(d, viewManifest))
		schema.Tables = append(schema.Tables, d.Tables...)
	}
	// schema text는 집합의 모든 table을 이름 순으로 담은 문서 schema 하나이므로
	// 문서를 나누는 방식과 무관하다.
	slices.SortStableFunc(schema.Tables, func(a, b Table) int { return cmp.Compare(a.Name, b.Name) })
	schemaText := emitDocument(schema, viewSchema)
	return &Manifest{
		ManifestText: manifest.String(),
		SchemaText:   schemaText,
		ManifestHash: textHash(manifest.String()),
		SchemaHash:   textHash(schemaText),
	}, nil
}

// textHash is sha256: and the lower-case hexadecimal SHA-256 of the text.
func textHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return "sha256:" + hex.EncodeToString(sum[:])
}
