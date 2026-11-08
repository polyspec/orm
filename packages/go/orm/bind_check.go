package orm

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"

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

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// integerRanges are the ranges of the integer types.
var integerRanges = map[string][2]int64{
	"i16": {math.MinInt16, math.MaxInt16},
	"i32": {math.MinInt32, math.MaxInt32},
	"i64": {math.MinInt64, math.MaxInt64},
}

// finiteF64 refuses the non-finite f64 f of parameter i with CODEC_ENCODE; the text names no value (PRT-32a).
func finiteF64(i int, f float64) error {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return codecErr(CodeCodecEncode, "parameter %d is not a finite f64", i)
	}
	return nil
}

// checkParam checks the value v of parameter i against the logical type s of a slot it fills,
// before any statement: the host value kind, the range of an integer, a finite f64, the
// precision and scale of a decimal, a date from 0001-01-01 to 9999-12-31, no non-zero digit
// of a time or datetime past its precision, at most n characters of a varchar(n), no U+0000
// in text and a lower-case canonical uuid. A value outside it is CODEC_ENCODE with the text of PRT-32a,
// which names no value; SQL NULL is accepted.
func (d *DB) checkParam(i int, v any, s paramSlot) error {
	if v == nil {
		return nil
	}
	if _, ok := v.(NullType); ok {
		return nil
	}
	kind := func() error {
		return codecErr(CodeCodecEncode, "parameter %d is not a %s value", i, s.Type)
	}
	switch s.Type {
	case "i16", "i32", "i64":
		n, ok, err := integerValue(v)
		if !ok {
			return kind()
		}
		if r := integerRanges[s.Type]; err != nil || n < r[0] || n > r[1] {
			return codecErr(CodeCodecEncode, "parameter %d is outside %s", i, s.Type)
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
				return kind()
			}
		}
		if err := finiteF64(i, f); err != nil {
			return err
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
			return refused(err, codecErr(CodeCodecEncode, "parameter %d is not a decimal of its precision and scale", i))
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
			return codecErr(CodeCodecEncode, "parameter %d is longer than varchar(%d)", i, s.Length)
		}
		if s.Type == "uuid" && !canonicalUUID.MatchString(text) {
			return codecErr(CodeCodecEncode, "parameter %d is not a lower-case canonical uuid", i)
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
			return refused(err, kind())
		}
		text, ok := out.(string)
		if !ok {
			return kind()
		}
		if s.Type != "time" && (len(text) < 5 || text[4] != '-' || text[:4] == "0000" || text[0] == '-') {
			return codecErr(CodeCodecEncode, "parameter %d is outside 0001-01-01 to 9999-12-31", i)
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

// refused is the PRT-32a refusal text in place of the CODEC_ENCODE err that refused a parameter value; any other error is
// returned as it is, so it stays its own error.
func refused(err, text error) error {
	if ErrorCode(err) == CodeCodecEncode {
		return text
	}
	return err
}
