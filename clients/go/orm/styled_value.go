package orm

import "encoding/json"

// StyledValue distinguishes a SQL NULL cell from a stored value, including an
// encoded null value. The zero value is invalid and represents no selection.
type StyledValue struct {
	kind  uint8
	value any
}

// SqlNull constructs a SQL NULL styled value.
func SqlNull() StyledValue { return StyledValue{kind: 1} }

// Value constructs a stored styled value. A nil value is encoded by its style.
func Value(v any) StyledValue { return StyledValue{kind: 2, value: v} }

// Kind returns the public state name.
func (v StyledValue) Kind() string {
	switch v.kind {
	case 1:
		return "sql-null"
	case 2:
		return "value"
	default:
		return ""
	}
}

// Data returns the stored value and whether this is the value variant.
func (v StyledValue) Data() (any, bool) { return v.value, v.kind == 2 }

// AsStyledValue validates a decoded value before generated field assignment.
func AsStyledValue(raw any, nullable bool) (StyledValue, error) {
	v, ok := raw.(StyledValue)
	if !ok || v.kind == 0 {
		return StyledValue{}, codecErr(CodeCodecDecode, "expected a selected StyledValue, got %T", raw)
	}
	if v.kind == 1 && !nullable {
		return StyledValue{}, codecErr(CodeCodecDecode, "SQL NULL is not allowed for this column")
	}
	return v, nil
}

// ColumnUnselected reports an explicit request for a column absent from a row.
func ColumnUnselected(name string) error {
	return codecErr(CodeColumnUnselected, "column %s was not selected", name)
}

// MarshalJSON writes the tagged styled value.
func (v StyledValue) MarshalJSON() ([]byte, error) {
	switch v.kind {
	case 1:
		return []byte(`{"kind":"sql-null"}`), nil
	case 2:
		data, err := json.Marshal(v.value)
		if err != nil {
			return nil, codecErr(CodeCodecEncode, "styled value: %v", err)
		}
		out := append([]byte(`{"kind":"value","value":`), data...)
		return append(out, '}'), nil
	default:
		return nil, codecErr(CodeColumnUnselected, "styled value was not selected")
	}
}
