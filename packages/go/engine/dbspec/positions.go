package dbspec

import "sort"

// Position is the place of one declaration of a parsed document (docs/spec/dbspec.md "Declaration positions"): its kind,
// its path of enclosing names and its own name, and the 1-based line and column, in Unicode code points, of its name
// token or, for a setting and the primary key, of its keyword.
type Position struct {
	Kind   string
	Path   []string
	Line   int
	Column int
}

// The kinds of a Position.
const (
	PositionDocument     = "document"
	PositionUse          = "use"
	PositionUseTable     = "use_table"
	PositionTable        = "table"
	PositionColumn       = "column"
	PositionConstraint   = "constraint"
	PositionSetting      = "setting"
	PositionDiagram      = "diagram"
	PositionDiagramEntry = "diagram_entry"
)

// positions returns the declaration positions of the document in source order.
func (d *documentNode) positions() []Position {
	var out []Position
	add := func(kind string, at token, path ...string) {
		out = append(out, Position{Kind: kind, Path: path, Line: at.line, Column: at.col})
	}
	add(PositionDocument, d.name, d.name.text)
	for _, u := range d.uses {
		add(PositionUse, u.document, u.document.text)
		for _, t := range u.tables {
			add(PositionUseTable, t, u.document.text, t.text)
		}
	}
	for _, t := range d.tables {
		table := t.name.text
		add(PositionTable, t.name, table)
		for _, c := range t.columns {
			add(PositionColumn, c.name, table, c.name.text)
		}
		for _, k := range t.primaryKeys {
			add(PositionConstraint, k.keyword, table, "primary key")
		}
		for _, keys := range [][]*keyNode{t.uniques, t.indexes} {
			for _, k := range keys {
				add(PositionConstraint, k.name, table, k.name.text)
			}
		}
		for _, f := range t.foreignKeys {
			add(PositionConstraint, f.name, table, f.name.text)
		}
		for _, c := range t.checks {
			add(PositionConstraint, c.name, table, c.name.text)
		}
		if t.settings != nil {
			for _, s := range t.settings.lines {
				add(PositionSetting, s.keyword, append([]string{table, s.keyword.text}, settingIdentity(s)...)...)
			}
		}
	}
	for _, g := range d.diagrams {
		add(PositionDiagram, g.name, g.name.text)
		for _, e := range g.entries {
			add(PositionDiagramEntry, e.table, g.name.text, e.table.text)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Line != out[j].Line {
			return out[i].Line < out[j].Line
		}
		return out[i].Column < out[j].Column
	})
	return out
}

// settingIdentity returns what the repeat rule of a setting makes unique (docs/spec/dbspec.md "Settings"): the column of
// codec and markdown, the foreign key of navigation, the AES column of blind_index, the column and state of checkbox,
// and the form and states of a state_machine line, whose column is left out since a table holds one machine. Every
// other setting appears at most once and has no identity.
func settingIdentity(s *settingNode) []string {
	switch s.keyword.text {
	case "codec", "markdown", "navigation", "blind_index":
		return []string{s.args[0].text}
	case "checkbox":
		return []string{s.args[0].text, s.args[1].text}
	case "state_machine":
		switch s.form {
		case "transition":
			return []string{"transition", s.args[1].text, s.args[2].text}
		case "history":
			return []string{"history"}
		default:
			return []string{s.form, s.args[1].text}
		}
	}
	return nil
}
