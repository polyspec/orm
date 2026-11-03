package dbspec

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// sampleDocument is the worked example of the T128-3 analysis rules.
var sampleDocument = []string{
	"dbspec 1 shop",
	"table users {",
	"  id i64 identity",
	"  email varchar(191) default 'a'",
	"  primary key (id)",
	"}",
}

// Requirements: DBS-134, DBS-135.
// describeTokens renders each token as its line, its source text and its class.
func describeTokens(text string, tokens []Token) []string {
	lines := sourceLines(text)
	out := []string{}
	for _, t := range tokens {
		runes := []rune(lines[t.Line-1])
		out = append(out, fmt.Sprintf("%d %s %s", t.Line, string(runes[t.Start:t.End]), t.Class))
	}
	return out
}

// TestAnalyzeInvalidByte checks that an invalid UTF-8 byte is one offending column and abandons its line. A JSON recipe
// line cannot hold the byte (FCV-2), and the other analysis cases are recipe cases of tests/dbspec/rules.json.
// Requirements: DBS-134, DBS-135.
func TestAnalyzeInvalidByte(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	text := "dbspec 1 shop\ntable t {\n  id \xff i64\n}\n"
	want := []string{
		"1 dbspec keyword", "1 1 number", "1 shop name",
		"2 table keyword", "2 t name", "2 { punctuation",
		"3 id word", "3 i64 word",
		"4 } punctuation",
	}
	if got := describeTokens(text, Analyze(text, nil).Tokens); !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens:\n got %q\nwant %q", got, want)
	}
}

// TestFormat checks that a document with no diagnostic formats to its
// canonical text, that the output formats to itself, and that a document with
// a diagnostic is refused with the diagnostics of Parse.
// Requirements: DBS-141, ORES-14.
func TestFormat(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	text := joinLines(sampleDocument, false)
	formatted, diagnostics := Format(text, nil)
	if len(diagnostics) != 0 {
		t.Fatalf("diagnostics = %v", diagnostics)
	}
	again, diagnostics := Format(formatted, nil)
	if len(diagnostics) != 0 || again != formatted {
		t.Fatalf("format is not idempotent:\n%q\n%q", formatted, again)
	}
	bad := "dbspec 1 shop\ntable t {\n  id i64 identity foo\n}\n"
	text, diagnostics = Format(bad, nil)
	_, _, want := Parse(bad, nil)
	if text != "" || !reflect.DeepEqual(diagnostics, want) || len(diagnostics) == 0 {
		t.Fatalf("Format(bad) = %q, %v; want no text and %v", text, diagnostics, want)
	}
}
