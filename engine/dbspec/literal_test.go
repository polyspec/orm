package dbspec

import (
	"fmt"
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
)

// TestCanonicalLiteral checks CanonicalLiteral for every type with the
// literal forms of TestCanonicalForms and the invalid literals of
// TestRuleDiagnostics. A text or bytes column has no literal.
func TestCanonicalLiteral(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	cases := []struct {
		id   string
		typ  Type
		text string
		want string
		ok   bool
	}{
		// i16, i32, i64
		{"i16-negative-zero", Type{Kind: TypeI16}, "-0", "0", true},
		{"i16-leading-zeros", Type{Kind: TypeI16}, "007", "7", true},
		{"i16-max", Type{Kind: TypeI16}, "32767", "32767", true},
		{"i16-out-of-range", Type{Kind: TypeI16}, "32768", "", false},
		{"i16-fraction", Type{Kind: TypeI16}, "1.5", "", false},
		{"i16-string", Type{Kind: TypeI16}, "'1'", "", false},
		{"i16-now", Type{Kind: TypeI16}, "now", "", false},
		{"i32-min", Type{Kind: TypeI32}, "-2147483648", "-2147483648", true},
		{"i32-out-of-range", Type{Kind: TypeI32}, "-2147483649", "", false},
		{"i64-min", Type{Kind: TypeI64}, "-9223372036854775808", "-9223372036854775808", true},
		{"i64-out-of-range", Type{Kind: TypeI64}, "9223372036854775808", "", false},
		{"i64-word", Type{Kind: TypeI64}, "one", "", false},

		// bool
		{"bool-false", Type{Kind: TypeBool}, "false", "false", true},
		{"bool-true", Type{Kind: TypeBool}, "true", "true", true},
		{"bool-number", Type{Kind: TypeBool}, "1", "", false},
		{"bool-upper-case", Type{Kind: TypeBool}, "TRUE", "", false},

		// decimal
		{"decimal-negative-fraction", Type{Kind: TypeDecimal, Precision: 5, Scale: 2}, "-0.5", "-0.50", true},
		{"decimal-leading-zeros-scale-zero", Type{Kind: TypeDecimal, Precision: 4, Scale: 0}, "0012", "12", true},
		{"decimal-integer-digits-overflow", Type{Kind: TypeDecimal, Precision: 3, Scale: 1}, "100", "", false},
		{"decimal-fraction-digits-overflow", Type{Kind: TypeDecimal, Precision: 3, Scale: 1}, "1.25", "", false},
		{"decimal-extra-zero-digits", Type{Kind: TypeDecimal, Precision: 4, Scale: 0}, "12.0", "", false},
		{"decimal-string", Type{Kind: TypeDecimal, Precision: 4, Scale: 0}, "'12'", "", false},

		// f64
		{"f64-fraction", Type{Kind: TypeF64}, "0001.2500", "1.25", true},
		{"f64-negative-zero", Type{Kind: TypeF64}, "-0.0", "0", true},
		{"f64-string", Type{Kind: TypeF64}, "'1'", "", false},

		// varchar, uuid, date, time, datetime
		{"varchar-escaped-quote", Type{Kind: TypeVarchar, Length: 8}, "'it''s'", "'it''s'", true},
		{"varchar-too-long", Type{Kind: TypeVarchar, Length: 2}, "'abc'", "", false},
		{"varchar-number", Type{Kind: TypeVarchar, Length: 8}, "1", "", false},
		{"uuid-lower-case", Type{Kind: TypeUUID}, "'0E2B5D7A-0000-4000-8000-00000000000A'", "'0e2b5d7a-0000-4000-8000-00000000000a'", true},
		{"uuid-invalid", Type{Kind: TypeUUID}, "'x'", "", false},
		{"date-minimum", Type{Kind: TypeDate}, "'0001-01-01'", "'0001-01-01'", true},
		{"date-february-30", Type{Kind: TypeDate}, "'2026-02-30'", "", false},
		{"time-fraction", Type{Kind: TypeTime, Precision: 3}, "'23:59:59.5'", "'23:59:59.500'", true},
		{"time-no-fraction", Type{Kind: TypeTime, Precision: 3}, "'12:00:00'", "'12:00:00.000'", true},
		{"time-extra-zero-digit", Type{Kind: TypeTime, Precision: 0}, "'12:00:00.0'", "", false},
		{"time-24", Type{Kind: TypeTime, Precision: 0}, "'24:00:00'", "", false},
		{"time-now", Type{Kind: TypeTime, Precision: 3}, "now", "", false},
		{"datetime-no-fraction", Type{Kind: TypeDatetime, Precision: 6}, "'2026-01-01 00:00:00'", "'2026-01-01 00:00:00.000000'", true},
		{"datetime-t-separator", Type{Kind: TypeDatetime, Precision: 0}, "'2026-01-01T00:00:00'", "", false},
		{"datetime-now", Type{Kind: TypeDatetime, Precision: 0}, "now", "now", true},

		// types without a literal
		{"text-string", Type{Kind: TypeText}, "'x'", "", false},
		{"bytes-string", Type{Kind: TypeBytes}, "'x'", "", false},

		// lexical forms that are not one literal
		{"empty", Type{Kind: TypeI32}, "", "", false},
		{"plus-sign", Type{Kind: TypeI32}, "+1", "", false},
		{"minus-space-number", Type{Kind: TypeI32}, "- 1", "", false},
		{"leading-space", Type{Kind: TypeI32}, " 1", "", false},
		{"trailing-space", Type{Kind: TypeI32}, "1 ", "", false},
		{"two-literals", Type{Kind: TypeI32}, "1 2", "", false},
		{"unclosed-string", Type{Kind: TypeVarchar, Length: 8}, "'x", "", false},
		{"two-strings", Type{Kind: TypeVarchar, Length: 8}, "'a' 'b'", "", false},
		{"parenthesis", Type{Kind: TypeI32}, "(1)", "", false},
		{"line-end", Type{Kind: TypeVarchar, Length: 8}, "'a\nb'", "", false},
	}
	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) {
			runTimed(t, "literal/"+c.id, 5*time.Second, func() error {
				got, ok := CanonicalLiteral(c.typ, c.text)
				if got != c.want || ok != c.ok {
					return fmt.Errorf("CanonicalLiteral(%s, %q) = (%q, %t), want (%q, %t)", c.typ, c.text, got, ok, c.want, c.ok)
				}
				return nil
			})
		})
	}
}
