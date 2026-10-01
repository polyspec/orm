package dbspec

import "strconv"

// codecStages are the stages a codec setting may list (docs/codec.md).
var codecStages = map[string]bool{
	"ordered_json": true, "aes": true, "hex": true, "gz": true,
	"base64": true, "serialize": true, "yaml": true, "ip": true,
}

func isInteger(t Type) bool {
	return t.Kind == TypeI16 || t.Kind == TypeI32 || t.Kind == TypeI64
}

// settings checks the settings block of t: repeats, unknown columns, column
// types and companion settings.
func (v *validator) settings(t *tableNode) {
	once := map[string]bool{}
	codecColumns := map[string]bool{}
	navigations := map[string]bool{}
	byKind := map[string]*settingNode{}
	var aesStages []token
	aesColumns := map[string]bool{}
	for _, s := range t.settings.lines {
		kind := s.keyword.text
		switch kind {
		case "codec":
			if codecColumns[s.args[0].text] {
				v.add(RuleSetting, s.keyword, "column %q has more than one codec setting", s.args[0].text)
				continue
			}
			codecColumns[s.args[0].text] = true
		case "navigation":
			if navigations[s.args[0].text] {
				v.add(RuleSetting, s.keyword, "foreign key %q has more than one navigation setting", s.args[0].text)
				continue
			}
			navigations[s.args[0].text] = true
		default:
			if once[kind] {
				v.add(RuleSetting, s.keyword, "setting %s repeats", kind)
				continue
			}
			once[kind] = true
			byKind[kind] = s
		}
		v.setting(t, s)
		if kind == "codec" {
			for _, stage := range s.args[1:] {
				if stage.text == "aes" {
					aesStages = append(aesStages, stage)
					aesColumns[s.args[0].text] = true
					break
				}
			}
		}
	}
	if byKind["aes_version"] == nil {
		for _, stage := range aesStages {
			v.add(RuleSetting, stage, "a column with the aes stage requires an aes_version setting")
		}
	}
	if s := byKind["blind_index"]; s != nil && t.column(s.args[0].text) != nil && !aesColumns[s.args[0].text] {
		v.add(RuleSetting, s.args[0], "blind_index names column %q, which has no codec with the aes stage", s.args[0].text)
	}
	if s := byKind["audit"]; s != nil && byKind["soft_delete"] == nil {
		v.add(RuleSetting, s.keyword, "an audited table requires a soft_delete setting")
	}
}

// column returns the named column of t, or reports a setting error at ref.
func (v *validator) settingColumn(t *tableNode, ref token) *columnNode {
	c := t.column(ref.text)
	if c == nil {
		v.add(RuleSetting, ref, "column %q is not a column of the table", ref.text)
	}
	return c
}

func (v *validator) propagatedChild(t *tableNode) bool {
	for _, f := range t.foreignKeys {
		if f.propagates() {
			return true
		}
	}
	return false
}

func (v *validator) setting(t *tableNode, s *settingNode) {
	switch s.keyword.text {
	case "entity":
		v.name(s.args[0])
	case "updated":
		if c := v.settingColumn(t, s.args[0]); c != nil && c.typ.valid && c.typ.typ.Kind != TypeDatetime {
			v.add(RuleSetting, s.args[0], "updated needs a datetime column, not %s", c.typ.typ)
		}
	case "soft_delete":
		if c := v.settingColumn(t, s.args[0]); c != nil && ((c.typ.valid && c.typ.typ.Kind != TypeDatetime) || c.null == nil) {
			v.add(RuleSetting, s.args[0], "soft_delete needs a nullable datetime column")
		}
	case "aes_version":
		if c := v.settingColumn(t, s.args[0]); c != nil && ((c.typ.valid && !isInteger(c.typ.typ)) || c.null != nil) {
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
			v.settingColumn(t, ref)
		}
	case "codec":
		if c := v.settingColumn(t, s.args[0]); c != nil && c.typ.valid {
			switch c.typ.typ.Kind {
			case TypeVarchar, TypeText, TypeBytes:
			default:
				v.add(RuleSetting, s.args[0], "codec needs a varchar, text or bytes column, not %s", c.typ.typ)
			}
		}
		for _, stage := range s.args[1:] {
			if !codecStages[stage.text] {
				v.add(RuleSetting, stage, "codec stage %q is unknown", stage.text)
			}
		}
	case "blind_index":
		v.settingColumn(t, s.args[0])
		index := s.args[1]
		if c := v.settingColumn(t, index); c != nil {
			if index.text == s.args[0].text {
				v.add(RuleSetting, index, "the blind index column differs from the AES column")
			} else if !v.leadingIndex(t, []string{index.text}) {
				v.add(RuleSetting, index, "column %q is not the leading column of an index or key", index.text)
			}
		}
	case "navigation":
		found := false
		for _, f := range t.foreignKeys {
			found = found || f.name.text == s.args[0].text
		}
		if !found {
			v.add(RuleSetting, s.args[0], "foreign key %q is not a foreign key of the table", s.args[0].text)
		}
		v.name(s.args[1])
		v.name(s.args[2])
	case "immutable":
		if v.propagatedChild(t) {
			v.add(RuleSetting, s.keyword, "immutable is rejected on a child of a cascade or set_null foreign key")
		}
	case "audit":
		v.audit(t, s)
	}
}

// audit checks `audit into <history> operation <c> action <c> previous <c>`
// and the shape of the history table (docs/dbspec.md "Audit").
func (v *validator) audit(t *tableNode, s *settingNode) {
	historyRef, operationRef, actionRef, previousRef := s.args[0], s.args[1], s.args[2], s.args[3]
	if v.propagatedChild(t) {
		v.add(RuleSetting, s.keyword, "audit is rejected on a child of a cascade or set_null foreign key")
	}
	operation := v.settingColumn(t, operationRef)
	if operation != nil && (operation.null != nil || (operation.typ.valid && operation.typ.typ.Kind != TypeI64 && operation.typ.typ.Kind != TypeUUID)) {
		v.add(RuleSetting, operationRef, "the operation column is a non-null i64 or uuid column")
	}
	history := v.table(historyRef.text)
	switch {
	case history == nil:
		v.add(RuleSetting, historyRef, "history table %q is not a table of this document or a used table", historyRef.text)
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
	if identity == nil {
		v.add(RuleSetting, historyRef, "history table %q needs an i64 identity primary key", historyRef.text)
	}
	reserved := map[string]bool{}
	if identity != nil {
		reserved[identity.name.text] = true
	}
	action := history.column(actionRef.text)
	switch {
	case action == nil:
		v.add(RuleSetting, actionRef, "column %q is not a column of history table %q", actionRef.text, historyRef.text)
	case reserved[actionRef.text]:
		v.add(RuleSetting, actionRef, "the action column is a separate column of the history table")
	case action.typ.valid && action.typ.typ != (Type{Kind: TypeVarchar, Length: 8}):
		v.add(RuleSetting, actionRef, "the action column has type varchar(8), not %s", action.typ.typ)
	}
	reserved[actionRef.text] = true
	previous := history.column(previousRef.text)
	switch {
	case previous == nil:
		v.add(RuleSetting, previousRef, "column %q is not a column of history table %q", previousRef.text, historyRef.text)
	case reserved[previousRef.text]:
		v.add(RuleSetting, previousRef, "the previous column is a separate column of the history table")
	case previous.null == nil:
		v.add(RuleSetting, previousRef, "the previous column is nullable")
	case operation != nil && previous.typ.valid && operation.typ.valid && previous.typ.typ != operation.typ.typ:
		v.add(RuleSetting, previousRef, "the previous column has the operation column type %s, not %s", operation.typ.typ, previous.typ.typ)
	}
	reserved[previousRef.text] = true
	for _, c := range t.columns {
		h := history.column(c.name.text)
		switch {
		case h == nil || reserved[c.name.text]:
			v.add(RuleSetting, historyRef, "history table %q has no copy of column %q", historyRef.text, c.name.text)
		case h.typ.valid && c.typ.valid && h.typ.typ != c.typ.typ:
			v.add(RuleSetting, historyRef, "history column %q has type %s, not %s", c.name.text, h.typ.typ, c.typ.typ)
		}
	}
	for _, h := range history.columns {
		if !reserved[h.name.text] && t.column(h.name.text) == nil {
			v.add(RuleSetting, historyRef, "history table %q has column %q, which is not a column of table %q", historyRef.text, h.name.text, t.name.text)
		}
	}
}

// coordinate reads a diagram coordinate: an integer that fits 64 bits.
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
	return n, err == nil
}
