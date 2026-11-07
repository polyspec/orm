package orm

import (
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

type groupValue struct {
	name  string
	value any
}

func validateGroupColumns(columns []plan.OutCol) error {
	seen := make(map[string]bool, len(columns))
	for _, column := range columns {
		if column.Hidden {
			continue
		}
		if seen[column.Name] {
			return configErr("group result repeats column %s", column.Name)
		}
		seen[column.Name] = true
	}
	if !seen["row_count"] {
		return codecErr(CodeInternal, "group result has no row_count")
	}
	return nil
}

// GroupRow contains one selected grouping result and its checked row count.
type GroupRow struct {
	values []groupValue
	count  int64
}

func newGroupRow(values []groupValue) (GroupRow, error) {
	seen := make(map[string]bool, len(values))
	var count int64
	countFound := false
	for index, item := range values {
		if seen[item.name] {
			return GroupRow{}, configErr("group result repeats column %s", item.name)
		}
		seen[item.name] = true
		if item.name == "row_count" {
			if _, ok := item.value.(bool); ok {
				return GroupRow{}, codecErr(CodeCodecDecode, "group result row_count is boolean")
			}
			if err := checkCountText(item.value); err != nil {
				return GroupRow{}, err
			}
			var err error
			count, err = AsInt64(item.value)
			if err != nil {
				return GroupRow{}, fmt.Errorf("group result row_count: %w", err)
			}
			if count < 0 {
				return GroupRow{}, codecErr(CodeCodecDecode, "group result row_count is negative")
			}
			if count > 9007199254740991 {
				return GroupRow{}, codecErr(CodeCodecDecode, "group result row_count is outside the exact integer range")
			}
			values[index].value = count
			countFound = true
		}
	}
	if !countFound {
		return GroupRow{}, codecErr(CodeInternal, "group result has no row_count")
	}
	return GroupRow{values: append([]groupValue(nil), values...), count: count}, nil
}

func (r GroupRow) Count() int64 { return r.count }

// Value returns a selected group value. A missing name fails; SQL NULL returns nil.
func (r GroupRow) Value(name string) (any, error) {
	for _, item := range r.values {
		if item.name == name {
			return item.value, nil
		}
	}
	return nil, ColumnUnselected(name)
}

func (r GroupRow) ToArray() map[string]any {
	out := make(map[string]any, len(r.values))
	for _, item := range r.values {
		out[item.name] = item.value
	}
	return out
}

// MarshalJSON writes the selected values as one JSON object in result order. JSON has no bytes, so a bytes value is
// CODEC_ENCODE (INT-162).
func (r GroupRow) MarshalJSON() ([]byte, error) {
	out := []byte{'{'}
	for index, item := range r.values {
		if _, ok := item.value.([]byte); ok {
			return nil, codecErr(CodeCodecEncode, "group column %s: JSON output cannot write bytes", item.name)
		}
		name, err := json.Marshal(item.name)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(item.value)
		if err != nil {
			return nil, err
		}
		if index > 0 {
			out = append(out, ',')
		}
		out = append(append(append(out, name...), ':'), value...)
	}
	return append(out, '}'), nil
}

// checkCountText refuses a driver cell of text that is not the canonical decimal of a nonnegative integer (INT-90).
func checkCountText(value any) error {
	var text string
	switch cell := value.(type) {
	case string:
		text = cell
	case []byte:
		text = string(cell)
	default:
		return nil
	}
	valid := text != "" && (text == "0" || text[0] != '0')
	for _, digit := range text {
		valid = valid && digit >= '0' && digit <= '9'
	}
	if !valid {
		return codecErr(CodeCodecDecode, "group result row_count is not an exact integer")
	}
	return nil
}

// GroupRows contains grouped values without constructing partial models.
type GroupRows struct{ rows []GroupRow }

func (r *GroupRows) Len() int { return len(r.rows) }

func (r *GroupRows) ToArray() []map[string]any {
	out := make([]map[string]any, 0, len(r.rows))
	for _, row := range r.rows {
		out = append(out, row.ToArray())
	}
	return out
}

// MarshalJSON writes the rows as a JSON array in result order. It calls each row itself, so the error of a row is the
// orm error that the one MarshalerError of the caller holds (INT-162).
func (r *GroupRows) MarshalJSON() ([]byte, error) {
	out := []byte{'['}
	for index, row := range r.rows {
		text, err := row.MarshalJSON()
		if err != nil {
			return nil, err
		}
		if index > 0 {
			out = append(out, ',')
		}
		out = append(out, text...)
	}
	return append(out, ']'), nil
}

// All visits grouped rows in result order.
func (r *GroupRows) All() func(yield func(GroupRow) bool) {
	return func(yield func(GroupRow) bool) {
		for _, row := range r.rows {
			if !yield(row) {
				return
			}
		}
	}
}

func groupColumnValue(c *Core, db *DB, column plan.OutCol, declared *runtimemodel.Field, raw any) (any, error) {
	if raw == nil {
		if declared != nil && !declared.Null {
			return nil, codecErr(CodeCodecDecode, "group column %s is SQL NULL", column.Name)
		}
		return nil, nil
	}
	if declared != nil && declared.Styled() {
		return AsStyledValue(raw, declared.Null)
	}
	if column.Name == "row_count" {
		if _, ok := raw.(bool); ok {
			return nil, codecErr(CodeCodecDecode, "group result row_count is boolean")
		}
	}
	if column.Column == "" && column.Name != "row_count" {
		return raw, nil
	}
	switch column.Type {
	case "i64":
		return AsInt64(raw)
	case "i32":
		return AsInt32(raw)
	case "i16":
		return AsInt16(raw)
	case "bool":
		return AsBool(raw)
	case "f64":
		return AsFloat64(raw)
	case "decimal":
		if declared == nil {
			return nil, codecErr(CodeInternal, "decimal group column %s has no declaration", column.Name)
		}
		return c.DecodeDecimal(raw, declared.Precision, declared.Scale)
	case "datetime", "date":
		value := db.localTime(raw)
		if t, ok := value.(time.Time); ok {
			return t, nil
		}
		return AsTime(value)
	case "time":
		if declared == nil {
			return nil, codecErr(CodeInternal, "time group column %s has no declaration", column.Name)
		}
		return AsTimeText(raw, declared.Precision)
	case "varchar", "text", "uuid":
		return AsString(raw)
	case "bytes":
		if declared != nil && len(declared.Codec) > 0 {
			return AsString(raw)
		}
		return AsBytes(raw)
	default:
		return nil, codecErr(CodeInternal, "group column %s has unsupported type %s", column.Name, column.Type)
	}
}

// addedColumnValue decodes an added column by the type its plan column states (INT-160). Other types keep the driver value.
func addedColumnValue(typ string, raw any) (any, error) {
	if raw == nil {
		return nil, nil
	}
	switch typ {
	case "i64":
		if err := exactIntegerText(raw); err != nil {
			return nil, err
		}
		return AsInt64(raw)
	case "i32":
		if err := exactIntegerText(raw); err != nil {
			return nil, err
		}
		return AsInt32(raw)
	case "i16":
		if err := exactIntegerText(raw); err != nil {
			return nil, err
		}
		return AsInt16(raw)
	case "bool":
		return AsBool(raw)
	case "f64":
		return AsFloat64(raw)
	case "date", "datetime":
		return AsTime(raw)
	default:
		return raw, nil
	}
}

// exactIntegerPattern is the text of an integer: its digits, no sign but a minus and no leading zero.
var exactIntegerPattern = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)$`)

// exactIntegerText refuses a text cell that is not exactly the digits of an integer (INT-160), which ParseInt would read.
func exactIntegerText(raw any) error {
	var text string
	switch x := raw.(type) {
	case string:
		text = x
	case []byte:
		text = string(x)
	default:
		return nil
	}
	if !exactIntegerPattern.MatchString(text) {
		return codecErr(CodeCodecDecode, "the text %q is not exactly an integer", text)
	}
	return nil
}
