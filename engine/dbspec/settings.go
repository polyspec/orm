package dbspec

import (
	"maps"
	"math"
	"slices"
	"strconv"
	"unicode/utf8"
)

// codecStages maps each codec stage to the storage it produces
// (docs/dbspec.md "Settings"): true for bytes, false for text.
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
			// state_machine과 checkbox는 여러 줄로 쓰므로 once 검사에서 뺀다.
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
		v.generatedName(s.keyword, t.name.text+"$immutable_update")
	case "audit":
		v.audit(t, s)
		v.generatedName(s.keyword, t.name.text+"$audit_insert")
	case "state_machine":
		v.stateMachine(t, s)
	case "markdown":
		if c := v.columnRef(t, s.args[0], RuleSetting); c != nil && c.typ.valid &&
			c.typ.typ.Kind != TypeVarchar && c.typ.typ.Kind != TypeText {
			v.add(RuleSetting, s.args[0], "markdown needs a varchar or text column, not %s", c.typ.typ)
		}
	}
}

// foreignKeyName은 이름이 table의 foreign key를 가리키는지 검사한다.
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
// columns of the table (docs/dbspec.md "Settings").
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

// stateMachineConsistency는 기계의 줄들을 줄 사이에서 검사한다: table마다 column 하나,
// initial, 전환과 terminal 줄의 상호 일치, history와 limit 줄, state column의 default,
// checkbox 줄이다 (docs/dbspec.md "Settings").
func (v *validator) stateMachineConsistency(t *tableNode) {
	column := ""
	states := map[string]bool{}
	initials := map[string]bool{}
	terminals := map[string]bool{}
	var lines, limits []*settingNode
	var history *settingNode
	var requires []token
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

// limits는 limit 줄마다 검사한다: state는 state 집합에 속하고, state마다 반복하지 않으며, count는 양의 정수다.
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

// history는 state_machine history 줄의 history table을 검사한다. 그 column은
// 이 table을 가리키는 foreign key, state column의 type을 가진 from과 to column,
// datetime(6)의 at column, 필요한 column마다 같은 type의 nullable column 하나, key이며,
// title이나 body를 선언하지 않는다. 불일치는 모두 history table의 이름에 보고한다.
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

// checkboxes는 checkbox 줄을 기계의 state 집합에 대해 검사한다: 기계의 column을 이름 붙이고, 집합의 state마다 한 글자이며 서로 다른 glyph를 가진 줄이 하나씩 있고, 어떤 줄도 다른 state를 이름 붙이지 않는다.
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

// store는 block 저장을 검사한다: 그 foreign key는 table의 foreign key여야 한다. kind와 shape는 parser가 읽는다.
func (v *validator) store(t *tableNode, s *settingNode) {
	if s.args[0].text == "block" {
		v.foreignKeyName(t, s.args[1])
	}
}

// keyPrefix는 primary key가 varchar column 하나인지 검사한다.
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

// textColumn은 title과 body column을 검사한다: 각각 non-null varchar 또는 text column이다.
func (v *validator) textColumn(t *tableNode, s *settingNode) {
	c := v.columnRef(t, s.args[0], RuleSetting)
	if c != nil && ((c.typ.valid && c.typ.typ.Kind != TypeVarchar && c.typ.typ.Kind != TypeText) || c.null != nil) {
		v.add(RuleSetting, s.args[0], "%s needs a non-null varchar or text column", s.keyword.text)
	}
}

// order는 order column을 검사한다: default가 없고 어떤 key, index 또는 check에도 없는 non-null i32 또는 i64 column이다.
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

// inKeyOrCheck는 t의 primary key, unique key, index, foreign key 또는 check가 그 column을 이름 붙이는지 보고한다.
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
// exactly the recorded columns (docs/dbspec.md "Audit").
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
	// 두 목록을 다 쓴 setting은 기록하는 column이 정해지지 않으므로 history
	// table의 column을 맞추어 보지 않는다.
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

// auditRecord는 audit 기록 table을 검사한다. 그 table은 이 문서나 사용한
// 문서의 다른 table이며 history table이 아니고, 자신은 audit 대상이 아니며,
// column 하나의 primary key를 가지고 그 type이 audit column의 type이다. audit
// column은 그 primary key를 restrict로 가리키는 선언한 foreign key의 유일한
// column이다. 그래서 audit 기록 행이 없는 audit column 값은 database가 거부한다.
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

// auditLists는 audit의 exclude나 include 목록을 검사하고, column이 기록되는지
// 알리는 함수를 돌려준다(docs/dbspec.md "Audit"). 두 목록을 다 쓰면 둘째
// 목록의 keyword에서 거부하고 nil을 돌려준다. 목록의 column은 table의
// column이고, 한 번만 나오며, audit column이 아니다. audit column은 언제나
// 기록하므로 어느 목록에도 쓰지 않는다.
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
