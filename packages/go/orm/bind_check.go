package orm

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
)

// paramSlot is the logical type of a slot that a parameter fills: a dbspec type kind with the
// precision of a decimal, time or datetime, the scale of a decimal and the length of a varchar
// (docs/spec/protocol.md §5 "Parameters").
type paramSlot struct {
	Type                     string
	Precision, Scale, Length int
	// NotNull marks the assignment of the non-null column Column.
	NotNull bool
	Column  string
}

// bindSlotType is the logical type of a param bind slot of a plan step.
func bindSlotType(b *plan.BindSlot) paramSlot {
	return paramSlot{Type: b.ColType, Precision: b.Precision, Scale: b.Scale, Length: b.Length, NotNull: b.NotNull, Column: b.Column}
}

// useSlotType is the logical type of a parameter use of ir.ParamUses: a use of its column's
// type takes the column's precision, scale and length; a datetime or time of a function takes
// six digits.
func useSlotType(u ir.ParamUse) paramSlot {
	if f := u.Column; f != nil && f.Type == u.Type {
		return paramSlot{Type: u.Type, Precision: f.Precision, Scale: f.Scale, Length: f.Length, NotNull: u.Assign && !f.Null, Column: f.Name}
	}
	s := paramSlot{Type: u.Type}
	if u.Type == "datetime" || u.Type == "time" {
		s.Precision = 6
	}
	return s
}

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// integerRanges are the ranges of the integer types.
var integerRanges = map[string][2]int64{
	"i16": {math.MinInt16, math.MaxInt16},
	"i32": {math.MinInt32, math.MaxInt32},
	"i64": {math.MinInt64, math.MaxInt64},
}

// checkParam checks the value v of parameter i against the logical type s of a slot it fills,
// before any statement: the host value kind, the range of an integer, a finite f64, the
// precision and scale of a decimal, a date from 0001-01-01 to 9999-12-31, no non-zero digit
// of a time or datetime past its precision, at most n characters of a varchar(n), no U+0000
// in text and a lower-case canonical uuid. A value outside it is CODEC_ENCODE; SQL NULL is
// accepted.
func (d *DB) checkParam(i int, v any, s paramSlot) error {
	if v == nil {
		return nil
	}
	if _, ok := v.(NullType); ok {
		return nil
	}
	kind := func() error {
		return codecErr(CodeCodecEncode, "parameter %d (%T) is not a %s value", i, v, s.Type)
	}
	switch s.Type {
	case "i16", "i32", "i64":
		n, ok, err := integerValue(v)
		if !ok {
			return kind()
		}
		if r := integerRanges[s.Type]; err != nil || n < r[0] || n > r[1] {
			return codecErr(CodeCodecEncode, "parameter %d (%v) is outside %s", i, v, s.Type)
		}
	case "f64":
		var f float64
		switch x := v.(type) {
		case float64:
			f = x
		case float32:
			f = float64(x)
		case uint:
			// An unsigned value past the int64 range is still a finite f64.
			f = float64(x)
		case uint64:
			f = float64(x)
		default:
			_, ok, err := integerValue(v)
			if !ok {
				return kind()
			}
			if err != nil {
				return codecErr(CodeCodecEncode, "parameter %d (%v): %v", i, v, err)
			}
		}
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return codecErr(CodeCodecEncode, "parameter %d (%v) is not a finite f64", i, v)
		}
	case "bool":
		if _, ok := v.(bool); !ok {
			return kind()
		}
	case "decimal":
		text, ok := v.(string)
		if !ok {
			return kind()
		}
		if _, err := NormalizeDecimal(text, s.Precision, s.Scale); err != nil {
			return codecErr(CodeCodecEncode, "parameter %d: %v", i, err)
		}
	case "varchar", "text", "uuid":
		text, ok := v.(string)
		if !ok || !utf8.ValidString(text) {
			return kind()
		}
		if strings.ContainsRune(text, 0) {
			return codecErr(CodeCodecEncode, "parameter %d holds U+0000, which no %s value holds", i, s.Type)
		}
		if n := utf8.RuneCountInString(text); s.Type == "varchar" && s.Length > 0 && n > s.Length {
			return codecErr(CodeCodecEncode, "parameter %d has %d characters, more than varchar(%d)", i, n, s.Length)
		}
		if s.Type == "uuid" && !canonicalUUID.MatchString(text) {
			return codecErr(CodeCodecEncode, "parameter %d (%q) is not a lower-case canonical uuid", i, text)
		}
	case "bytes":
		switch v.(type) {
		case []byte, string:
		default:
			return kind()
		}
	case "date", "time", "datetime":
		if _, ok := v.(string); !ok {
			return kind()
		}
		out, err := d.bindTimeValue(v, s.Type, s.Precision)
		if err != nil {
			return codecErr(CodeCodecEncode, "parameter %d: %v", i, err)
		}
		text, ok := out.(string)
		if !ok {
			return codecErr(CodeCodecEncode, "parameter %d: the time value is %T, not text", i, out)
		}
		if s.Type != "time" && (len(text) < 5 || text[4] != '-' || text[:4] == "0000" || text[0] == '-') {
			return codecErr(CodeCodecEncode, "parameter %d (%v) is outside 0001-01-01 to 9999-12-31", i, v)
		}
	}
	return nil
}

// checkAssign refuses SQL NULL as parameter i when s assigns a non-null column. It runs for
// every slot, a host-styled or transformed one too, before any statement.
func checkAssign(i int, v any, s paramSlot) error {
	if _, null := v.(NullType); (v == nil || null) && s.NotNull {
		return codecErr(CodeCodecEncode, "parameter %d assigns NULL to the non-null %s", i, s.Column)
	}
	return nil
}

// integerValue reads an integer host value. ok is false for another kind; err is set for an
// unsigned value past the int64 range.
func integerValue(v any) (n int64, ok bool, err error) {
	switch x := v.(type) {
	case int:
		return int64(x), true, nil
	case int8:
		return int64(x), true, nil
	case int16:
		return int64(x), true, nil
	case int32:
		return int64(x), true, nil
	case int64:
		return x, true, nil
	case uint:
		return uintValue(uint64(x))
	case uint8:
		return int64(x), true, nil
	case uint16:
		return int64(x), true, nil
	case uint32:
		return int64(x), true, nil
	case uint64:
		return uintValue(x)
	}
	return 0, false, nil
}

func uintValue(x uint64) (int64, bool, error) {
	if x > math.MaxInt64 {
		return 0, true, fmt.Errorf("%d is past int64", x)
	}
	return int64(x), true, nil
}
