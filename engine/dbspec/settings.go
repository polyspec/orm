package dbspec

import (
	"math"
	"strconv"
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
	repeatable := map[string]map[string]bool{"codec": {}, "navigation": {}, "blind_index": {}}
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
		} else {
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
	if aesVersion := byKind["aes_version"]; aesVersion == nil {
		for _, s := range aesCodecs {
			v.add(RuleSetting, s.keyword, "a column with the aes stage requires an aes_version setting")
		}
	} else if len(aesCodecs) == 0 {
		v.add(RuleSetting, aesVersion.keyword, "aes_version without a column that uses aes")
	}
	if s := byKind["audit"]; s != nil && byKind["soft_delete"] == nil {
		v.add(RuleSetting, s.keyword, "an audited table requires a soft_delete setting")
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
		if v.ref(s.args[0]) && !t.failedName(s.args[0].text) {
			found := false
			for _, f := range t.foreignKeys {
				found = found || f.name.text == s.args[0].text
			}
			if !found {
				v.add(RuleSetting, s.args[0], "foreign key %q is not a foreign key of the table", s.args[0].text)
			}
		}
	case "immutable":
		if v.propagatedChild(t) {
			v.add(RuleSetting, s.keyword, "immutable is rejected on a child of a cascade or set_null foreign key")
		}
	case "audit":
		v.audit(t, s)
	}
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

// audit checks `audit into <history> operation <c> action <c> previous <c>`
// and the shape of the history table (docs/dbspec.md "Audit").
func (v *validator) audit(t *tableNode, s *settingNode) {
	historyRef, operationRef, actionRef, previousRef := s.args[0], s.args[1], s.args[2], s.args[3]
	if v.propagatedChild(t) {
		v.add(RuleSetting, s.keyword, "audit is rejected on a child of a cascade or set_null foreign key")
	}
	operation := v.columnRef(t, operationRef, RuleSetting)
	if operation != nil && (operation.null != nil || (operation.typ.valid && operation.typ.typ.Kind != TypeI64 && operation.typ.typ.Kind != TypeUUID)) {
		v.add(RuleSetting, operationRef, "the operation column is a non-null i64 or uuid column")
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
		case operation != nil && previous.typ.valid && operation.typ.valid && previous.typ.typ != operation.typ.typ:
			v.add(RuleSetting, previousRef, "the previous column has the operation column type %s, not %s", operation.typ.typ, previous.typ.typ)
		}
		reserved[previousRef.text] = true
	}
	for _, c := range t.columns {
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
		if !reserved[h.name.text] && t.column(h.name.text) == nil && !t.failedName(h.name.text) {
			v.add(RuleSetting, historyRef, "history table %q has column %q, which is not a column of table %q", historyRef.text, h.name.text, t.name.text)
		}
	}
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
