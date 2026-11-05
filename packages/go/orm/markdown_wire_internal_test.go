package orm

import (
	"math"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestStatementParamForms holds the wire form of each bound value (PRT-67): a value that JSON cannot hold takes the form
// that an answer writes for it, so it binds as the value it is, and every form reads back as the value it was.
func TestStatementParamForms(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	at := time.Date(2024, 1, 2, 3, 4, 5, 600000000, time.FixedZone("x", 3600))
	for _, c := range []struct {
		name string
		in   any
		wire string
		back any
	}{
		{"an integer", int64(7), `7`, int64(7)},
		{"a fraction", 1.5, `1.5`, 1.5},
		{"a text", "abc", `"abc"`, "abc"},
		{"a null", nil, `null`, nil},
		{"a blob", []byte("ab"), `{"bytes":"YWI="}`, []byte("ab")},
		{"a text that is not UTF-8", "\xff", `{"text":"/w=="}`, "\xff"},
		{"an infinity", math.Inf(1), `{"float":"+Inf"}`, math.Inf(1)},
		{"a negative infinity", math.Inf(-1), `{"float":"-Inf"}`, math.Inf(-1)},
		{"a time", at, `"2024-01-02 02:04:05.600000"`, "2024-01-02 02:04:05.600000"},
	} {
		t.Run(c.name, func(t *testing.T) {
			raw, err := statementParam(c.in)
			if err != nil {
				t.Fatalf("statementParam(%v): %v", c.in, err)
			}
			if string(raw) != c.wire {
				t.Fatalf("statementParam(%v) = %s, want %s", c.in, raw, c.wire)
			}
			back, err := statementCell(raw)
			if err != nil {
				t.Fatalf("statementCell(%s): %v", raw, err)
			}
			if b, ok := back.([]byte); ok {
				if string(b) != string(c.back.([]byte)) {
					t.Fatalf("statementCell(%s) = %q, want %q", raw, b, c.back)
				}
				return
			}
			if back != c.back {
				t.Fatalf("statementCell(%s) = %#v, want %#v", raw, back, c.back)
			}
		})
	}
}
