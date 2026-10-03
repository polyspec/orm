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
	// ExternalText는 외부 문서마다 소유한 문서가 쓰는 table의 column, primary key,
	// unique key만 담은 canonical text다. 외부 문서가 없으면 비어 있다.
	ExternalText string
	SchemaText   string
	ManifestHash string
	SchemaHash   string
}

// checkSet reports a document name that repeats, a used document missing
// from the set and an external document that no owned document reaches through
// use, at the header name of the later, the using or the external document
// (docs/dbspec.md, "Manifest and hashes"). It returns the documents in name
// order.
func checkSet(documents []*Document) ([]*Document, []Diagnostic) {
	ordered := slices.Clone(documents)
	slices.SortStableFunc(ordered, func(a, b *Document) int { return cmp.Compare(a.Name, b.Name) })
	byName := map[string]*Document{}
	for _, d := range ordered {
		byName[d.Name] = d
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
			if byName[name] == nil {
				out = append(out, Diagnostic{Rule: RuleUse, Line: 1, Column: header, Message: "document " + d.Name + " uses " + name + ", which is not in the document set"})
			}
		}
	}
	// 외부 문서는 소유한 문서에서 use를 따라 닿는 문서다.
	reached := map[string]bool{}
	var walk func(d *Document)
	walk = func(d *Document) {
		for _, u := range d.Uses {
			if next := byName[u.Document]; next != nil && !reached[next.Name] {
				reached[next.Name] = true
				walk(next)
			}
		}
	}
	for _, d := range ordered {
		if !d.External {
			walk(d)
		}
	}
	for _, d := range ordered {
		if d.External && !reached[d.Name] {
			out = append(out, Diagnostic{Rule: RuleUse, Line: 1, Column: header, Message: "external document " + d.Name + " is not used by a document of the set"})
		}
	}
	return ordered, out
}

// ManifestOf returns the manifest of the document set, whose documents are
// taken in document name order, or the diagnostics of an invalid set. The
// manifest text holds the owned documents; the external text holds, for each
// external document, the tables that owned documents use, with their columns,
// primary key and unique keys; the schema text holds the owned tables and a
// use line for each external document they use; and manifestHash covers the
// manifest text followed by the external text.
func ManifestOf(documents []*Document) (*Manifest, []Diagnostic) {
	ordered, diagnostics := checkSet(documents)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	used := map[string][]string{}
	for _, d := range ordered {
		if d.External {
			continue
		}
		for _, u := range d.Uses {
			for _, table := range u.Tables {
				if !slices.Contains(used[u.Document], table) {
					used[u.Document] = append(used[u.Document], table)
				}
			}
		}
	}
	var manifest, external strings.Builder
	schema := &Document{Name: "schema"}
	for _, d := range ordered {
		if d.External {
			if trimmed := externalDocument(d, used[d.Name]); trimmed != nil {
				external.WriteString(emitDocument(trimmed, viewManifest))
				tables := slices.Clone(used[d.Name])
				slices.Sort(tables)
				schema.Uses = append(schema.Uses, Use{Document: d.Name, Tables: tables})
			}
			continue
		}
		manifest.WriteString(emitDocument(d, viewManifest))
		schema.Tables = append(schema.Tables, d.Tables...)
	}
	// schema text는 집합이 소유한 모든 table을 이름 순으로 담은 문서 schema
	// 하나이므로 문서를 나누는 방식과 무관하다. 외부 문서에서 쓰는 table은 그
	// 문서의 use 줄로 남는다.
	slices.SortStableFunc(schema.Tables, func(a, b Table) int { return cmp.Compare(a.Name, b.Name) })
	schemaText := emitDocument(schema, viewSchema)
	return &Manifest{
		ManifestText: manifest.String(),
		ExternalText: external.String(),
		SchemaText:   schemaText,
		ManifestHash: textHash(manifest.String() + external.String()),
		SchemaHash:   textHash(schemaText),
	}, nil
}

// externalDocument는 외부 문서에서 tables의 column, primary key, unique key만
// 문서 순서로 담은 문서다. 그 table이 없으면 nil이다. foreign key, index,
// check, setting은 외부 문서가 소유하므로 담지 않는다.
func externalDocument(d *Document, tables []string) *Document {
	out := &Document{Name: d.Name}
	for _, t := range d.Tables {
		if slices.Contains(tables, t.Name) {
			out.Tables = append(out.Tables, Table{Name: t.Name, Columns: t.Columns, PrimaryKey: PrimaryKey{Columns: t.PrimaryKey.Columns}, Uniques: t.Uniques})
		}
	}
	if len(out.Tables) == 0 {
		return nil
	}
	return out
}

// ExternalDifferences는 set이 외부 문서에서 쓰는 table이 database에 있는지
// 확인한다(docs/dbspec.md "External documents"). live는 database를 introspect한
// 문서다. 쓰는 table마다 table이 없거나, 외부 문서의 column이 없거나 type이나 null이
// 다르거나, primary key가 다르거나, unique key의 column 목록이 없으면 그 차이를
// table, column 순으로 돌려준다. 외부 문서가 없으면 nil이다.
func ExternalDifferences(live *Document, documents []*Document) []string {
	byName := map[string]*Document{}
	for _, d := range documents {
		if d.External {
			byName[d.Name] = d
		}
	}
	var tables []*Table
	seen := map[string]bool{}
	for _, d := range documents {
		if d.External {
			continue
		}
		for _, u := range d.Uses {
			external := byName[u.Document]
			if external == nil {
				continue
			}
			for _, name := range u.Tables {
				for i := range external.Tables {
					if t := &external.Tables[i]; t.Name == name && !seen[name] {
						seen[name] = true
						tables = append(tables, t)
					}
				}
			}
		}
	}
	slices.SortFunc(tables, func(a, b *Table) int { return cmp.Compare(a.Name, b.Name) })
	liveTables := map[string]*Table{}
	for i := range live.Tables {
		liveTables[live.Tables[i].Name] = &live.Tables[i]
	}
	var out []string
	for _, want := range tables {
		got := liveTables[want.Name]
		if got == nil {
			out = append(out, "table "+want.Name+" does not exist")
			continue
		}
		for _, c := range want.Columns {
			g := columnOf(got, c.Name)
			switch {
			case g == nil:
				out = append(out, "column "+want.Name+"."+c.Name+" does not exist")
			case g.Type.String() != c.Type.String():
				out = append(out, "column "+want.Name+"."+c.Name+" is "+g.Type.String()+", not "+c.Type.String())
			case g.Null != c.Null:
				out = append(out, "column "+want.Name+"."+c.Name+" is "+nullText(g.Null)+", not "+nullText(c.Null))
			}
		}
		if !slices.Equal(got.PrimaryKey.Columns, want.PrimaryKey.Columns) {
			out = append(out, "table "+want.Name+" has the primary key ("+strings.Join(got.PrimaryKey.Columns, ", ")+"), not ("+strings.Join(want.PrimaryKey.Columns, ", ")+")")
		}
		for _, u := range want.Uniques {
			if !slices.ContainsFunc(got.Uniques, func(g Unique) bool { return slices.Equal(g.Columns, u.Columns) }) {
				out = append(out, "table "+want.Name+" has no unique key ("+strings.Join(u.Columns, ", ")+")")
			}
		}
	}
	return out
}

func nullText(null bool) string {
	if null {
		return "null"
	}
	return "not null"
}

// textHash is sha256: and the lower-case hexadecimal SHA-256 of the text.
func textHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return "sha256:" + hex.EncodeToString(sum[:])
}
