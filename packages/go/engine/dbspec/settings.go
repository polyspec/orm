package dbspec

import (
	"maps"
	"math"
	"slices"
	"strconv"
	"unicode/utf8"
)

// codecStages maps each codec stage to the storage it produces
// (docs/spec/dbspec.md "Settings"): true for bytes, false for text.
var codecStages = map[string]bool{
	"hex": false, "base64": false, "ordered_json": false, "yaml": false, "serialize": false,
	"aes": true, "gz": true, "ip": true,
}

func isInteger(t Type) bool {
	return t.Kind == TypeI16 || t.Kind == TypeI32 || t.Kind == TypeI64
}

// settings checks the settings block of t. Whole-setting and companion rules
// point at the setting keyword, column type rules at the column, and the
// history table shape at the history table name.
func (v *validator) settings(t *tableNode) {
	once := map[string]bool{}
	repeatable := map[string]map[string]bool{"codec": {}, "navigation": {}, "blind_index": {}, "markdown": {}}
	byKind := map[string]*settingNode{}
	var aesCodecs, accepted []*settingNode
	aesColumns := map[string]bool{}
	for _, s := range t.settings.lines {
		kind := s.keyword.text
		if seen, ok := repeatable[kind]; ok {
			if seen[s.args[0].text] {
				v.add(RuleSetting, s.keyword, "%s repeats for %q", kind, s.args[0].text)
				continue
			}
			seen[s.args[0].text] = true
		} else if kind != "state_machine" && kind != "checkbox" {
			// state_machine and checkbox are written on several lines, so they are excluded from the once check.
			if once[kind] {
				v.add(RuleSetting, s.keyword, "setting %s repeats", kind)
				continue
			}
			once[kind] = true
			byKind[kind] = s
		}
		accepted = append(accepted, s)
		if kind == "codec" {
			for _, stage := range s.args[1:] {
				if stage.text == "aes" {
					aesCodecs = append(aesCodecs, s)
					aesColumns[s.args[0].text] = true
					break
				}
			}
		}
	}
	for _, s := range accepted {
		v.setting(t, s, aesColumns)
	}
	v.stateMachineConsistency(t)
	if aesVersion := byKind["aes_version"]; aesVersion == nil {
		for _, s := range aesCodecs {
			v.add(RuleSetting, s.keyword, "a column with the aes stage requires an aes_version setting")
		}
	} else if len(aesCodecs) == 0 {
		v.add(RuleSetting, aesVersion.keyword, "aes_version without a column that uses aes")
	}
}

func (v *validator) propagatedChild(t *tableNode) bool {
	for _, f := range t.foreignKeys {
		if f.propagates() {
			return true
		}
	}
	return false
}

func (v *validator) setting(t *tableNode, s *settingNode, aesColumns map[string]bool) {
	switch s.keyword.text {
	case "updated":
		if c := v.columnRef(t, s.args[0], RuleSetting); c != nil && c.typ.valid && c.typ.typ.Kind != TypeDatetime {
			v.add(RuleSetting, s.args[0], "updated needs a datetime column, not %s", c.typ.typ)
		}
	case "soft_delete":
		if c := v.columnRef(t, s.args[0], RuleSetting); c != nil && ((c.typ.valid && c.typ.typ.Kind != TypeDatetime) || c.null == nil) {
			v.add(RuleSetting, s.args[0], "soft_delete needs a nullable datetime column")
		}
	case "aes_version":
		if c := v.columnRef(t, s.args[0], RuleSetting); c != nil && ((c.typ.valid && !isInteger(c.typ.typ)) || c.null != nil) {
			v.add(RuleSetting, s.args[0], "aes_version needs a non-null integer column")
		}
	case "select":
		seen := map[string]bool{}
		for _, ref := range s.args {
			if seen[ref.text] {
				v.add(RuleSetting, ref, "column %q repeats in select explicit", ref.text)
				continue
			}
			seen[ref.text] = true
			v.columnRef(t, ref, RuleSetting)
		}
	case "codec":
		v.codec(t, s)
	case "blind_index":
		v.blindIndex(t, s, aesColumns)
	case "navigation":
		v.foreignKeyName(t, s.args[0])
	case "store":
		v.store(t, s)
	case "key_prefix":
		v.keyPrefix(t, s)
	case "title", "body":
		v.textColumn(t, s)
	case "order":
		v.order(t, s)
	case "immutable":
		if v.propagatedChild(t) {
			v.add(RuleSetting, s.keyword, "immutable is rejected on a child of a cascade or set_null foreign key")
		}
	case "audit":
		v.audit(t, s)
	case "state_machine":
		v.stateMachine(t, s)
	case "markdown":
		if c := v.columnRef(t, s.args[0], RuleSetting); c != nil && c.typ.valid &&
			c.typ.typ.Kind != TypeVarchar && c.typ.typ.Kind != TypeText {
			v.add(RuleSetting, s.args[0], "markdown needs a varchar or text column, not %s", c.typ.typ)
		}
	}
}

// foreignKeyName checks whether the name refers to a foreign key of the table.
func (v *validator) foreignKeyName(t *tableNode, ref token) {
	if v.ref(ref) && !t.failedName(ref.text) {
		found := false
		for _, f := range t.foreignKeys {
			found = found || f.name.text == ref.text
		}
		if !found {
			v.add(RuleSetting, ref, "foreign key %q is not a foreign key of the table", ref.text)
		}
	}
}

// stateMachine checks one `state_machine <column> ...` line: the column is a
// non-null varchar or text column of the table and the require list names
// columns of the table (docs/spec/dbspec.md "Settings").
func (v *validator) stateMachine(t *tableNode, s *settingNode) {
	columnRef := s.args[0]
	column := v.columnRef(t, columnRef, RuleSetting)
	if column != nil && ((column.typ.valid && column.typ.typ.Kind != TypeVarchar && column.typ.typ.Kind != TypeText) || column.null != nil) {
		v.add(RuleSetting, columnRef, "state_machine needs a non-null varchar or text column")
	}
	for _, list := range s.lists {
		for _, ref := range list.columns {
			v.columnRef(t, ref, RuleSetting)
		}
	}
}

// stateMachineConsistency checks the machine's lines against each other: one column per table,
// consistency among the initial, transition, and terminal lines, the history and limit lines, the default of the state column,
// and the checkbox lines (docs/spec/dbspec.md "Settings").
func (v *validator) stateMachineConsistency(t *tableNode) {
	column := ""
	states := map[string]bool{}
	initials := map[string]bool{}
	terminals := map[string]bool{}
	var lines, limits []*settingNode
	var history *settingNode
	var requires []token
	// seen holds the identity of each initial, terminal and transition line: its form and states, never its require list.
	seen := map[string]bool{}
	for _, s := range t.settings.lines {
		if s.keyword.text != "state_machine" {
			continue
		}
		if column == "" {
			column = s.args[0].text
		} else if s.args[0].text != column {
			v.add(RuleSetting, s.args[0], "state_machine repeats for %q; a table holds one machine", s.args[0].text)
		}
		switch s.form {
		case "history":
			if history != nil {
				v.add(RuleSetting, s.keyword, "state_machine repeats history")
				continue
			}
			history = s
		case "limit":
			limits = append(limits, s)
		default:
			// A line of another column already reports that a table holds one machine; it is no line of this one.
			key, what := machineLine(s)
			if s.args[0].text == column && seen[key] {
				v.add(RuleSetting, s.keyword, "state_machine repeats %s", what)
				continue
			}
			if s.args[0].text == column {
				seen[key] = true
			}
			lines = append(lines, s)
			for _, list := range s.lists {
				requires = append(requires, list.columns...)
			}
			switch s.form {
			case "initial":
				initials[s.args[1].text] = true
				states[s.args[1].text] = true
			case "terminal":
				terminals[s.args[1].text] = true
				states[s.args[1].text] = true
			default:
				states[s.args[1].text] = true
				states[s.args[2].text] = true
			}
		}
	}
	for _, s := range lines {
		switch s.form {
		case "initial":
			if terminals[s.args[1].text] {
				v.add(RuleSetting, s.keyword, "an initial state %q is also terminal", s.args[1].text)
			}
		case "transition":
			if terminals[s.args[1].text] {
				v.add(RuleSetting, s.keyword, "a transition leaves the terminal state %q", s.args[1].text)
			}
		}
	}
	v.limits(limits, states)
	if history != nil {
		v.history(t, history, t.column(column), requires)
	}
	if c := t.column(column); column != "" && c != nil && c.value != nil && c.dflt != nil && !initials[c.value.text] {
		v.add(RuleSetting, *c.value, "the default %q of the state column is not an initial state", c.value.text)
	}
	v.checkboxes(t, column, states)
}

// limits checks each limit line: the state belongs to the state set, is not repeated per state, and count is a positive integer.
func (v *validator) limits(lines []*settingNode, states map[string]bool) {
	seen := map[string]bool{}
	for _, s := range lines {
		state := s.args[1]
		switch {
		case !states[state.text]:
			v.add(RuleSetting, state, "limit names state %q outside the state set", state.text)
		case seen[state.text]:
			v.add(RuleSetting, state, "limit repeats for state %q", state.text)
		}
		seen[state.text] = true
		if n, err := strconv.ParseInt(s.args[2].text, 10, 64); err != nil || n < 1 {
			v.add(RuleSetting, s.args[2], "limit needs a positive row count, not %s", s.args[2].text)
		}
	}
}

// history checks the history table of a state_machine history line. Its columns
// include the foreign key that refers to this table; from and to columns with the state column's type;
// an at column of datetime(6); and, for each required column, one nullable column of the same type, and a key,
// and it declares no title or body. Every mismatch is reported at the history table's name.
func (v *validator) history(t *tableNode, s *settingNode, state *columnNode, requires []token) {
	name := s.args[1]
	if !v.ref(name) {
		return
	}
	h := v.table(name.text)
	if h == nil {
		v.add(RuleSetting, name, "history table %q is not a table of this document or a used table", name.text)
		return
	}
	if state == nil || !state.typ.valid {
		return
	}
	row := s.args[2]
	fk := false
	for _, f := range h.foreignKeys {
		fk = fk || (len(f.columns) == 1 && f.columns[0].text == row.text && f.target.text == t.name.text)
	}
	if !fk {
		v.add(RuleSetting, name, "history table %q has no foreign key of %q to table %q", name.text, row.text, t.name.text)
	}
	named := map[string]bool{row.text: true}
	typed := func(ref token, want Type) {
		named[ref.text] = true
		c := h.column(ref.text)
		switch {
		case c == nil:
			if !h.failedName(ref.text) {
				v.add(RuleSetting, name, "history table %q has no column %q", name.text, ref.text)
			}
		case c.typ.valid && c.typ.typ != want:
			v.add(RuleSetting, name, "history column %q has type %s, not %s", ref.text, c.typ.typ, want)
		}
	}
	typed(s.args[3], state.typ.typ)
	typed(s.args[4], state.typ.typ)
	typed(s.args[5], Type{Kind: TypeDatetime, Precision: 6})
	for _, r := range requires {
		named[r.text] = true
		c := t.column(r.text)
		hc := h.column(r.text)
		switch {
		case c == nil || !c.typ.valid:
		case hc == nil:
			if !h.failedName(r.text) {
				v.add(RuleSetting, name, "history table %q has no column %q of the required column", name.text, r.text)
			}
		case hc.null == nil || (hc.typ.valid && hc.typ.typ != c.typ.typ):
			v.add(RuleSetting, name, "history column %q is not a nullable %s column", r.text, c.typ.typ)
		}
	}
	for _, k := range h.primaryKeys {
		for _, ct := range k.columns {
			named[ct.text] = true
		}
	}
	for _, c := range h.columns {
		if !named[c.name.text] {
			v.add(RuleSetting, name, "history table %q has column %q, which the history line does not name", name.text, c.name.text)
		}
	}
	if h.settings != nil {
		for _, hs := range h.settings.lines {
			if hs.keyword.text == "title" || hs.keyword.text == "body" {
				v.add(RuleSetting, name, "history table %q declares %s, which a history table does not", name.text, hs.keyword.text)
			}
		}
	}
}

// checkboxes checks checkbox lines against the machine's state set: each names the machine's column, and for each state in the set there is one line with a single character and a distinct glyph; no line names another state.
func (v *validator) checkboxes(t *tableNode, column string, states map[string]bool) {
	var boxes []*settingNode
	for _, s := range t.settings.lines {
		if s.keyword.text == "checkbox" {
			boxes = append(boxes, s)
		}
	}
	if len(boxes) == 0 {
		return
	}
	first := boxes[0]
	if column == "" {
		v.add(RuleSetting, first.args[0], "checkbox needs a state_machine on column %q", first.args[0].text)
		return
	}
	covered := map[string]bool{}
	glyphs := map[string]bool{}
	for _, b := range boxes {
		if v.columnRef(t, b.args[0], RuleSetting) == nil {
			continue
		}
		if b.args[0].text != column {
			v.add(RuleSetting, b.args[0], "checkbox names column %q, but the state_machine column is %q", b.args[0].text, column)
			continue
		}
		state := b.args[1]
		switch {
		case !states[state.text]:
			v.add(RuleSetting, state, "checkbox names state %q outside the state set", state.text)
		case covered[state.text]:
			v.add(RuleSetting, state, "checkbox repeats for state %q", state.text)
		}
		covered[state.text] = true
		glyph := b.args[2]
		switch {
		case utf8.RuneCountInString(glyph.text) != 1:
			v.add(RuleSetting, glyph, "a checkbox glyph is one character")
		case glyphs[glyph.text]:
			v.add(RuleSetting, glyph, "checkbox glyph %q repeats", glyph.text)
		}
		glyphs[glyph.text] = true
	}
	for _, state := range slices.Sorted(maps.Keys(states)) {
		if !covered[state] {
			v.add(RuleSetting, first.keyword, "checkbox does not cover state %q", state)
		}
	}
}

// store checks block storage: its foreign key must be a foreign key of the table. The kind and shape are read by the parser.
// A shard clause takes a non-null date or datetime column; it is rejected for block tables, for tables with a self foreign key,
// and for tables with an order.
func (v *validator) store(t *tableNode, s *settingNode) {
	if s.args[0].text == "block" {
		v.foreignKeyName(t, s.args[1])
	}
	// A shard clause comes right after the kind's arguments (0 for files, 1 for document, 2 for block).
	i := map[string]int{"files": 1, "document": 2, "block": 3}[s.args[0].text]
	if len(s.args) <= i {
		return
	}
	shard, column := s.args[i], s.args[i+1]
	if c := v.columnRef(t, column, RuleSetting); c != nil &&
		((c.typ.valid && c.typ.typ.Kind != TypeDate && c.typ.typ.Kind != TypeDatetime) || c.null != nil) {
		v.add(RuleSetting, column, "store shard needs a non-null date or datetime column")
	}
	if s.args[0].text == "block" {
		v.add(RuleSetting, shard, "store shard is rejected on a block table")
	}
	if slices.ContainsFunc(t.foreignKeys, func(f *foreignKeyNode) bool { return f.target.text == t.name.text }) {
		v.add(RuleSetting, shard, "store shard is rejected on a table with a self foreign key")
	}
	if slices.ContainsFunc(t.settings.lines, func(l *settingNode) bool { return l.keyword.text == "order" }) {
		v.add(RuleSetting, shard, "store shard is rejected on a table with order")
	}
}

// keyPrefix checks that the primary key is a single varchar column.
func (v *validator) keyPrefix(t *tableNode, s *settingNode) {
	if t.failedPK {
		return
	}
	if len(t.primaryKeys) != 1 || len(t.primaryKeys[0].columns) != 1 {
		v.add(RuleSetting, s.keyword, "key_prefix needs a single-column primary key")
		return
	}
	if c := t.column(t.primaryKeys[0].columns[0].text); c != nil && c.typ.valid && c.typ.typ.Kind != TypeVarchar {
		v.add(RuleSetting, s.keyword, "key_prefix needs a varchar primary key, not %s", c.typ.typ)
	}
}

// textColumn checks the title and body columns: each is a non-null varchar or text column.
func (v *validator) textColumn(t *tableNode, s *settingNode) {
	c := v.columnRef(t, s.args[0], RuleSetting)
	if c != nil && ((c.typ.valid && c.typ.typ.Kind != TypeVarchar && c.typ.typ.Kind != TypeText) || c.null != nil) {
		v.add(RuleSetting, s.args[0], "%s needs a non-null varchar or text column", s.keyword.text)
	}
}

// order checks the order column: a non-null i32 or i64 column with no default, and not in any key, index, or check.
func (v *validator) order(t *tableNode, s *settingNode) {
	c := v.columnRef(t, s.args[0], RuleSetting)
	if c == nil {
		return
	}
	if (c.typ.valid && c.typ.typ.Kind != TypeI32 && c.typ.typ.Kind != TypeI64) || c.null != nil || c.dflt != nil {
		v.add(RuleSetting, s.args[0], "order needs a non-null i32 or i64 column with no default")
		return
	}
	if inKeyOrCheck(t, s.args[0].text) {
		v.add(RuleSetting, s.args[0], "order column %q is in a key, index or check", s.args[0].text)
	}
}

// inKeyOrCheck reports whether a primary key, unique key, index, foreign key, or check of t names that column.
func inKeyOrCheck(t *tableNode, column string) bool {
	for _, group := range [][]*keyNode{t.primaryKeys, t.uniques, t.indexes} {
		for _, k := range group {
			if slices.ContainsFunc(k.columns, func(ct token) bool { return ct.text == column }) {
				return true
			}
		}
	}
	for _, f := range t.foreignKeys {
		if slices.ContainsFunc(f.columns, func(ct token) bool { return ct.text == column }) {
			return true
		}
	}
	for _, ch := range t.checks {
		if slices.ContainsFunc(ch.refs, func(ct token) bool { return ct.text == column }) {
			return true
		}
	}
	return false
}

// codec checks the stages and the storage type, which follows the last
// stage; ordered_json is the first stage when it appears.
func (v *validator) codec(t *tableNode, s *settingNode) {
	stages := s.args[1:]
	known := true
	for i, stage := range stages {
		_, ok := codecStages[stage.text]
		switch {
		case !ok:
			v.add(RuleSetting, stage, "codec stage %q is unknown", stage.text)
			known = false
		case stage.text == "ordered_json" && i > 0:
			v.add(RuleSetting, stage, "ordered_json is the first codec stage")
		}
	}
	c := v.columnRef(t, s.args[0], RuleSetting)
	if c == nil || !c.typ.valid || !known {
		return
	}
	if codecStages[stages[len(stages)-1].text] {
		if c.typ.typ.Kind != TypeBytes {
			v.add(RuleSetting, s.args[0], "the last codec stage %s stores bytes and needs a bytes column, not %s", stages[len(stages)-1].text, c.typ.typ)
		}
	} else if c.typ.typ.Kind != TypeVarchar && c.typ.typ.Kind != TypeText {
		v.add(RuleSetting, s.args[0], "the last codec stage %s stores text and needs a varchar or text column, not %s", stages[len(stages)-1].text, c.typ.typ)
	}
}

// blindIndex checks `blind_index <aes column> <index column>`.
func (v *validator) blindIndex(t *tableNode, s *settingNode, aesColumns map[string]bool) {
	aesRef, indexRef := s.args[0], s.args[1]
	aes := v.columnRef(t, aesRef, RuleSetting)
	if aes != nil && !aesColumns[aesRef.text] {
		v.add(RuleSetting, s.keyword, "blind_index names column %q, which has no codec with the aes stage", aesRef.text)
	}
	index := v.columnRef(t, indexRef, RuleSetting)
	if index == nil {
		return
	}
	switch {
	case aesColumns[indexRef.text]:
		v.add(RuleSetting, indexRef, "the blind index column is not AES-encoded")
	case index.typ.valid && !(index.typ.typ.Kind == TypeVarchar && index.typ.typ.Length >= 64):
		v.add(RuleSetting, indexRef, "the blind index column is varchar(n) with n >= 64, not %s", index.typ.typ)
	case aes != nil && (aes.null == nil) != (index.null == nil):
		v.add(RuleSetting, indexRef, "the blind index column has the nullability of the AES column")
	case !t.failedKey && !v.onlyIndexColumn(t, indexRef.text):
		v.add(RuleSetting, indexRef, "column %q is not the only column of a declared index or unique key", indexRef.text)
	}
}

func (v *validator) onlyIndexColumn(t *tableNode, column string) bool {
	for _, group := range [][]*keyNode{t.uniques, t.indexes} {
		for _, k := range group {
			if len(k.columns) == 1 && k.columns[0].text == column {
				return true
			}
		}
	}
	return false
}

// audit checks `audit into <history> column <c> references <table> action <c>
// previous <c> [exclude (<c>, ...) | include (<c>, ...)]`, the audit record
// table and its foreign key, and the shape of the history table, which holds
// exactly the recorded columns (docs/spec/dbspec.md "Audit").
func (v *validator) audit(t *tableNode, s *settingNode) {
	historyRef, columnRef, referencesRef, actionRef, previousRef := s.args[0], s.args[1], s.args[2], s.args[3], s.args[4]
	if v.propagatedChild(t) {
		v.add(RuleSetting, s.keyword, "audit is rejected on a child of a cascade or set_null foreign key")
	}
	column := v.columnRef(t, columnRef, RuleSetting)
	if column != nil && column.null != nil {
		v.add(RuleSetting, columnRef, "the audit column is a non-null column")
	}
	recorded := v.auditLists(t, s, columnRef)
	v.auditRecord(t, column, columnRef, referencesRef, historyRef)
	if len(s.args) == 8 {
		v.auditTables(t, s.args[5], s.args[6], s.args[7], referencesRef, historyRef)
	}
	if !v.ref(historyRef) {
		return
	}
	history := v.table(historyRef.text)
	switch {
	case history == nil:
		v.add(RuleSetting, historyRef, "history table %q is not a table of this document or a used table", historyRef.text)
		return
	case history.failed:
		return
	case history == t:
		v.add(RuleSetting, historyRef, "a table cannot be its own history table")
		return
	case history.settings != nil:
		for _, line := range history.settings.lines {
			if line.keyword.text == "audit" {
				v.add(RuleSetting, historyRef, "history table %q is audited itself", historyRef.text)
			}
		}
	}
	var identity *columnNode
	if len(history.primaryKeys) == 1 && len(history.primaryKeys[0].columns) == 1 {
		if c := history.column(history.primaryKeys[0].columns[0].text); c != nil && c.identity != nil && c.typ.valid && c.typ.typ.Kind == TypeI64 {
			identity = c
		}
	}
	if identity == nil && !history.failedPK {
		v.add(RuleSetting, historyRef, "history table %q needs an i64 identity primary key", historyRef.text)
	}
	reserved := map[string]bool{}
	if identity != nil {
		reserved[identity.name.text] = true
	}
	if v.ref(actionRef) {
		action := history.column(actionRef.text)
		switch {
		case action == nil:
			if !history.failedName(actionRef.text) {
				v.add(RuleSetting, actionRef, "column %q is not a column of history table %q", actionRef.text, historyRef.text)
			}
		case reserved[actionRef.text]:
			v.add(RuleSetting, actionRef, "the action column is a separate column of the history table")
		case action.null != nil || (action.typ.valid && action.typ.typ != (Type{Kind: TypeVarchar, Length: 8})):
			v.add(RuleSetting, actionRef, "the action column is a non-null varchar(8)")
		}
		reserved[actionRef.text] = true
	}
	if v.ref(previousRef) {
		previous := history.column(previousRef.text)
		switch {
		case previous == nil:
			if !history.failedName(previousRef.text) {
				v.add(RuleSetting, previousRef, "column %q is not a column of history table %q", previousRef.text, historyRef.text)
			}
		case reserved[previousRef.text]:
			v.add(RuleSetting, previousRef, "the previous column is a separate column of the history table")
		case previous.null == nil:
			v.add(RuleSetting, previousRef, "the previous column is nullable")
		case column != nil && previous.typ.valid && column.typ.valid && previous.typ.typ != column.typ.typ:
			v.add(RuleSetting, previousRef, "the previous column has the audit column type %s, not %s", column.typ.typ, previous.typ.typ)
		}
		reserved[previousRef.text] = true
	}
	// A setting that uses both lists does not determine which columns are recorded, so it is not matched against the history
	// table's columns.
	if recorded == nil {
		return
	}
	for _, c := range t.columns {
		if !recorded(c.name.text) {
			continue
		}
		h := history.column(c.name.text)
		switch {
		case h == nil && history.failedName(c.name.text):
		case h == nil || reserved[c.name.text]:
			v.add(RuleSetting, historyRef, "history table %q has no copy of column %q", historyRef.text, c.name.text)
		case h.typ.valid && c.typ.valid && h.typ.typ != c.typ.typ:
			v.add(RuleSetting, historyRef, "history column %q has type %s, not %s", c.name.text, h.typ.typ, c.typ.typ)
		}
	}
	for _, h := range history.columns {
		if reserved[h.name.text] || t.failedName(h.name.text) {
			continue
		}
		switch {
		case t.column(h.name.text) == nil:
			v.add(RuleSetting, historyRef, "history table %q has column %q, which is not a column of table %q", historyRef.text, h.name.text, t.name.text)
		case !recorded(h.name.text):
			v.add(RuleSetting, historyRef, "history table %q has column %q, which table %q does not record", historyRef.text, h.name.text, t.name.text)
		}
	}
}

// auditTables checks the tables table of `tables <table> (<record>, <name>)`: another table than the
// audited, the history and the audit record table, not audited itself, with exactly the record and the
// name column, the name column a varchar(n) with n >= 63, the primary key (record, name) and the foreign key
// (record) references the audit record table's key with restrict (docs/spec/dbspec.md "Audit").
func (v *validator) auditTables(t *tableNode, tablesRef, recordRef, nameRef, referencesRef, historyRef token) {
	if !v.ref(tablesRef) {
		return
	}
	tables := v.table(tablesRef.text)
	switch {
	case tables == nil:
		v.add(RuleSetting, tablesRef, "tables table %q is not a table of this document or a used table", tablesRef.text)
		return
	case tables.failed:
		return
	case tables == t || tablesRef.text == historyRef.text || tablesRef.text == referencesRef.text:
		v.add(RuleSetting, tablesRef, "the tables table is another table than the audited, the history and the audit record table")
		return
	}
	if tables.settings != nil {
		for _, line := range tables.settings.lines {
			if line.keyword.text == "audit" {
				v.add(RuleSetting, tablesRef, "tables table %q is audited itself", tablesRef.text)
				return
			}
		}
	}
	known := true
	for _, ref := range []token{recordRef, nameRef} {
		if v.ref(ref) && tables.column(ref.text) == nil && !tables.failedName(ref.text) {
			v.add(RuleSetting, ref, "column %q is not a column of tables table %q", ref.text, tablesRef.text)
			known = false
		}
	}
	if !known {
		return
	}
	if name := tables.column(nameRef.text); name != nil && name.typ.valid && !(name.typ.typ.Kind == TypeVarchar && name.typ.typ.Length >= 63) {
		v.add(RuleSetting, nameRef, "the name column is a varchar(n) with n >= 63")
	}
	for _, c := range tables.columns {
		if c.name.text != recordRef.text && c.name.text != nameRef.text {
			v.add(RuleSetting, tablesRef, "tables table %q has the extra column %q", tablesRef.text, c.name.text)
		}
	}
	if !tables.failedPK && (len(tables.primaryKeys) != 1 || len(tables.primaryKeys[0].columns) != 2 ||
		tables.primaryKeys[0].columns[0].text != recordRef.text || tables.primaryKeys[0].columns[1].text != nameRef.text) {
		v.add(RuleSetting, tablesRef, "the primary key of tables table %q is (%s, %s)", tablesRef.text, recordRef.text, nameRef.text)
	}
	record := v.table(referencesRef.text)
	if record == nil || record.failed || len(record.primaryKeys) != 1 || len(record.primaryKeys[0].columns) != 1 || tables.failedKey {
		return
	}
	key := record.primaryKeys[0].columns[0].text
	for _, fk := range tables.foreignKeys {
		if len(fk.columns) == 1 && fk.columns[0].text == recordRef.text && fk.target.text == referencesRef.text &&
			len(fk.references) == 1 && fk.references[0].text == key && actionOf(fk.onDelete) == ActionRestrict && actionOf(fk.onUpdate) == ActionRestrict {
			return
		}
	}
	v.add(RuleSetting, tablesRef, "tables table %q needs the foreign key (%s) references %s (%s) on delete restrict on update restrict", tablesRef.text, recordRef.text, referencesRef.text, key)
}

// auditRecord checks the audit record table. That table is another table of this document or of a used
// document, is not a history table, is not itself audited,
// has a primary key of one column, and its type is the audit column's type. The audit
// column is the only column of a declared foreign key that refers to that primary key with restrict.
// So the database rejects an audit column value that has no audit record row.
func (v *validator) auditRecord(t *tableNode, column *columnNode, columnRef, referencesRef, historyRef token) {
	if !v.ref(referencesRef) {
		return
	}
	record := v.table(referencesRef.text)
	switch {
	case record == nil:
		v.add(RuleSetting, referencesRef, "audit record table %q is not a table of this document or a used table", referencesRef.text)
		return
	case record.failed:
		return
	case record == t:
		v.add(RuleSetting, referencesRef, "a table cannot record its audits in itself")
		return
	case referencesRef.text == historyRef.text:
		v.add(RuleSetting, referencesRef, "the audit record table is another table than the history table")
		return
	}
	if record.settings != nil {
		for _, line := range record.settings.lines {
			if line.keyword.text == "audit" {
				v.add(RuleSetting, referencesRef, "audit record table %q is audited itself", referencesRef.text)
			}
		}
	}
	if len(record.primaryKeys) != 1 || len(record.primaryKeys[0].columns) != 1 {
		if !record.failedPK {
			v.add(RuleSetting, referencesRef, "audit record table %q needs a primary key of one column", referencesRef.text)
		}
		return
	}
	key := record.primaryKeys[0].columns[0].text
	pk := record.column(key)
	if column == nil || pk == nil {
		return
	}
	if pk.typ.valid && column.typ.valid && pk.typ.typ != column.typ.typ {
		v.add(RuleSetting, columnRef, "the audit column has type %s, not the type %s of the primary key of %q", column.typ.typ, pk.typ.typ, referencesRef.text)
		return
	}
	for _, fk := range t.foreignKeys {
		if len(fk.columns) == 1 && fk.columns[0].text == columnRef.text && fk.target.text == referencesRef.text &&
			len(fk.references) == 1 && fk.references[0].text == key && actionOf(fk.onDelete) == ActionRestrict && actionOf(fk.onUpdate) == ActionRestrict {
			return
		}
	}
	if !t.failedKey && !t.failedPK {
		v.add(RuleSetting, columnRef, "the audit column needs the foreign key (%s) references %s (%s) on delete restrict on update restrict", columnRef.text, referencesRef.text, key)
	}
}

// auditLists checks the audit's exclude or include lists, and returns a function that reports whether a column is recorded
// (docs/spec/dbspec.md "Audit"). If both lists are used, the second
// list's keyword is rejected and nil is returned. A column in a list belongs to the table,
// appears only once, and is not an audit column. Audit columns are always
// recorded, so they do not appear in either list.
func (v *validator) auditLists(t *tableNode, s *settingNode, columnRef token) func(string) bool {
	if len(s.lists) > 1 {
		v.add(RuleSetting, s.lists[1].keyword, "audit names its recorded columns by exclude or by include, not both")
		return nil
	}
	listed := map[string]bool{}
	for _, list := range s.lists {
		for _, ref := range list.columns {
			switch {
			case listed[ref.text]:
				v.add(RuleSetting, ref, "column %q repeats in audit %s", ref.text, list.keyword.text)
				continue
			case ref.text == columnRef.text:
				v.add(RuleSetting, ref, "the audit column %q is always recorded and is not listed in exclude or include", ref.text)
			default:
				v.columnRef(t, ref, RuleSetting)
			}
			listed[ref.text] = true
		}
	}
	audited := columnRef.text
	if len(s.lists) == 1 && s.lists[0].keyword.text == "include" {
		return func(column string) bool { return column == audited || listed[column] }
	}
	return func(column string) bool { return column == audited || !listed[column] }
}

// coordinate reads a diagram coordinate: an integer from -2147483648 to
// 2147483647.
func coordinate(t token) (int64, bool) {
	if t.kind != tokenNumber {
		return 0, false
	}
	for i := 0; i < len(t.text); i++ {
		if t.text[i] == '.' {
			return 0, false
		}
	}
	n, err := strconv.ParseInt(canonicalNumber(t.text), 10, 64)
	return n, err == nil && n >= math.MinInt32 && n <= math.MaxInt32
}

// machineLine returns the identity of the initial, terminal or transition line s of a state_machine and its
// description: a line of the same identity adds no meaning, and one with another require list contradicts it, so a
// repeat is a `setting` error (docs/spec/dbspec.md "Settings").
func machineLine(s *settingNode) (string, string) {
	switch s.form {
	case "initial", "terminal":
		return s.form + " " + s.args[1].text, s.form + " " + strconv.Quote(s.args[1].text)
	}
	return "transition " + s.args[1].text + " " + s.args[2].text, strconv.Quote(s.args[1].text) + " -> " + strconv.Quote(s.args[2].text)
}

// isCodecStage reports whether s is a codec stage of the codec setting.
func isCodecStage(s string) bool {
	_, ok := codecStages[s]
	return ok
}
