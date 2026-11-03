package dbspec

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

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
// Requirements: DBS-134, DBS-135, DBS-144.
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
