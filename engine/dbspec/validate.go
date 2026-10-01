package dbspec

import (
	"slices"
)

// session holds the declared document set and the parse trees of the
// documents that `use` lines name, parsed once each.
type session struct {
	set    map[string]string
	parsed map[string]*parsedDocument
}

func (s *session) document(name string) (*parsedDocument, bool) {
	if p, ok := s.parsed[name]; ok {
		return p, true
	}
	text, ok := s.set[name]
	if !ok {
		return nil, false
	}
	p := parseStructure(text)
	s.parsed[name] = p
	return p, true
}

type validator struct {
	s           *session
	doc         *documentNode
	out         []Diagnostic
	local       map[string]*tableNode
	used        map[string]*tableNode
	usedNames   map[string]bool // constraint names of the used documents
	constraints map[string]bool
}

func (v *validator) add(rule string, t token, format string, args ...any) {
	v.out = append(v.out, diagnosticAt(rule, t, format, args...))
}

func (v *validator) name(t token) {
	v.out = append(v.out, nameDiagnostics(t)...)
}

func (v *validator) table(name string) *tableNode {
	if t, ok := v.local[name]; ok {
		return t
	}
	return v.used[name]
}

// validate checks every rule that needs more than one line. deep validates
// each used document as well; a used document is validated against the parse
// trees of its own used documents only.
func (s *session) validate(doc *documentNode, deep bool) []Diagnostic {
	v := &validator{s: s, doc: doc, local: map[string]*tableNode{}, used: map[string]*tableNode{}, usedNames: map[string]bool{}, constraints: map[string]bool{}}
	v.uses(deep)
	for _, t := range doc.tables {
		if t.name.line == 0 {
			continue
		}
		v.name(t.name)
		if _, ok := v.local[t.name.text]; ok {
			v.add(RuleNameDuplicate, t.name, "table %q is defined twice", t.name.text)
			continue
		}
		if _, ok := v.used[t.name.text]; ok {
			v.add(RuleNameDuplicate, t.name, "table %q is also a used table", t.name.text)
			continue
		}
		v.local[t.name.text] = t
	}
	for _, name := range doc.constraints {
		v.name(name)
		switch {
		case v.constraints[name.text]:
			v.add(RuleNameDuplicate, name, "index, unique key, foreign key or check name %q repeats in the schema", name.text)
		case v.usedNames[name.text]:
			v.add(RuleNameDuplicate, name, "index, unique key, foreign key or check name %q is defined in a used document", name.text)
		}
		v.constraints[name.text] = true
	}
	for _, t := range doc.tables {
		v.tableRules(t)
	}
	v.diagrams()
	return v.out
}

func (v *validator) uses(deep bool) {
	documents := map[string]bool{}
	for _, u := range v.doc.uses {
		name := u.document.text
		if documents[name] {
			v.add(RuleNameDuplicate, u.document, "document %q is used twice", name)
			continue
		}
		documents[name] = true
		parsed, ok := v.s.document(name)
		if !ok {
			v.add(RuleUse, u.document, "document %q is not in the declared document set", name)
			continue
		}
		if parsed.stopped || parsed.document.name.text != name {
			if parsed.stopped {
				v.add(RuleUse, u.document, "used document %q is invalid: line %d column %d %s: %s", name,
					parsed.diagnostics[0].Line, parsed.diagnostics[0].Column, parsed.diagnostics[0].Rule, parsed.diagnostics[0].Message)
			} else {
				v.add(RuleUse, u.document, "the document set entry %q holds document %q", name, parsed.document.name.text)
			}
			continue
		}
		if deep {
			diagnostics := append(slices.Clone(parsed.diagnostics), v.s.validate(parsed.document, false)...)
			if len(diagnostics) > 0 {
				first := diagnostics[0]
				for _, d := range diagnostics[1:] {
					if d.Line < first.Line || (d.Line == first.Line && d.Column < first.Column) {
						first = d
					}
				}
				v.add(RuleUse, u.document, "used document %q is invalid: line %d column %d %s: %s", name, first.Line, first.Column, first.Rule, first.Message)
			}
		}
		defined := map[string]*tableNode{}
		for _, t := range parsed.document.tables {
			if t.name.line != 0 {
				if _, ok := defined[t.name.text]; !ok {
					defined[t.name.text] = t
				}
			}
		}
		for _, n := range parsed.document.constraints {
			v.usedNames[n.text] = true
		}
		listed := map[string]bool{}
		for _, t := range u.tables {
			if listed[t.text] {
				v.add(RuleNameDuplicate, t, "table %q is listed twice", t.text)
				continue
			}
			listed[t.text] = true
			target, ok := defined[t.text]
			if !ok {
				v.add(RuleUse, t, "document %q does not define table %q", name, t.text)
				continue
			}
			if _, ok := v.used[t.text]; ok {
				v.add(RuleNameDuplicate, t, "table %q is already used from another document", t.text)
				continue
			}
			v.used[t.text] = target
		}
	}
}

func (v *validator) tableRules(t *tableNode) {
	if len(t.columns) == 0 {
		v.add(RuleColumn, t.anchor(), "table has no column")
	}
	seen := map[string]bool{}
	var identity *columnNode
	for _, c := range t.columns {
		v.name(c.name)
		if seen[c.name.text] {
			v.add(RuleNameDuplicate, c.name, "column %q repeats in the table", c.name.text)
		}
		seen[c.name.text] = true
		if c.identity != nil {
			switch {
			case c.null != nil:
				v.add(RuleColumn, *c.identity, "an identity column cannot be null")
			case c.typ.valid && c.typ.typ.Kind != TypeI64:
				v.add(RuleColumn, *c.identity, "an identity column has type i64, not %s", c.typ.typ)
			case identity != nil:
				v.add(RuleColumn, *c.identity, "a table has at most one identity column")
			}
			if identity == nil {
				identity = c
			}
		}
		if c.dflt == nil {
			continue
		}
		switch {
		case c.identity != nil:
			v.add(RuleColumn, *c.dflt, "an identity column has no default")
		case c.typ.valid && (c.typ.typ.Kind == TypeText || c.typ.typ.Kind == TypeBytes):
			v.add(RuleColumn, *c.dflt, "a %s column has no default", c.typ.typ.Kind)
		case c.typ.valid:
			literal, ok := canonicalDefault(c.typ.typ, *c.value)
			if !ok {
				v.add(RuleColumn, *c.value, "default %s is not a literal of type %s", c.value.describe(), c.typ.typ)
			}
			c.literal = literal
		}
	}

	switch len(t.primaryKeys) {
	case 0:
		v.add(RuleKey, t.anchor(), "table has no primary key")
	default:
		for _, extra := range t.primaryKeys[1:] {
			v.add(RuleKey, extra.keyword, "table has more than one primary key")
		}
		pk := t.primaryKeys[0]
		v.keyColumns(t, pk, true)
		if identity != nil && (len(pk.columns) != 1 || pk.columns[0].text != identity.name.text) {
			v.add(RuleColumn, *identity.identity, "the identity column must be the only primary key column")
		}
	}
	for _, k := range t.uniques {
		v.keyColumns(t, k, false)
	}
	for _, k := range t.indexes {
		v.keyColumns(t, k, false)
	}
	for _, f := range t.foreignKeys {
		v.foreignKey(t, f)
	}
	propagated := map[string]bool{}
	for _, f := range t.foreignKeys {
		if f.propagates() {
			for _, c := range f.columns {
				propagated[c.text] = true
			}
		}
	}
	for _, k := range t.checks {
		for _, ref := range k.refs {
			switch {
			case t.column(ref.text) == nil:
				v.add(RuleCheck, ref, "column %q is not a column of the table", ref.text)
			case propagated[ref.text]:
				v.add(RuleCheck, ref, "column %q belongs to a foreign key with cascade or set_null", ref.text)
			}
		}
	}
	if t.settings != nil {
		v.settings(t)
	}
}

// keyColumns checks the column list of a primary key, unique key or index.
func (v *validator) keyColumns(t *tableNode, k *keyNode, primary bool) {
	seen := map[string]bool{}
	varchars := 0
	for i, ct := range k.columns {
		if i == maxKeyColumns {
			v.add(RuleKey, ct, "a key or index lists at most %d columns", maxKeyColumns)
		}
		c := t.column(ct.text)
		switch {
		case c == nil:
			v.add(RuleKey, ct, "column %q is not a column of the table", ct.text)
			continue
		case seen[ct.text]:
			v.add(RuleKey, ct, "column %q repeats in the key", ct.text)
			continue
		}
		seen[ct.text] = true
		if c.typ.valid && (c.typ.typ.Kind == TypeText || c.typ.typ.Kind == TypeBytes) {
			v.add(RuleKey, ct, "a %s column cannot be part of a key or index", c.typ.typ.Kind)
		}
		if primary && c.null != nil {
			v.add(RuleKey, ct, "primary key column %q is nullable", ct.text)
		}
		if !primary && c.typ.valid && c.typ.typ.Kind == TypeVarchar {
			before := varchars
			varchars += c.typ.typ.Length
			if before <= maxKeyVarcharChars && varchars > maxKeyVarcharChars {
				v.add(RuleKey, ct, "the varchar columns of the key total %d characters, more than %d", varchars, maxKeyVarcharChars)
			}
		}
	}
}

func sameNames(tokens []token, names []string) bool {
	if len(tokens) != len(names) {
		return false
	}
	for i := range tokens {
		if tokens[i].text != names[i] {
			return false
		}
	}
	return true
}

func tokenTexts(tokens []token) []string {
	out := make([]string, len(tokens))
	for i, t := range tokens {
		out[i] = t.text
	}
	return out
}

func (v *validator) foreignKey(t *tableNode, f *foreignKeyNode) {
	for _, a := range []*token{f.onDelete, f.onUpdate} {
		if a != nil && a.text != string(ActionRestrict) && a.text != string(ActionCascade) && a.text != string(ActionSetNull) {
			v.add(RuleForeignKey, *a, "action %q is not restrict, cascade or set_null", a.text)
		}
	}
	children := make([]*columnNode, len(f.columns))
	known := true
	seen := map[string]bool{}
	for i, ct := range f.columns {
		children[i] = t.column(ct.text)
		switch {
		case children[i] == nil:
			v.add(RuleForeignKey, ct, "column %q is not a column of the table", ct.text)
			known = false
		case seen[ct.text]:
			v.add(RuleForeignKey, ct, "column %q repeats in the foreign key", ct.text)
			known = false
		}
		seen[ct.text] = true
	}
	target := v.table(f.target.text)
	if target == nil {
		v.add(RuleForeignKey, f.target, "table %q is not a table of this document or a used table", f.target.text)
	} else {
		parents := make([]*columnNode, len(f.references))
		referencesKnown := true
		for i, rt := range f.references {
			if parents[i] = target.column(rt.text); parents[i] == nil {
				v.add(RuleForeignKey, rt, "column %q is not a column of table %q", rt.text, f.target.text)
				referencesKnown = false
			}
		}
		if len(f.columns) != len(f.references) {
			v.add(RuleForeignKey, f.name, "foreign key lists %d columns and %d referenced columns", len(f.columns), len(f.references))
		} else if referencesKnown {
			references := tokenTexts(f.references)
			matches := len(target.primaryKeys) > 0 && sameNames(target.primaryKeys[0].columns, references)
			for _, u := range target.uniques {
				matches = matches || sameNames(u.columns, references)
			}
			if !matches {
				v.add(RuleForeignKey, f.name, "the referenced columns are not the primary key or a unique key of table %q", f.target.text)
			}
			for i, c := range children {
				if c != nil && c.typ.valid && parents[i].typ.valid && c.typ.typ != parents[i].typ.typ {
					v.add(RuleForeignKey, f.columns[i], "column %q has type %s, the referenced column has %s", c.name.text, c.typ.typ, parents[i].typ.typ)
				}
			}
		}
	}
	if known && !v.leadingIndex(t, tokenTexts(f.columns)) {
		v.add(RuleForeignKey, f.name, "the table declares no index or key whose leading columns are the foreign key columns")
	}
	if actionOf(f.onDelete) == ActionSetNull || actionOf(f.onUpdate) == ActionSetNull {
		for _, c := range children {
			if c != nil && c.null == nil {
				v.add(RuleForeignKey, f.name, "set_null requires every foreign key column to be null; %q is not", c.name.text)
				break
			}
		}
	}
}

// leadingIndex reports whether a key or index of t starts with columns.
func (v *validator) leadingIndex(t *tableNode, columns []string) bool {
	leads := func(k *keyNode) bool {
		return len(k.columns) >= len(columns) && sameNames(k.columns[:len(columns)], columns)
	}
	for _, group := range [][]*keyNode{t.primaryKeys, t.uniques, t.indexes} {
		for _, k := range group {
			if leads(k) {
				return true
			}
		}
	}
	return false
}

func (v *validator) diagrams() {
	names := map[string]bool{}
	for _, d := range v.doc.diagrams {
		if d.name.line == 0 {
			continue
		}
		v.name(d.name)
		if names[d.name.text] {
			v.add(RuleNameDuplicate, d.name, "diagram %q is defined twice", d.name.text)
		}
		names[d.name.text] = true
		placed := map[string]bool{}
		for _, e := range d.entries {
			switch {
			case v.table(e.table.text) == nil:
				v.add(RuleDiagram, e.table, "table %q is not a table of this document or a used table", e.table.text)
			case placed[e.table.text]:
				v.add(RuleDiagram, e.table, "table %q appears twice in the diagram", e.table.text)
			}
			placed[e.table.text] = true
			for _, c := range []token{e.x, e.y} {
				if _, ok := coordinate(c); !ok {
					v.add(RuleDiagram, c, "coordinate %s is not an integer", c.describe())
				}
			}
		}
	}
}
