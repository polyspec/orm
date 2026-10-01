package dbspec

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// RuleMermaid는 import가 읽지 못한 Mermaid 줄의 diagnostic이다(docs/mermaid.md).
const RuleMermaid = "mermaid"

// ExportMermaid는 문서 하나를 표준 erDiagram으로 쓰고, diagram이 담지 못해 뺀
// 것을 [kind, table, name] 순서로 돌려준다(docs/mermaid.md "Export").
func ExportMermaid(d *Document) (string, []Unsupported) {
	var dropped []Unsupported
	report := func(kind, table, name, reason string) {
		dropped = append(dropped, Unsupported{Kind: kind, Table: table, Name: name, Reason: reason})
	}
	for _, u := range d.Uses {
		report("use", "", u.Document, "export writes the tables of one document; used tables appear only as relationship ends")
	}
	for _, g := range d.Diagrams {
		report("diagram", "", g.Name, "a dbspec diagram has no Mermaid form")
	}
	tables := slices.Clone(d.Tables)
	slices.SortFunc(tables, func(a, b Table) int { return strings.Compare(a.Name, b.Name) })
	var b strings.Builder
	b.WriteString("erDiagram\n")
	for _, t := range tables {
		if len(t.Comments) > 0 || len(t.ClosingComments) > 0 {
			report("comment", t.Name, t.Name, "Mermaid has no table comments")
		}
		b.WriteString("    " + t.Name + " {\n")
		for _, c := range t.Columns {
			if len(c.Comments) > 0 {
				report("comment", t.Name, c.Name, "Mermaid has no column comments")
			}
			line := "        " + mermaidType(c.Type) + " " + c.Name
			var keys []string
			if slices.Contains(t.PrimaryKey.Columns, c.Name) {
				keys = append(keys, "PK")
			}
			if slices.ContainsFunc(t.ForeignKeys, func(f ForeignKey) bool { return slices.Contains(f.Columns, c.Name) }) {
				keys = append(keys, "FK")
			}
			if slices.ContainsFunc(t.Uniques, func(u Unique) bool { return slices.Contains(u.Columns, c.Name) }) {
				keys = append(keys, "UK")
			}
			if len(keys) > 0 {
				line += " " + strings.Join(keys, ", ")
			}
			var suffix []string
			if c.Null {
				suffix = append(suffix, "null")
			}
			if c.Identity {
				suffix = append(suffix, "identity")
			}
			if c.Default != nil {
				literal := c.Default.Literal
				if c.Default.Now {
					literal = "now"
				}
				if strings.Contains(literal, `"`) {
					report("default", t.Name, c.Name, "a Mermaid comment cannot hold the default, which contains a double quote")
				} else {
					suffix = append(suffix, "default "+literal)
				}
			}
			if len(suffix) > 0 {
				line += ` "` + strings.Join(suffix, " ") + `"`
			}
			b.WriteString(line + "\n")
		}
		b.WriteString("    }\n")
		for _, u := range t.Uniques {
			report("unique", t.Name, u.Name, "Mermaid marks the columns of a unique key with UK but has no key")
		}
		for _, x := range t.Indexes {
			report("index", t.Name, x.Name, "Mermaid has no indexes")
		}
		for _, k := range t.Checks {
			report("check", t.Name, k.Name, "Mermaid has no checks")
		}
		for _, f := range t.ForeignKeys {
			if f.OnDelete != ActionRestrict || f.OnUpdate != ActionRestrict {
				report("foreign_key", t.Name, f.Name, "Mermaid has no foreign key actions")
			}
		}
		if t.Settings != nil {
			report("settings", t.Name, t.Name, "Mermaid has no settings")
		}
	}
	for _, t := range tables {
		for _, f := range sortedBy(t.ForeignKeys, func(f ForeignKey) string { return f.Name }) {
			marker := "||--o{"
			for _, c := range f.Columns {
				if col := columnOf(&t, c); col != nil && col.Null {
					marker = "|o--o{"
				}
			}
			b.WriteString("    " + f.Table + " " + marker + " " + t.Name + ` : "` + f.Name + " (" + strings.Join(f.Columns, ", ") +
				") references (" + strings.Join(f.References, ", ") + `)"` + "\n")
		}
	}
	slices.SortStableFunc(dropped, func(a, b Unsupported) int {
		return strings.Compare(a.Table+"\x00"+a.Kind+"\x00"+a.Name, b.Table+"\x00"+b.Kind+"\x00"+b.Name)
	})
	return b.String(), dropped
}

// mermaidType은 Mermaid type에는 쉼표가 없으므로 decimal(p,s)를 decimal(p-s)로 쓴다.
func mermaidType(t Type) string {
	if t.Kind == TypeDecimal {
		return "decimal(" + strconv.Itoa(t.Precision) + "-" + strconv.Itoa(t.Scale) + ")"
	}
	return t.String()
}

var (
	mermaidEntityName  = `([A-Za-z0-9_-]+|"[^"]*")`
	mermaidEntityStart = regexp.MustCompile(`^` + mermaidEntityName + `\s*\{$`)
	mermaidAttribute   = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9_()\[\]-]*)\s+([A-Za-z_*][A-Za-z0-9_-]*)((?:\s+(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?)(?:\s+"([^"]*)")?$`)
	mermaidRelation    = regexp.MustCompile(`^` + mermaidEntityName + `\s+(\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{)\s+` + mermaidEntityName + `\s*:\s*("[^"]*"|[^\s"]+)$`)
	mermaidLabel       = regexp.MustCompile(`^([a-z][a-z0-9_]*) \(([a-z0-9_, ]+)\) references \(([a-z0-9_, ]+)\)$`)
	mermaidSuffix      = regexp.MustCompile(`^(null)?(?: ?(identity))?(?: ?default (.+))?$`)
	mermaidKnownType   = regexp.MustCompile(`^(i16|i32|i64|bool|f64|text|bytes|uuid|date)$|^varchar\((\d+)\)$|^(time|datetime)\((\d)\)$|^decimal\((\d+)-(\d+)\)$`)
)

type mermaidEntity struct {
	name       string
	attributes []mermaidAttr
	line       int
}

type mermaidAttr struct {
	typ, name, comment string
	keys               []string
}

type mermaidRel struct {
	left, right               string
	leftCard, rightCard, line string
	label                     string
}

// ImportMermaid는 표준 erDiagram을 name이라는 dbspec 문서로 읽고, 옮기지 못한
// 것을 돌려준다(docs/mermaid.md "Import"). 문법에 맞지 않는 줄은 diagnostic이다.
func ImportMermaid(text, name string) (*Document, []Unsupported, []Diagnostic) {
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	var entities []*mermaidEntity
	byName := map[string]*mermaidEntity{}
	entity := func(n string, line int) *mermaidEntity {
		n = strings.Trim(n, `"`)
		if e, ok := byName[n]; ok {
			return e
		}
		e := &mermaidEntity{name: n, line: line}
		byName[n] = e
		entities = append(entities, e)
		return e
	}
	var rels []mermaidRel
	var open *mermaidEntity
	header := false
	fail := func(line int, format string, args ...any) (*Document, []Unsupported, []Diagnostic) {
		return nil, nil, []Diagnostic{{Rule: RuleMermaid, Line: line, Column: 1, Message: fmt.Sprintf(format, args...)}}
	}
	for i, raw := range lines {
		n, line := i+1, strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		switch {
		case line == "" || strings.HasPrefix(line, "%%"):
			continue
		case !header:
			if line != "erDiagram" {
				return fail(n, "a Mermaid entity relationship diagram starts with erDiagram")
			}
			header = true
		case open != nil:
			if line == "}" {
				open = nil
				continue
			}
			m := mermaidAttribute.FindStringSubmatch(line)
			if m == nil {
				return fail(n, "an attribute is <type> <name> [PK|FK|UK, ...] [\"comment\"]")
			}
			a := mermaidAttr{typ: m[1], name: m[2], comment: m[4]}
			for _, k := range strings.Split(m[3], ",") {
				if k = strings.TrimSpace(k); k != "" {
					a.keys = append(a.keys, k)
				}
			}
			open.attributes = append(open.attributes, a)
		case mermaidEntityStart.MatchString(line):
			open = entity(mermaidEntityStart.FindStringSubmatch(line)[1], n)
		case mermaidRelation.MatchString(line):
			m := mermaidRelation.FindStringSubmatch(line)
			rels = append(rels, mermaidRel{left: entity(m[1], n).name, leftCard: m[2], rightCard: m[4], right: entity(m[5], n).name,
				label: strings.Trim(m[6], `"`), line: strconv.Itoa(n)})
		default:
			return fail(n, "a line is an entity block, an attribute, a relationship, a %%%% comment or blank")
		}
	}
	if !header {
		return fail(1, "a Mermaid entity relationship diagram starts with erDiagram")
	}
	if open != nil {
		return fail(len(lines), "entity %s has no closing brace", open.name)
	}
	c := &catalog{}
	usedFK := map[string]map[string]bool{}
	for _, e := range entities {
		if !validNameFormat(e.name) || len(e.name) > 63 {
			c.report("table", e.name, e.name, "the entity name is not a dbspec name")
			continue
		}
		t := &itable{name: e.name}
		for _, a := range e.attributes {
			typ, ok := mermaidImportType(a.typ)
			if !validNameFormat(a.name) || len(a.name) > 63 {
				c.report("column", e.name, a.name, "the attribute name is not a dbspec name")
				continue
			}
			if !ok {
				c.report("column", e.name, a.name, "type %s is not a dbspec type", a.typ)
				continue
			}
			col := icolumn{name: a.name, typ: typ}
			if a.comment != "" {
				if m := mermaidSuffix.FindStringSubmatch(a.comment); m != nil {
					col.null, col.identity, col.dflt = m[1] != "", m[2] != "", m[3]
				} else {
					c.report("comment", e.name, a.name, "the comment %q is not a dbspec column suffix", a.comment)
				}
			}
			t.columns = append(t.columns, col)
			if slices.Contains(a.keys, "PK") {
				t.primary = append(t.primary, a.name)
			}
			if slices.Contains(a.keys, "UK") {
				c.report("unique", e.name, a.name, "Mermaid does not say which UK attributes form one key")
			}
		}
		c.tables = append(c.tables, t)
	}
	columnIn := func(t *itable, n string) *icolumn {
		for i := range t.columns {
			if t.columns[i].name == n {
				return &t.columns[i]
			}
		}
		return nil
	}
	isFK := func(entity, column string) bool {
		e := byName[entity]
		for _, a := range e.attributes {
			if a.name == column {
				return slices.Contains(a.keys, "FK")
			}
		}
		return false
	}
	for _, r := range rels {
		parent, child := r.left, r.right
		parentCard, childCard := r.leftCard, r.rightCard
		manyRight := strings.HasSuffix(r.rightCard, "{")
		manyLeft := strings.HasPrefix(r.leftCard, "}")
		if manyLeft == manyRight {
			c.report("relationship", r.left, r.label, "the relationship to %s is not one to many", r.right)
			continue
		}
		if manyLeft {
			parent, child, parentCard, childCard = r.right, r.left, r.rightCard, r.leftCard
		}
		m := mermaidLabel.FindStringSubmatch(r.label)
		pt, ct := c.table(parent), c.table(child)
		if m == nil || pt == nil || ct == nil {
			c.report("relationship", child, r.label, "the label does not give the foreign key columns, or an end is not a table")
			continue
		}
		cols, refs := splitNames(m[2]), splitNames(m[3])
		ok := len(cols) == len(refs)
		nullable := false
		for i, col := range cols {
			cc := columnIn(ct, col)
			if cc == nil || !isFK(child, col) || columnIn(pt, refs[i]) == nil {
				ok = false
				break
			}
			nullable = nullable || cc.null
		}
		if !ok {
			c.report("relationship", child, m[1], "its columns are not FK attributes of %s or its referenced columns are not attributes of %s", child, parent)
			continue
		}
		wantParent := "||"
		if nullable {
			wantParent = "|o"
		}
		if manyLeft {
			wantParent = map[string]string{"||": "||", "|o": "o|"}[wantParent]
		}
		if parentCard != wantParent || (childCard != "o{" && childCard != "}o") {
			c.report("cardinality", child, m[1], "the cardinalities differ from the ones the foreign key's nullability gives")
		}
		ct.fks = append(ct.fks, ifk{name: m[1], columns: cols, table: parent, refs: refs, onDelete: "restrict", onUpdate: "restrict"})
		if usedFK[child] == nil {
			usedFK[child] = map[string]bool{}
		}
		for _, col := range cols {
			usedFK[child][col] = true
		}
		if !slices.Equal(ct.primary[:min(len(cols), len(ct.primary))], cols) {
			ix := "ix_" + child + "_" + strings.Join(cols, "_")
			ct.indexes = append(ct.indexes, ikey{name: ix, columns: cols, desc: make([]bool, len(cols))})
			c.report("index", child, ix, "Mermaid has no indexes; the foreign key needs one")
		}
	}
	for _, e := range entities {
		for _, a := range e.attributes {
			if slices.Contains(a.keys, "FK") && !usedFK[e.name][a.name] && c.table(e.name) != nil {
				c.report("foreign_key", e.name, a.name, "no relationship gives the foreign key of this FK attribute")
			}
		}
	}
	document, dropped, err := c.document(name)
	if err != nil {
		return nil, nil, []Diagnostic{{Rule: RuleMermaid, Line: 1, Column: 1, Message: err.Error()}}
	}
	return document, dropped, nil
}

func splitNames(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		out = append(out, strings.TrimSpace(p))
	}
	return out
}

// mermaidImportType은 Mermaid type이 dbspec type이면 그 Type을 돌려준다.
func mermaidImportType(s string) (Type, bool) {
	m := mermaidKnownType.FindStringSubmatch(s)
	if m == nil {
		return Type{}, false
	}
	atoi := func(x string) int { n, _ := strconv.Atoi(x); return n }
	switch {
	case m[1] != "":
		return Type{Kind: TypeKind(m[1])}, true
	case m[2] != "":
		return Type{Kind: TypeVarchar, Length: atoi(m[2])}, true
	case m[3] != "":
		return Type{Kind: TypeKind(m[3]), Precision: atoi(m[4])}, true
	}
	return Type{Kind: TypeDecimal, Precision: atoi(m[5]), Scale: atoi(m[6])}, true
}
