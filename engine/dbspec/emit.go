package dbspec

import (
	"cmp"
	"slices"
	"strconv"
	"strings"
)

// model converts a validated parse tree into the public document.
func (d *documentNode) model() *Document {
	out := &Document{Name: d.name.text, TrailingComments: d.trailing}
	for _, u := range d.uses {
		out.Uses = append(out.Uses, Use{Comments: u.comments, Document: u.document.text, Tables: tokenTexts(u.tables)})
	}
	out.Tables = make([]Table, 0, len(d.tables))
	for _, t := range d.tables {
		out.Tables = append(out.Tables, t.model())
	}
	for _, g := range d.diagrams {
		diagram := Diagram{Comments: g.comments, Name: g.name.text, ClosingComments: g.closing}
		for _, e := range g.entries {
			x, _ := coordinate(e.x)
			y, _ := coordinate(e.y)
			diagram.Entries = append(diagram.Entries, DiagramEntry{Comments: e.comments, Table: e.table.text, X: int32(x), Y: int32(y)})
		}
		out.Diagrams = append(out.Diagrams, diagram)
	}
	return out
}

func (t *tableNode) model() Table {
	out := Table{Comments: t.comments, Name: t.name.text, ClosingComments: t.closing}
	out.Columns = make([]Column, 0, len(t.columns))
	for _, c := range t.columns {
		column := Column{Comments: c.comments, Name: c.name.text, Type: c.typ.typ, Null: c.null != nil, Identity: c.identity != nil}
		if c.dflt != nil {
			column.Default = &Default{Now: c.literal == "now", Literal: c.literal}
			if column.Default.Now {
				column.Default.Literal = ""
			}
		}
		out.Columns = append(out.Columns, column)
	}
	pk := t.primaryKeys[0]
	out.PrimaryKey = PrimaryKey{Comments: pk.comments, Columns: tokenTexts(pk.columns)}
	for _, k := range t.uniques {
		out.Uniques = append(out.Uniques, Unique{Comments: k.comments, Name: k.name.text, Columns: tokenTexts(k.columns)})
	}
	for _, k := range t.indexes {
		index := Index{Comments: k.comments, Name: k.name.text}
		for i, c := range k.columns {
			index.Columns = append(index.Columns, IndexColumn{Name: c.text, Descending: k.descending[i]})
		}
		out.Indexes = append(out.Indexes, index)
	}
	for _, f := range t.foreignKeys {
		out.ForeignKeys = append(out.ForeignKeys, ForeignKey{
			Comments: f.comments, Name: f.name.text, Columns: tokenTexts(f.columns), Table: f.target.text,
			References: tokenTexts(f.references), OnDelete: actionOf(f.onDelete), OnUpdate: actionOf(f.onUpdate),
		})
	}
	for _, k := range t.checks {
		out.Checks = append(out.Checks, Check{Comments: k.comments, Name: k.name.text, Expression: k.expr})
	}
	if s := t.settings; s != nil {
		if len(s.lines) > 0 {
			out.Settings = s.model()
		} else {
			// An empty settings block has no meaning; its comments stay
			// before the closing brace of the table.
			out.ClosingComments = slices.Concat(s.comments, s.closing, t.closing)
		}
	}
	return out
}

func (s *settingsNode) model() *Settings {
	out := &Settings{Comments: s.comments, ClosingComments: s.closing}
	for _, line := range s.lines {
		args := tokenTexts(line.args)
		switch line.keyword.text {
		case "entity":
			out.Entity = &EntitySetting{Comments: line.comments, Name: args[0]}
		case "updated":
			out.Updated = &ColumnSetting{Comments: line.comments, Column: args[0]}
		case "soft_delete":
			out.SoftDelete = &ColumnSetting{Comments: line.comments, Column: args[0]}
		case "aes_version":
			out.AESVersion = &ColumnSetting{Comments: line.comments, Column: args[0]}
		case "select":
			out.SelectExplicit = &SelectExplicitSetting{Comments: line.comments, Columns: args}
		case "codec":
			out.Codecs = append(out.Codecs, CodecSetting{Comments: line.comments, Column: args[0], Stages: args[1:]})
		case "blind_index":
			out.BlindIndexes = append(out.BlindIndexes, BlindIndexSetting{Comments: line.comments, AESColumn: args[0], IndexColumn: args[1]})
		case "navigation":
			out.Navigations = append(out.Navigations, NavigationSetting{Comments: line.comments, ForeignKey: args[0], ChildName: args[1], ParentName: args[2]})
		case "immutable":
			out.Immutable = &ImmutableSetting{Comments: line.comments}
		case "audit":
			out.Audit = &AuditSetting{Comments: line.comments, History: args[0], Column: args[1], References: args[2], Action: args[3], Previous: args[4]}
			for _, list := range line.lists {
				if list.keyword.text == "exclude" {
					out.Audit.Exclude = tokenTexts(list.columns)
				} else {
					out.Audit.Include = tokenTexts(list.columns)
				}
			}
		case "markdown":
			out.Marks = append(out.Marks, MarkSetting{Comments: line.comments, Column: args[0]})
		case "state_machine":
			if out.StateMachine == nil {
				out.StateMachine = &StateMachineSetting{Comments: line.comments, Column: args[0]}
			}
			stateLine := StateLineSetting{Comments: line.comments, Terminal: line.terminal}
			if line.terminal {
				stateLine.State = args[1]
			} else {
				stateLine.From, stateLine.To = args[1], args[2]
			}
			for _, list := range line.lists {
				stateLine.Requires = tokenTexts(list.columns)
			}
			out.StateMachine.Lines = append(out.StateMachine.Lines, stateLine)
		}
	}
	return out
}

// view selects what an emission writes: the canonical text, the manifest
// text without comments and diagrams, or the schema text that also keeps only
// the schema settings (docs/dbspec.md, "Manifest and hashes").
type view int

const (
	viewCanonical view = iota
	viewManifest
	viewSchema
)

type emitter struct {
	b    strings.Builder
	view view
}

// line writes comments, then one line, at the indentation level.
func (e *emitter) line(indent int, comments []string, text string) {
	e.comments(indent, comments)
	e.b.WriteString(strings.Repeat("  ", indent))
	e.b.WriteString(text)
	e.b.WriteByte('\n')
}

func (e *emitter) comments(indent int, comments []string) {
	if e.view != viewCanonical {
		return
	}
	for _, c := range comments {
		e.b.WriteString(strings.Repeat("  ", indent))
		e.b.WriteString(c)
		e.b.WriteByte('\n')
	}
}

func sortedBy[T any](items []T, key func(T) string) []T {
	out := slices.Clone(items)
	slices.SortStableFunc(out, func(a, b T) int { return cmp.Compare(key(a), key(b)) })
	return out
}

func emitDocument(d *Document, v view) string {
	e := emitter{view: v}
	e.b.Grow(64 * (len(d.Tables)*32 + 16))
	e.line(0, nil, "dbspec 1 "+d.Name)
	uses := sortedBy(d.Uses, func(u Use) string { return u.Document })
	if len(uses) > 0 {
		e.b.WriteByte('\n')
		for _, u := range uses {
			e.line(0, u.Comments, "use "+u.Document+" { "+strings.Join(u.Tables, ", ")+" }")
		}
	}
	for i := range d.Tables {
		e.b.WriteByte('\n')
		e.table(&d.Tables[i])
	}
	if v != viewCanonical {
		return e.b.String()
	}
	for _, g := range d.Diagrams {
		e.b.WriteByte('\n')
		e.line(0, g.Comments, "diagram "+g.Name+" {")
		for _, entry := range g.Entries {
			e.line(1, entry.Comments, entry.Table+" at "+strconv.Itoa(int(entry.X))+" "+strconv.Itoa(int(entry.Y)))
		}
		e.comments(1, g.ClosingComments)
		e.line(0, nil, "}")
	}
	if len(d.TrailingComments) > 0 {
		e.b.WriteByte('\n')
		e.comments(0, d.TrailingComments)
	}
	return e.b.String()
}

func (e *emitter) table(t *Table) {
	e.line(0, t.Comments, "table "+t.Name+" {")
	for _, c := range t.Columns {
		text := c.Name + " " + c.Type.String()
		if c.Null {
			text += " null"
		}
		if c.Identity {
			text += " identity"
		}
		if c.Default != nil {
			if c.Default.Now {
				text += " default now"
			} else {
				text += " default " + c.Default.Literal
			}
		}
		e.line(1, c.Comments, text)
	}
	e.line(1, t.PrimaryKey.Comments, "primary key ("+strings.Join(t.PrimaryKey.Columns, ", ")+")")
	for _, u := range sortedBy(t.Uniques, func(u Unique) string { return u.Name }) {
		e.line(1, u.Comments, "unique "+u.Name+" ("+strings.Join(u.Columns, ", ")+")")
	}
	for _, x := range sortedBy(t.Indexes, func(x Index) string { return x.Name }) {
		columns := make([]string, len(x.Columns))
		for i, c := range x.Columns {
			columns[i] = c.Name
			if c.Descending {
				columns[i] += " desc"
			}
		}
		e.line(1, x.Comments, "index "+x.Name+" ("+strings.Join(columns, ", ")+")")
	}
	for _, f := range sortedBy(t.ForeignKeys, func(f ForeignKey) string { return f.Name }) {
		e.line(1, f.Comments, "foreign key "+f.Name+" ("+strings.Join(f.Columns, ", ")+") references "+f.Table+
			" ("+strings.Join(f.References, ", ")+") on delete "+string(f.OnDelete)+" on update "+string(f.OnUpdate))
	}
	for _, k := range sortedBy(t.Checks, func(k Check) string { return k.Name }) {
		var b strings.Builder
		writeExpr(&b, k.Expression)
		e.line(1, k.Comments, "check "+k.Name+" ("+b.String()+")")
	}
	if s := t.Settings; s != nil {
		if s.empty() || (e.view == viewSchema && s.Immutable == nil && s.Audit == nil) {
			e.comments(1, s.Comments)
			e.comments(1, s.ClosingComments)
		} else {
			e.settings(t, s)
		}
	}
	e.comments(1, t.ClosingComments)
	e.line(0, nil, "}")
}

// empty reports whether the block holds no setting; canonical form omits it.
func (s *Settings) empty() bool {
	return s.Entity == nil && s.Updated == nil && s.SoftDelete == nil && s.SelectExplicit == nil &&
		len(s.Codecs) == 0 && s.AESVersion == nil && len(s.BlindIndexes) == 0 && len(s.Navigations) == 0 &&
		s.Immutable == nil && s.Audit == nil && s.StateMachine == nil && len(s.Marks) == 0
}

func (e *emitter) settings(t *Table, s *Settings) {
	e.line(1, s.Comments, "settings {")
	if e.view != viewSchema {
		e.mappingSettings(s)
	}
	if s.Immutable != nil {
		e.line(2, s.Immutable.Comments, "immutable")
	}
	if a := s.Audit; a != nil {
		// schema text는 database 상태로 정해지므로 기록하지 않는 column을 column
		// 순서의 exclude 목록으로 쓴다. 다른 view는 쓴 목록을 그대로 쓴다.
		switch {
		case e.view == viewSchema:
			e.line(2, a.Comments, a.line("exclude", a.Excluded(t)))
		case a.Include != nil:
			e.line(2, a.Comments, a.line("include", a.Include))
		default:
			e.line(2, a.Comments, a.line("exclude", a.Exclude))
		}
	}
	e.comments(2, s.ClosingComments)
	e.line(1, nil, "}")
}

// mappingSettings writes the settings that only the manifest covers.
func (e *emitter) mappingSettings(s *Settings) {
	if s.Entity != nil {
		e.line(2, s.Entity.Comments, "entity "+s.Entity.Name)
	}
	if s.Updated != nil {
		e.line(2, s.Updated.Comments, "updated "+s.Updated.Column)
	}
	if s.SoftDelete != nil {
		e.line(2, s.SoftDelete.Comments, "soft_delete "+s.SoftDelete.Column)
	}
	if s.SelectExplicit != nil {
		e.line(2, s.SelectExplicit.Comments, "select explicit "+strings.Join(s.SelectExplicit.Columns, " "))
	}
	for _, c := range sortedBy(s.Codecs, func(c CodecSetting) string { return c.Column }) {
		e.line(2, c.Comments, "codec "+c.Column+" "+strings.Join(c.Stages, " "))
	}
	if s.AESVersion != nil {
		e.line(2, s.AESVersion.Comments, "aes_version "+s.AESVersion.Column)
	}
	for _, b := range sortedBy(s.BlindIndexes, func(b BlindIndexSetting) string { return b.AESColumn }) {
		e.line(2, b.Comments, "blind_index "+b.AESColumn+" "+b.IndexColumn)
	}
	for _, n := range sortedBy(s.Navigations, func(n NavigationSetting) string { return n.ForeignKey }) {
		e.line(2, n.Comments, "navigation "+n.ForeignKey+" "+n.ChildName+" "+n.ParentName)
	}
	for _, m := range sortedBy(s.Marks, func(m MarkSetting) string { return m.Column }) {
		e.line(2, m.Comments, "markdown "+m.Column)
	}
	if m := s.StateMachine; m != nil {
		for _, line := range m.Lines {
			text := "state_machine " + m.Column + " "
			if line.Terminal {
				text += "terminal " + line.State
			} else {
				text += line.From + " -> " + line.To
			}
			if len(line.Requires) > 0 {
				text += " require (" + strings.Join(line.Requires, ", ") + ")"
			}
			e.line(2, line.Comments, text)
		}
	}
}
