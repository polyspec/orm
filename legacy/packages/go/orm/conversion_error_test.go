package orm_test

import (
	"math"
	"testing"
	"time"

	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

func mustInt64(v any) int64 {
	n, err := orm.AsInt64(v)
	if err != nil {
		panic(err)
	}
	return n
}

// Requirements: INT-98a.
func TestDatabaseValueConversionRejectsInvalidValues(t *testing.T) {
	testcase.Start(t)
	for _, v := range []any{nil, "bad", "1.5", uint64(math.MaxUint64), math.Inf(1)} {
		if _, err := orm.AsInt64(v); err == nil {
			t.Errorf("AsInt64(%#v) accepted an invalid integer", v)
		}
	}
	for _, v := range []any{nil, "bad", "NaN", "Inf", math.Inf(1)} {
		if _, err := orm.AsFloat64(v); err == nil {
			t.Errorf("AsFloat64(%#v) accepted an invalid float", v)
		}
	}
	for _, v := range []any{nil, "perhaps", "2", int64(2)} {
		if _, err := orm.AsBool(v); err == nil {
			t.Errorf("AsBool(%#v) accepted an invalid boolean", v)
		}
	}
	for _, v := range []any{nil, "bad date", 123} {
		if _, err := orm.AsTime(v); err == nil {
			t.Errorf("AsTime(%#v) accepted an invalid time", v)
		}
	}
	for _, v := range []any{nil, []byte(nil), 123, time.Now()} {
		if _, err := orm.AsString(v); err == nil {
			t.Errorf("AsString(%#v) accepted an invalid string", v)
		}
		if _, err := orm.AsBytes(v); err == nil {
			t.Errorf("AsBytes(%#v) accepted invalid bytes", v)
		}
	}
	for _, v := range []any{nil, int64(40000), int64(-32769), "1.5"} {
		if _, err := orm.AsInt16(v); err == nil {
			t.Errorf("AsInt16(%#v) accepted an invalid i16", v)
		}
	}
	for _, c := range []struct {
		value     any
		precision int
	}{{"24:00:00", 0}, {"10:60:00", 0}, {"10:20:30.1234", 3}, {"10:20", 0}, {"10:20:30.", 2}, {nil, 0}, {int64(5), 0}} {
		if _, err := orm.AsTimeText(c.value, c.precision); err == nil {
			t.Errorf("AsTimeText(%#v, %d) accepted an invalid time", c.value, c.precision)
		}
	}
}

// A time(p) value is text with exactly p fractional digits.
// Requirements: INT-99.
func TestTimeTextHasExactlyPrecisionDigits(t *testing.T) {
	testcase.Start(t)
	for _, c := range []struct {
		value     any
		precision int
		want      string
	}{{"10:20:30", 0, "10:20:30"}, {"10:20:30.5", 3, "10:20:30.500"}, {[]byte("10:20:30.000000"), 2, "10:20:30.00"}, {"23:59:59.123456", 6, "23:59:59.123456"}} {
		if got, err := orm.AsTimeText(c.value, c.precision); err != nil || got != c.want {
			t.Errorf("AsTimeText(%#v, %d) = %q, %v; want %q", c.value, c.precision, got, err, c.want)
		}
	}
	if got, err := orm.AsInt16("-7"); err != nil || got != -7 {
		t.Errorf("AsInt16 = %d, %v", got, err)
	}
}

// Requirements: INT-99.
func TestDatabaseValueConversionPreservesValidValues(t *testing.T) {
	testcase.Start(t)
	if got, err := orm.AsInt64("42"); err != nil || got != 42 {
		t.Fatalf("integer: %d, %v", got, err)
	}
	if got, err := orm.AsFloat64("48.0450"); err != nil || math.Float64bits(got) != 0x404805c28f5c28f6 {
		t.Fatalf("decimal nearest binary64: %.17g, %v", got, err)
	}
	if got, err := orm.AsFloat64("9007199254740993"); err != nil || got != 9007199254740992 {
		t.Fatalf("large decimal nearest binary64: %.17g, %v", got, err)
	}
	if got, err := orm.AsBool("0"); err != nil || got {
		t.Fatalf("boolean zero: %t, %v", got, err)
	}
	if got, err := orm.AsTime("2024-01-02 03:04:05"); err != nil || got.IsZero() {
		t.Fatalf("time: %v, %v", got, err)
	}
	if got, err := orm.AsString([]byte("abc")); err != nil || got != "abc" {
		t.Fatalf("text: %q, %v", got, err)
	}
	if got, err := orm.AsBytes("abc"); err != nil || string(got) != "abc" {
		t.Fatalf("bytes: %q, %v", got, err)
	}
	if got, err := orm.AsBytes([]byte{}); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty bytes differ from SQL NULL: %q, %v", got, err)
	}
	if got, err := orm.AsTime(time.Time{}); err != nil || !got.IsZero() {
		t.Fatalf("explicit zero time: %v, %v", got, err)
	}
}
