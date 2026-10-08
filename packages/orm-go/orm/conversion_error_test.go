package orm_test

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

func TestAggregateNumericFixture(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "aggregate_numeric.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Feature string `json:"feature"`
		Cases   []struct {
			ID        string  `json:"id"`
			Operation string  `json:"operation"`
			InputType string  `json:"input_type"`
			Input     *string `json:"input"`
			Expected  struct {
				Bits  string `json:"bits"`
				Error string `json:"error"`
			} `json:"expected"`
		} `json:"cases"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Feature != "model_queries" || len(fixture.Cases) == 0 {
		t.Fatalf("invalid aggregate fixture: %q, %d cases", fixture.Feature, len(fixture.Cases))
	}
	seen := map[string]bool{}
	for _, tc := range fixture.Cases {
		if tc.ID == "" || seen[tc.ID] {
			t.Fatalf("empty or duplicate case ID %q", tc.ID)
		}
		seen[tc.ID] = true
		t.Run(tc.ID, func(t *testing.T) {
			if tc.Operation != "aggregate_numeric" {
				t.Fatalf("unexpected operation %q", tc.Operation)
			}
			var input any
			switch tc.InputType {
			case "decimal_text", "integer_text":
				if tc.Input == nil {
					t.Fatal("text input is null")
				}
				input = *tc.Input
			case "null":
				if tc.Input != nil {
					t.Fatal("null input has text")
				}
			default:
				t.Fatalf("unknown input type %q", tc.InputType)
			}
			got, err := orm.AsFloat64(input)
			if tc.Expected.Error != "" {
				if code := orm.ErrorCode(err); code != tc.Expected.Error {
					t.Fatalf("error code %q, want %q", code, tc.Expected.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want, err := strconv.ParseUint(tc.Expected.Bits, 16, 64)
			if err != nil {
				t.Fatal(err)
			}
			if bits := math.Float64bits(got); bits != want {
				t.Fatalf("bits %016x, want %016x", bits, want)
			}
		})
	}
}

func mustInt64(v any) int64 {
	n, err := orm.AsInt64(v)
	if err != nil {
		panic(err)
	}
	return n
}

func TestDatabaseValueConversionRejectsInvalidValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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

// time(p) 값은 소수 자릿수가 정확히 p인 text다.
func TestTimeTextHasExactlyPrecisionDigits(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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

func TestDatabaseValueConversionPreservesValidValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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
