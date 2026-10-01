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
	s     *session
	doc   *documentNode
	out   []Diagnostic
	local map[string]*tableNode
	used  map[string]*tableNode
	// usedConstraints maps each constraint name of a directly used document
	// to that document; usedTables holds every table name of those documents.
	usedConstraints map[string]string
	usedTables      map[string]bool
}

func (v *validator) add(rule string, t token, format string, args ...any) {
	v.out = append(v.out, diagnosticAt(rule, t, format, args...))
}

// ref checks a referenced name. A malformed name reports name.format or
// name.length and is not resolved further.
func (v *validator) ref(t token) bool {
	if wellFormed(t.text) {
		return true
	}
	v.out = append(v.out, nameDiagnostics(t)...)
	return false
}

func (v *validator) table(name string) *tableNode {
	if t, ok := v.local[name]; ok {
		return t
	}
	return v.used[name]
}

// validate checks every rule that needs more than one line. stack holds the
// names of the documents being validated, this one last, to find use cycles.
// Each used document is parsed and validated with its own use lines.
func (s *session) validate(doc *documentNode, stack []string) []Diagnostic {
	v := &validator{s: s, doc: doc, local: map[string]*tableNode{}, used: map[string]*tableNode{},
		usedConstraints: map[string]string{}, usedTables: map[string]bool{}}
	v.uses(stack)
	for _, t := range doc.tables {
		if t.name.line == 0 {
			continue
		}
		if _, ok := v.local[t.name.text]; ok {
			if !t.failed {
				v.add(RuleNameDuplicate, t.name, "table %q is defined twice", t.name.text)
			}
			continue
		}
		if t.failed {
			v.local[t.name.text] = t
			continue
		}
		switch {
		case v.used[t.name.text] != nil:
			v.add(RuleNameDuplicate, t.name, "table %q is also a used table", t.name.text)
		case v.usedConstraints[t.name.text] != "":
			v.add(RuleNameDuplicate, t.name, "table %q is named like a constraint of document %q", t.name.text, v.usedConstraints[t.name.text])
		}
		if v.used[t.name.text] == nil {
			v.local[t.name.text] = t
		}
	}
	seen := map[string]bool{}
	for _, name := range doc.constraints {
		switch {
		case seen[name.text]:
			v.add(RuleNameDuplicate, name, "index, unique key, foreign key or check name %q repeats in the schema", name.text)
		case v.usedConstraints[name.text] != "":
			v.add(RuleNameDuplicate, name, "name %q is a constraint name of used document %q", name.text, v.usedConstraints[name.text])
		case v.local[name.text] != nil || v.usedTables[name.text]:
			v.add(RuleNameDuplicate, name, "name %q is also a table name", name.text)
		}
		seen[name.text] = true
	}
	for _, t := range doc.tables {
		v.tableRules(t)
	}
	v.diagrams()
	return v.out
}

// firstDiagnostic returns the first diagnostic in source order.
func firstDiagnostic(diagnostics []Diagnostic) Diagnostic {
	sortDiagnostics(diagnostics)
	return diagnostics[0]
}

func (v *validator) uses(stack []string) {
	documents := map[string]bool{}
	for _, u := range v.doc.uses {
		if !v.ref(u.document) {
			continue
		}
		name := u.document.text
		if documents[name] {
			v.add(RuleNameDuplicate, u.document, "document %q is used twice", name)
			continue
		}
		documents[name] = true
		if name == v.doc.name.text {
			v.add(RuleUse, u.document, "a document cannot use itself")
			continue
		}
		if slices.Contains(stack, name) {
			v.add(RuleUse, u.document, "using document %q closes a use cycle", name)
			continue
		}
		parsed, ok := v.s.document(name)
		if !ok {
			v.add(RuleUse, u.document, "document %q is not in the declared document set", name)
			continue
		}
		if !parsed.stopped && parsed.document.name.text != name {
			v.add(RuleUse, u.document, "the document set entry %q holds document %q", name, parsed.document.name.text)
			continue
		}
		diagnostics := slices.Clone(parsed.diagnostics)
		if !parsed.stopped {
			diagnostics = append(diagnostics, v.s.validate(parsed.document, append(slices.Clone(stack), name))...)
		}
		if len(diagnostics) > 0 {
			first := firstDiagnostic(diagnostics)
			v.add(RuleUse, u.document, "used document %q is invalid: line %d column %d %s: %s", name, first.Line, first.Column, first.Rule, first.Message)
		}
		if parsed.stopped {
			continue
		}
		defined := map[string]*tableNode{}
		for _, t := range parsed.document.tables {
			if t.name.line != 0 {
				v.usedTables[t.name.text] = true
				if _, ok := defined[t.name.text]; !ok {
					defined[t.name.text] = t
				}
			}
		}
		repeated := false
		for _, n := range parsed.document.constraints {
			if owner := v.usedConstraints[n.text]; owner != "" && owner != name && !repeated {
				v.add(RuleNameDuplicate, u.document, "document %q repeats constraint name %q of document %q", name, n.text, owner)
				repeated = true
			}
			if v.usedConstraints[n.text] == "" {
				v.usedConstraints[n.text] = name
			}
		}
		listed := map[string]bool{}
		for _, t := range u.tables {
			if !v.ref(t) {
				continue
			}
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

// columnRef resolves a referenced column of t. It reports rule at the token
// when the column is unknown, and returns nil without a report when the name
// is malformed or its column line failed.
func (v *validator) columnRef(t *tableNode, ref token, rule string) *columnNode {
	if !v.ref(ref) {
		return nil
	}
	c := t.column(ref.text)
	if c == nil && !t.failedName(ref.text) {
		v.add(rule, ref, "column %q is not a column of table %q", ref.text, t.name.text)
	}
	return c
}

func (v *validator) tableRules(t *tableNode) {
	if len(t.columns) == 0 && t.failedLines == 0 {
		v.add(RuleColumn, t.anchor(), "table has no column")
	}
	seen := map[string]bool{}
	var identity *columnNode
	for _, c := range t.columns {
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

	switch {
	case len(t.primaryKeys) == 0 && !t.failedPK:
		v.add(RuleKey, t.anchor(), "table has no primary key")
	case len(t.primaryKeys) > 0:
		for _, extra := range t.primaryKeys[1:] {
			v.add(RuleKey, extra.keyword, "table has more than one primary key")
		}
		pk := t.primaryKeys[0]
		v.keyColumns(t, pk, true)
		resolved := true
		for _, c := range pk.columns {
			resolved = resolved && wellFormed(c.text) && !t.failedName(c.text)
		}
		if identity != nil && resolved && (len(pk.columns) != 1 || pk.columns[0].text != identity.name.text) {
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
	// A check expression reports only its first diagnostic.
	for _, k := range t.checks {
		before := len(v.out)
		for _, ref := range k.refs {
			if v.columnRef(t, ref, RuleCheck) != nil && propagated[ref.text] {
				v.add(RuleCheck, ref, "column %q belongs to a foreign key with cascade or set_null", ref.text)
			}
			if len(v.out) > before {
				v.out = v.out[:before+1]
				break
			}
		}
	}
	if t.settings != nil {
		v.settings(t)
	}
}

// keyColumns checks the column list of a primary key, unique key or index.
// The 16-column and 640-character limits point at the key name or primary.
func (v *validator) keyColumns(t *tableNode, k *keyNode, primary bool) {
	anchor := k.name
	if primary {
		anchor = k.keyword
	}
	if len(k.columns) > maxKeyColumns {
		v.add(RuleKey, anchor, "a key or index lists %d columns, more than %d", len(k.columns), maxKeyColumns)
	}
	seen := map[string]bool{}
	varchars := 0
	for _, ct := range k.columns {
		c := v.columnRef(t, ct, RuleKey)
		if c == nil {
			continue
		}
		if seen[ct.text] {
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
		if c.typ.valid && c.typ.typ.Kind == TypeVarchar {
			varchars += c.typ.typ.Length
		}
	}
	if varchars > maxKeyVarcharChars {
		v.add(RuleKey, anchor, "the varchar columns of the key total %d characters, more than %d", varchars, maxKeyVarcharChars)
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
		children[i] = v.columnRef(t, ct, RuleForeignKey)
		switch {
		case children[i] == nil:
			known = false
		case seen[ct.text]:
			v.add(RuleForeignKey, ct, "column %q repeats in the foreign key", ct.text)
			known = false
		}
		seen[ct.text] = true
	}
	var target *tableNode
	if v.ref(f.target) {
		if target = v.table(f.target.text); target == nil {
			v.add(RuleForeignKey, f.target, "table %q is not a table of this document or a used table", f.target.text)
		}
	}
	if target != nil && !target.failed {
		parents := make([]*columnNode, len(f.references))
		referencesKnown := true
		for i, rt := range f.references {
			if parents[i] = v.columnRef(target, rt, RuleForeignKey); parents[i] == nil {
				referencesKnown = false
			}
		}
		if len(f.columns) != len(f.references) {
			v.add(RuleForeignKey, f.name, "foreign key lists %d columns and %d referenced columns", len(f.columns), len(f.references))
		} else if referencesKnown && !target.failedPK && !target.failedKey {
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
					v.add(RuleForeignKey, f.name, "column %q has type %s, the referenced column has %s", c.name.text, c.typ.typ, parents[i].typ.typ)
					break
				}
			}
		}
	}
	if known && !t.failedPK && !t.failedKey && !v.leadingIndex(t, tokenTexts(f.columns)) {
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
		if names[d.name.text] && !d.failed {
			v.add(RuleNameDuplicate, d.name, "diagram %q is defined twice", d.name.text)
		}
		names[d.name.text] = true
		placed := map[string]bool{}
		for _, e := range d.entries {
			if v.ref(e.table) {
				switch {
				case v.table(e.table.text) == nil:
					v.add(RuleDiagram, e.table, "table %q is not a table of this document or a used table", e.table.text)
				case placed[e.table.text]:
					v.add(RuleDiagram, e.table, "table %q appears twice in the diagram", e.table.text)
				}
				placed[e.table.text] = true
			}
			for _, c := range []token{e.x, e.y} {
				if _, ok := coordinate(c); !ok {
					v.add(RuleDiagram, c, "coordinate %s is not an integer from -2147483648 to 2147483647", c.describe())
				}
			}
		}
	}
}
