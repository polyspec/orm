package dbspec

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: DIA-205.
func TestMariaDBCatalogDefault(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	text := func(s string) *string { return &s }
	tests := []struct {
		name       string
		in         *string
		want       *string
		expression bool
		err        bool
	}{
		{"no default", nil, nil, false, false},
		{"a NULL default is no default", text("NULL"), nil, false, false},
		{"a quoted literal is its value", text("'a''b'"), text("a'b"), false, false},
		{"a number is itself", text("-1.5"), text("-1.5"), false, false},
		{"the clock is an expression", text("current_timestamp(3)"), text("CURRENT_TIMESTAMP(3)"), true, false},
		{"the clock without a precision", text("current_timestamp()"), text("CURRENT_TIMESTAMP"), true, false},
		{"another text is an expression", text("uuid()"), text("uuid()"), true, false},
		{"a quoted text that is not one literal", text("'a' + 'b'"), nil, false, true},
		{"an unclosed literal", text("'a"), nil, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, expression, err := MariaDBCatalogDefault(tt.in)
			if (err != nil) != tt.err {
				t.Fatalf("error %v, want error %v", err, tt.err)
			}
			if tt.err {
				return
			}
			if (got == nil) != (tt.want == nil) || got != nil && *got != *tt.want || expression != tt.expression {
				t.Fatalf("got %v, %v; want %v, %v", deref(got), expression, deref(tt.want), tt.expression)
			}
		})
	}
}

func deref(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}
