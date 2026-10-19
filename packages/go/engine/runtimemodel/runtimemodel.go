// Package runtimemodel builds the runtime model of a dbspec document set
// (docs/spec/dbspec.md, "Runtime model"). It is read by the planner, executor, and generator.
// It holds the entities, fields, keys, default select set, codecs, and executor settings.
// A model is built from a parsed document or from the manifest text that generated code holds.
package runtimemodel

import (
	"fmt"
	"slices"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
)

// Model is the runtime model of one document set.
type Model struct {
	// ManifestText and ManifestHash identify the document set, and every request
	// carries the ManifestHash.
	ManifestText string
	ManifestHash string
	// ExternalText is the text of the tables that external documents write, which the owning document uses (dbspec.Manifest).
	ExternalText string
	// Documents are the parsed documents in document-name order, and schema installation
	// renders them.
	Documents []*dbspec.Document
	// Order is the list of entity names of the set: documents in name order, tables in document
	// order. A table of an external document that an owned document uses is an external entity,
	// reduced to its columns, primary key and unique keys (docs/spec/dbspec.md "External documents").
	Order    []string
	Entities map[string]*Entity
}

// Entity is one table of the document set.
type Entity struct {
	// Name is the `entity` setting or the table name.
	Name  string
	Table string
	// PK is the primary key columns in key order.
	PK []string
	// Identity is the identity column; it is empty if there is none.
	Identity string
	Fields   []*Field
	// Uniques are the unique keys in name order.
	Uniques []Key
	// Indexes is a map from index name to its columns.
	Indexes map[string][]string
	// Updated, SoftDelete, and AESVersion are each setting's column; they are empty
	// if there is none.
	Updated    string
	SoftDelete string
	AESVersion string
	// Audit is the audit setting; it is nil if absent.
	Audit *Audit
	// External reports a table of an external document: it is read like any entity, and every
	// write fails with CONFIG before any statement.
	External bool

	fields map[string]*Field
}

// Key is a named unique key.
type Key struct {
	Name    string
	Columns []string
}

// Audit is the part of the audit setting that the executor uses. Every insert and
// update of the table writes the transaction's audit record key to Column. Record is the name of
// the audit record table. That table may be a table of an external document, so it is not an entity;
// it is determined as a table.
type Audit struct {
	History string
	Column  string
	Record  string
}

// Field is one column of an entity, with its value type and settings.
type Field struct {
	Name string
	// Type is a dbspec type kind: i16, i32, i64, bool, decimal, f64, varchar,
	// text, bytes, uuid, date, time, datetime.
	Type string
	// Length is n of varchar(n); Precision is p of decimal(p,s), time(p),
	// datetime(p); Scale is s of decimal(p,s).
	Length    int
	Precision int
	Scale     int
	Null      bool
	Identity  bool
	// Default means a declared default exists. An insert that omits the column
	// receives the database default.
	Default bool
	// DefaultNow means the default is `now`. Dialects that use the executor clock (PostgreSQL,
	// SQLite) bind the executor clock to an insert that omits this column.
	DefaultNow bool
	// A field that is SelectExplicit is left out of the default select set.
	SelectExplicit bool
	// Codec is the list of codec stages in write order.
	Codec []string
	// BlindIndex is the index column of an AES field; it is empty if there is none.
	BlindIndex string
	PrimaryKey bool
	ForeignKey bool
}

// Field finds a field by name and returns nil if there is none.
func (e *Entity) Field(name string) *Field { return e.fields[name] }

// styledStages are the codec stages whose value becomes a styled value of the common value model
// stages.
var styledStages = []string{"ordered_json", "serialize", "yaml", "gz", "base64"}

// Styled reports whether the field holds a styled value. It does if its codec stages include
// ordered_json, serialize, yaml, gz, or base64.
func (f *Field) Styled() bool {
	return slices.ContainsFunc(f.Codec, func(stage string) bool { return slices.Contains(styledStages, stage) })
}

// Encrypted reports whether the field's codec stages include aes.
func (f *Field) Encrypted() bool { return slices.Contains(f.Codec, "aes") }

// Build returns the runtime model of the document set, and returns
// diagnostics if the set is invalid.
func Build(documents []*dbspec.Document) (*Model, []dbspec.Diagnostic) {
	manifest, diagnostics := dbspec.ManifestOf(documents)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	ordered := slices.Clone(documents)
	slices.SortStableFunc(ordered, func(a, b *dbspec.Document) int { return strings.Compare(a.Name, b.Name) })
	m := &Model{ManifestText: manifest.ManifestText, ManifestHash: manifest.ManifestHash, ExternalText: manifest.ExternalText, Documents: ordered, Entities: map[string]*Entity{}}
	used := usedTables(ordered)
	for _, document := range ordered {
		tables := document.Tables
		if document.External {
			tables = externalTables(document, used[document.Name])
		}
		for i := range tables {
			e := entityOf(&tables[i])
			e.External = document.External
			if _, duplicate := m.Entities[e.Name]; duplicate {
				return nil, []dbspec.Diagnostic{{Rule: dbspec.RuleNameDuplicate, Line: 1, Column: 1, Message: fmt.Sprintf("entity %s of document %s repeats an entity name of the document set", e.Name, document.Name)}}
			}
			m.Entities[e.Name] = e
			m.Order = append(m.Order, e.Name)
		}
	}
	return m, nil
}

// usedTables returns, per external document name, the tables that owned documents name in their use lines.
func usedTables(documents []*dbspec.Document) map[string][]string {
	used := map[string][]string{}
	for _, d := range documents {
		if d.External {
			continue
		}
		for _, u := range d.Uses {
			used[u.Document] = append(used[u.Document], u.Tables...)
		}
	}
	return used
}

// externalTables returns the used tables of an external document in document order, each reduced to its
// columns, primary key and unique keys, as the external text holds them, so a model built from the documents
// equals one built from the external text.
func externalTables(d *dbspec.Document, used []string) []dbspec.Table {
	var out []dbspec.Table
	for _, t := range d.Tables {
		if slices.Contains(used, t.Name) {
			out = append(out, dbspec.Table{Name: t.Name, Columns: t.Columns, PrimaryKey: dbspec.PrimaryKey{Columns: t.PrimaryKey.Columns}, Uniques: t.Uniques})
		}
	}
	return out
}

// Load parses manifest text (the canonical documents the set owns, joined in document-name
// order) and returns the runtime model. A line that begins with "dbspec " starts a document.
// LoadSet parses manifest text and external text (the tables that external documents write)
func Load(text string) (*Model, []dbspec.Diagnostic) {
	return LoadSet(text, "")
}

// and returns the runtime model. External documents are parsed among themselves, and owned documents are parsed
// with all documents as the set.
// LoadDocuments parses a list of document texts as one document set and
func LoadSet(text, external string) (*Model, []dbspec.Diagnostic) {
	texts, diagnostics := splitDocuments(text)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	var externalTexts []string
	if external != "" {
		if externalTexts, diagnostics = splitDocuments(external); len(diagnostics) > 0 {
			return nil, diagnostics
		}
	}
	return LoadDocumentSet(texts, externalTexts)
}

// returns the runtime model. A document name is the header name of each text.
// LoadDocumentSet returns the runtime model of a document set made from the owned document
func LoadDocuments(documents []string) (*Model, []dbspec.Diagnostic) {
	return LoadDocumentSet(documents, nil)
}

// texts and external document texts,
// as a set.
func LoadDocumentSet(owned, external []string) (*Model, []dbspec.Diagnostic) {
	set := dbspec.ParseSet(owned, external)
	documents := make([]*dbspec.Document, 0, len(set))
	var diagnostics []dbspec.Diagnostic
	for _, d := range set {
		for _, x := range d.Diagnostics {
			x.Message = "document " + d.Name + ": " + x.Message
			diagnostics = append(diagnostics, x)
		}
		if d.Document != nil {
			documents = append(documents, d.Document)
		}
	}
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	return Build(documents)
}

// splitDocuments splits a manifest text, the documents joined in name order, into its document texts: a document
// begins at each line that begins with "dbspec ", the header line of the manifest form (docs/spec/dbspec.md "Manifest and
// hashes"). The names are the parser's, through dbspec.ParseSet.
func splitDocuments(text string) ([]string, []dbspec.Diagnostic) {
	if text == "" {
		return nil, []dbspec.Diagnostic{{Rule: dbspec.RuleHeader, Line: 1, Column: 1, Message: "manifest text is empty"}}
	}
	if !strings.HasPrefix(text, "dbspec ") {
		return nil, []dbspec.Diagnostic{{Rule: dbspec.RuleHeader, Line: 1, Column: 1, Message: "manifest text does not start with a dbspec header"}}
	}
	starts := []int{0}
	for i := 0; i < len(text)-1; i++ {
		if text[i] == '\n' && strings.HasPrefix(text[i+1:], "dbspec ") {
			starts = append(starts, i+1)
		}
	}
	texts := make([]string, len(starts))
	for k, start := range starts {
		end := len(text)
		if k+1 < len(starts) {
			end = starts[k+1]
		}
		texts[k] = text[start:end]
	}
	return texts, nil
}

// entityOf makes one table's entity.
func entityOf(t *dbspec.Table) *Entity {
	e := &Entity{Name: t.Name, Table: t.Name, PK: slices.Clone(t.PrimaryKey.Columns), Indexes: map[string][]string{}, fields: map[string]*Field{}}
	s := t.Settings
	if s == nil {
		s = &dbspec.Settings{}
	}
	if s.Entity != nil {
		e.Name = s.Entity.Name
	}
	foreign := map[string]bool{}
	for _, fk := range t.ForeignKeys {
		for _, column := range fk.Columns {
			foreign[column] = true
		}
	}
	for _, c := range t.Columns {
		f := &Field{Name: c.Name, Type: string(c.Type.Kind), Length: c.Type.Length, Precision: c.Type.Precision, Scale: c.Type.Scale,
			Null: c.Null, Identity: c.Identity, Default: c.Default != nil, DefaultNow: c.Default != nil && c.Default.Now, PrimaryKey: slices.Contains(t.PrimaryKey.Columns, c.Name), ForeignKey: foreign[c.Name]}
		if c.Identity {
			e.Identity = c.Name
		}
		e.Fields = append(e.Fields, f)
		e.fields[f.Name] = f
	}
	for _, u := range t.Uniques {
		e.Uniques = append(e.Uniques, Key{Name: u.Name, Columns: slices.Clone(u.Columns)})
	}
	slices.SortFunc(e.Uniques, func(a, b Key) int { return strings.Compare(a.Name, b.Name) })
	for _, ix := range t.Indexes {
		columns := make([]string, len(ix.Columns))
		for i, c := range ix.Columns {
			columns[i] = c.Name
		}
		e.Indexes[ix.Name] = columns
	}
	if s.Updated != nil {
		e.Updated = s.Updated.Column
	}
	if s.SoftDelete != nil {
		e.SoftDelete = s.SoftDelete.Column
	}
	if s.AESVersion != nil {
		e.AESVersion = s.AESVersion.Column
	}
	if s.SelectExplicit != nil {
		for _, column := range s.SelectExplicit.Columns {
			e.fields[column].SelectExplicit = true
		}
	}
	for _, codec := range s.Codecs {
		e.fields[codec.Column].Codec = slices.Clone(codec.Stages)
	}
	for _, b := range s.BlindIndexes {
		e.fields[b.AESColumn].BlindIndex = b.IndexColumn
	}
	if s.Audit != nil {
		e.Audit = &Audit{History: s.Audit.History, Column: s.Audit.Column, Record: s.Audit.References}
	}
	return e
}

// DiagnosticsError joins the diagnostics, each as line:column rule: message,
// into one message.
func DiagnosticsError(diagnostics []dbspec.Diagnostic) string {
	parts := make([]string, len(diagnostics))
	for i, d := range diagnostics {
		parts[i] = fmt.Sprintf("%d:%d %s: %s", d.Line, d.Column, d.Rule, d.Message)
	}
	return strings.Join(parts, "; ")
}

// LoadFiles reads dbspec document files with dbspec.ReadFile and returns the
// runtime model of the one document set they form, with no external document.
// A file without the signature and an invalid set are an error that holds
// SCHEMA_INVALID and each diagnostic.
func LoadFiles(paths ...string) (*Model, error) {
	texts := make([]string, len(paths))
	for i, path := range paths {
		text, diagnostics, err := dbspec.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if len(diagnostics) > 0 {
			return nil, fmt.Errorf("SCHEMA_INVALID: %s", DiagnosticsError(diagnostics))
		}
		texts[i] = text
	}
	m, diagnostics := LoadDocumentSet(texts, nil)
	if len(diagnostics) > 0 {
		return nil, fmt.Errorf("SCHEMA_INVALID: %s", DiagnosticsError(diagnostics))
	}
	return m, nil
}

// SetLoadError is every problem of a set that LoadSetFile could not load: the errors
// of the set file, or the diagnostics of its listed files, or those of the set.
// Each problem is one line that names its file.
type SetLoadError struct {
	Problems []string
}

func (e *SetLoadError) Error() string { return "SCHEMA_INVALID: " + strings.Join(e.Problems, "; ") }

// LoadSetFile reads the set file at path with dbspec.ReadSet (docs/spec/dbspec.md
// "Document sets"), gives the bytes of each listed file to dbspec.ReadBytes with
// its joined path and loads the documents and the external documents as one
// document set. Any error or diagnostic is a *SetLoadError that holds all of
// them.
func LoadSetFile(path string) (*Model, error) {
	set, errs := dbspec.ReadSet(path)
	if len(errs) > 0 {
		problems := make([]string, len(errs))
		for i, e := range errs {
			problems[i] = e.Error()
		}
		return nil, &SetLoadError{Problems: problems}
	}
	var problems []string
	read := func(files []dbspec.SetFile) []string {
		texts := make([]string, len(files))
		for i, f := range files {
			text, diagnostics := dbspec.ReadBytes(f.Path, f.Bytes)
			for _, d := range diagnostics {
				problems = append(problems, fmt.Sprintf("%s:%d:%d %s: %s", f.Path, d.Line, d.Column, d.Rule, d.Message))
			}
			texts[i] = text
		}
		return texts
	}
	texts, externalTexts := read(set.Documents), read(set.External)
	if len(problems) > 0 {
		return nil, &SetLoadError{Problems: problems}
	}
	m, diagnostics := LoadDocumentSet(texts, externalTexts)
	if len(diagnostics) > 0 {
		for _, d := range diagnostics {
			problems = append(problems, fmt.Sprintf("%s: %d:%d %s: %s", path, d.Line, d.Column, d.Rule, d.Message))
		}
		return nil, &SetLoadError{Problems: problems}
	}
	return m, nil
}
