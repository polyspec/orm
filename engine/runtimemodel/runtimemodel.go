// Package runtimemodel은 dbspec document set의 runtime model을 만든다
// (docs/dbspec.md, "Runtime model"). planner, executor, generator가 읽는
// entity, field, key, default select set, codec, executor setting을 담는다.
// model은 parse된 document나 generated code가 품은 manifest text로 만든다.
package runtimemodel

import (
	"fmt"
	"slices"
	"strings"

	"github.com/polyspec/orm/engine/dbspec"
)

// Model은 document set 하나의 runtime model이다.
type Model struct {
	// ManifestText와 ManifestHash는 document set을 식별하며 모든 request는
	// ManifestHash를 싣는다.
	ManifestText string
	ManifestHash string
	// Documents는 document name 순서의 parse된 document이며 schema 설치가
	// 이를 render한다.
	Documents []*dbspec.Document
	// Order는 entity 이름 목록이다. document는 이름 순서, table은 document
	// 순서다.
	Order    []string
	Entities map[string]*Entity
}

// Entity는 document set의 table 하나다.
type Entity struct {
	// Name은 `entity` setting이거나 table 이름이다.
	Name  string
	Table string
	// PK는 key 순서의 primary key column이다.
	PK []string
	// Identity는 identity column이며 없으면 비어 있다.
	Identity string
	Fields   []*Field
	// Uniques는 이름 순서의 unique key다.
	Uniques []Key
	// Indexes는 index 이름에서 그 column으로 가는 map이다.
	Indexes map[string][]string
	// Updated, SoftDelete, AESVersion은 각 setting의 column이며 없으면 비어
	// 있다.
	Updated    string
	SoftDelete string
	AESVersion string
	// Audit은 audit setting이며 없으면 nil이다.
	Audit *Audit

	fields map[string]*Field
}

// Key는 이름 있는 unique key다.
type Key struct {
	Name    string
	Columns []string
}

// Audit은 audit setting 중 executor가 쓰는 부분이다. table의 모든 insert와
// update가 transaction의 audit 기록 key를 Column에 쓴다. Record는 audit 기록
// table의 이름이다.
type Audit struct {
	History string
	Column  string
	Record  string
}

// Field는 entity의 column 하나와 그 value type, setting이다.
type Field struct {
	Name string
	// Type은 dbspec type kind다: i16, i32, i64, bool, decimal, f64, varchar,
	// text, bytes, uuid, date, time, datetime.
	Type string
	// Length는 varchar(n)의 n, Precision은 decimal(p,s), time(p),
	// datetime(p)의 p, Scale은 decimal(p,s)의 s다.
	Length    int
	Precision int
	Scale     int
	Null      bool
	Identity  bool
	// Default는 선언된 default가 있음을 뜻한다. column을 빼먹은 insert는
	// database default를 받는다.
	Default bool
	// DefaultNow는 default가 `now`임을 뜻한다. sub-second clock이 없는
	// dialect(SQLite)는 이 column을 뺀 insert에 executor clock을 bind한다.
	DefaultNow bool
	// SelectExplicit인 field는 default select set에서 빠진다.
	SelectExplicit bool
	// Codec은 write 순서의 codec stage 목록이다.
	Codec []string
	// BlindIndex는 AES field의 index column이며 없으면 비어 있다.
	BlindIndex string
	PrimaryKey bool
	ForeignKey bool
}

// Field는 이름으로 field를 찾고 없으면 nil을 반환한다.
func (e *Entity) Field(name string) *Field { return e.fields[name] }

// styledStages는 값이 common value model의 styled value가 되는 codec
// stage다.
var styledStages = []string{"ordered_json", "serialize", "yaml", "gz", "base64"}

// Styled는 field가 styled value를 담는지 알린다. codec stage 중
// ordered_json, serialize, yaml, gz, base64가 있으면 그렇다.
func (f *Field) Styled() bool {
	return slices.ContainsFunc(f.Codec, func(stage string) bool { return slices.Contains(styledStages, stage) })
}

// Encrypted는 field의 codec stage에 aes가 있는지 알린다.
func (f *Field) Encrypted() bool { return slices.Contains(f.Codec, "aes") }

// Build는 document set의 runtime model을 반환하고, set이 잘못되면
// diagnostic을 반환한다.
func Build(documents []*dbspec.Document) (*Model, []dbspec.Diagnostic) {
	manifest, diagnostics := dbspec.ManifestOf(documents)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	ordered := slices.Clone(documents)
	slices.SortStableFunc(ordered, func(a, b *dbspec.Document) int { return strings.Compare(a.Name, b.Name) })
	m := &Model{ManifestText: manifest.ManifestText, ManifestHash: manifest.ManifestHash, Documents: ordered, Entities: map[string]*Entity{}}
	for _, document := range ordered {
		for i := range document.Tables {
			e := entityOf(&document.Tables[i])
			if _, duplicate := m.Entities[e.Name]; duplicate {
				return nil, []dbspec.Diagnostic{{Rule: dbspec.RuleNameDuplicate, Line: 1, Column: 1, Message: fmt.Sprintf("entity %s of document %s repeats an entity name of the document set", e.Name, document.Name)}}
			}
			m.Entities[e.Name] = e
			m.Order = append(m.Order, e.Name)
		}
	}
	return m, nil
}

// Load는 manifest text(set의 canonical document를 document name 순서로
// 이어 붙인 text)를 parse해 runtime model을 반환한다. "dbspec "으로
// 시작하는 줄마다 document가 시작한다.
func Load(text string) (*Model, []dbspec.Diagnostic) {
	texts, names, diagnostics := splitDocuments(text)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	return parseSet(texts, names)
}

// LoadDocuments는 document text 목록을 하나의 document set으로 parse해
// runtime model을 반환한다. document 이름은 각 text의 header 이름이다.
func LoadDocuments(documents []string) (*Model, []dbspec.Diagnostic) {
	texts := map[string]string{}
	names := make([]string, 0, len(documents))
	for _, text := range documents {
		header, _, _ := strings.Cut(text, "\n")
		name := header[strings.LastIndexByte(header, ' ')+1:]
		if _, duplicate := texts[name]; duplicate {
			return nil, []dbspec.Diagnostic{{Rule: dbspec.RuleNameDuplicate, Line: 1, Column: 10, Message: "document " + name + " appears twice in the document set"}}
		}
		texts[name] = text
		names = append(names, name)
	}
	return parseSet(texts, names)
}

// parseSet은 각 document를 나머지 document를 set으로 삼아 parse한다.
// diagnostic message는 document 이름으로 시작한다.
func parseSet(texts map[string]string, names []string) (*Model, []dbspec.Diagnostic) {
	documents := make([]*dbspec.Document, 0, len(names))
	for _, name := range names {
		others := map[string]string{}
		for other, otherText := range texts {
			if other != name {
				others[other] = otherText
			}
		}
		document, diagnostics := dbspec.Parse(texts[name], others)
		if len(diagnostics) > 0 {
			for i := range diagnostics {
				diagnostics[i].Message = "document " + name + ": " + diagnostics[i].Message
			}
			return nil, diagnostics
		}
		documents = append(documents, document)
	}
	return Build(documents)
}

// splitDocuments는 manifest text를 header 줄에서 나누어 이름별 document
// text와 text 순서의 이름 목록을 반환한다.
func splitDocuments(text string) (map[string]string, []string, []dbspec.Diagnostic) {
	if text == "" {
		return nil, nil, []dbspec.Diagnostic{{Rule: dbspec.RuleHeader, Line: 1, Column: 1, Message: "manifest text is empty"}}
	}
	if !strings.HasPrefix(text, "dbspec ") {
		return nil, nil, []dbspec.Diagnostic{{Rule: dbspec.RuleHeader, Line: 1, Column: 1, Message: "manifest text does not start with a dbspec header"}}
	}
	texts := map[string]string{}
	var names []string
	starts := []int{0}
	for i := 0; i < len(text)-1; i++ {
		if text[i] == '\n' && strings.HasPrefix(text[i+1:], "dbspec ") {
			starts = append(starts, i+1)
		}
	}
	line := 1
	for k, start := range starts {
		end := len(text)
		if k+1 < len(starts) {
			end = starts[k+1]
		}
		document := text[start:end]
		header, _, _ := strings.Cut(document, "\n")
		name := header[strings.LastIndexByte(header, ' ')+1:]
		if _, duplicate := texts[name]; duplicate {
			return nil, nil, []dbspec.Diagnostic{{Rule: dbspec.RuleNameDuplicate, Line: line, Column: 10, Message: "document " + name + " appears twice in the manifest text"}}
		}
		texts[name] = document
		names = append(names, name)
		line += strings.Count(document, "\n")
	}
	return texts, names, nil
}

// entityOf는 table 하나의 entity를 만든다.
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

// DiagnosticsError는 diagnostic을 line:column rule: message 형식으로 이어
// 한 message로 만든다.
func DiagnosticsError(diagnostics []dbspec.Diagnostic) string {
	parts := make([]string, len(diagnostics))
	for i, d := range diagnostics {
		parts[i] = fmt.Sprintf("%d:%d %s: %s", d.Line, d.Column, d.Rule, d.Message)
	}
	return strings.Join(parts, "; ")
}

// LoadFiles는 dbspec document 파일을 dbspec.ReadFile로 읽어 하나의 document set의
// runtime model을 반환한다. signature가 없는 파일과 잘못된 set은 SCHEMA_INVALID와
// 각 diagnostic을 담은 error다.
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
	m, diagnostics := LoadDocuments(texts)
	if len(diagnostics) > 0 {
		return nil, fmt.Errorf("SCHEMA_INVALID: %s", DiagnosticsError(diagnostics))
	}
	return m, nil
}
