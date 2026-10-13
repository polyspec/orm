package dbspec

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
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

func TestAnalyzeSampleTokens(t *testing.T) {
	text := joinLines(sampleDocument, false)
	got := Analyze(text, nil).Tokens
	want := []Token{
		{1, 0, 6, "keyword"}, {1, 7, 8, "number"}, {1, 9, 13, "name"},
		{2, 0, 5, "keyword"}, {2, 6, 11, "name"}, {2, 12, 13, "punctuation"},
		{3, 2, 4, "name"}, {3, 5, 8, "type"}, {3, 9, 17, "keyword"},
		{4, 2, 7, "name"}, {4, 8, 15, "type"}, {4, 15, 16, "punctuation"}, {4, 16, 19, "number"},
		{4, 19, 20, "punctuation"}, {4, 21, 28, "keyword"}, {4, 29, 32, "string"},
		{5, 2, 9, "keyword"}, {5, 10, 13, "keyword"}, {5, 14, 15, "punctuation"}, {5, 15, 17, "name"}, {5, 17, 18, "punctuation"},
		{6, 0, 1, "punctuation"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens:\n got %v\nwant %v", got, want)
	}
}

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

// TestAnalyzeClasses covers each class, each place where the parser sets one,
// the abandoned, lexical and comment lines, and the stops.
func TestAnalyzeClasses(t *testing.T) {
	header := "dbspec 1 shop\n"
	cases := []struct {
		name string
		text string
		want []string
	}{
		{"header stop keeps lexical classes", "dbspec\t1 shop\n", []string{
			"1 dbspec word", "1 1 number", "1 shop word"}},
		{"byte order mark then header stop", "\uFEFFdbspec 1 shop\n", []string{
			"1 dbspec word", "1 1 number", "1 shop word"}},
		{"comment keeps its text from # to the line end", header + "\n   # note\ntable t {\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"3 # note comment",
			"4 table keyword", "4 t name", "4 { punctuation",
			"5 } punctuation"}},
		{"table name takes a number", header + "table 12 {\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 12 name", "2 { punctuation",
			"3 } punctuation"}},
		{"column with type, options and default", header + "table t {\n  id i64 identity default now\n  n varchar(9) null default 'a''b'\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id name", "3 i64 type", "3 identity keyword", "3 default keyword", "3 now keyword",
			"4 n name", "4 varchar type", "4 ( punctuation", "4 9 number", "4 ) punctuation",
			"4 null keyword", "4 default keyword", "4 'a''b' string",
			"5 } punctuation"}},
		{"type parameter word is word", header + "table t {\n  m varchar(x)\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 m name", "3 varchar type", "3 ( punctuation", "3 x word", "3 ) punctuation",
			"4 } punctuation"}},
		{"abandoned line is all word", header + "table t {\n  id i64 identity foo\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id word", "3 i64 word", "3 identity word", "3 foo word",
			"4 } punctuation"}},
		{"tab is an offending character and abandons its line", header + "table t {\n\tid i64\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id word", "3 i64 word",
			"4 } punctuation"}},
		{"failed table opening keeps its block lexical", header + "table t { extra\n  id i64 identity\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table word", "2 t word", "2 { punctuation", "2 extra word",
			"3 id word", "3 i64 word", "3 identity word",
			"4 } punctuation"}},
		{"settings block with setting, options and names", header + "table t {\n  id i64 identity\n  settings {\n    select explicit id\n    entity Foo\n  }\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id name", "3 i64 type", "3 identity keyword",
			"4 settings keyword", "4 { punctuation",
			"5 select setting", "5 explicit keyword", "5 id name",
			"6 entity setting", "6 Foo name",
			"7 } punctuation",
			"8 } punctuation"}},
		{"unknown setting keeps its first word as setting", header + "table t {\n  id i64 identity\n  settings {\n    bogus x y\n  }\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id name", "3 i64 type", "3 identity keyword",
			"4 settings keyword", "4 { punctuation",
			"5 bogus setting", "5 x word", "5 y word",
			"6 } punctuation",
			"7 } punctuation"}},
		{"codec stages are keywords only when they are stages", header + "table t {\n  id i64 identity\n  settings {\n    codec c aes hex zz\n  }\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id name", "3 i64 type", "3 identity keyword",
			"4 settings keyword", "4 { punctuation",
			"5 codec setting", "5 c name", "5 aes keyword", "5 hex keyword", "5 zz word",
			"6 } punctuation",
			"7 } punctuation"}},
		{"state machine transition and its form words", header + "table t {\n  id i64 identity\n  settings {\n    state_machine st a -> b require (x)\n    state_machine st initial a\n  }\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id name", "3 i64 type", "3 identity keyword",
			"4 settings keyword", "4 { punctuation",
			"5 state_machine setting", "5 st name", "5 a name", "5 - operator", "5 > operator", "5 b name",
			"5 require keyword", "5 ( punctuation", "5 x name", "5 ) punctuation",
			"6 state_machine setting", "6 st name", "6 initial keyword", "6 a name",
			"7 } punctuation",
			"8 } punctuation"}},
		{"foreign key with actions", header + "table t {\n  id i64 identity\n  foreign key fk (id) references p (id) on delete cascade on update zz\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id name", "3 i64 type", "3 identity keyword",
			"4 foreign keyword", "4 key keyword", "4 fk name", "4 ( punctuation", "4 id name", "4 ) punctuation",
			"4 references keyword", "4 p name", "4 ( punctuation", "4 id name", "4 ) punctuation",
			"4 on keyword", "4 delete keyword", "4 cascade keyword", "4 on keyword", "4 update keyword", "4 zz word",
			"5 } punctuation"}},
		{"index with directions", header + "table t {\n  id i64 identity\n  index ix (id desc, id asc)\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id name", "3 i64 type", "3 identity keyword",
			"4 index keyword", "4 ix name", "4 ( punctuation", "4 id name", "4 desc keyword", "4 , punctuation",
			"4 id name", "4 asc keyword", "4 ) punctuation",
			"5 } punctuation"}},
		{"check with a predicate", header + "table t {\n  a i64\n  check ck (a = 1 and a is not null)\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 a name", "3 i64 type",
			"4 check keyword", "4 ck name", "4 ( punctuation", "4 a name", "4 = operator", "4 1 number",
			"4 and keyword", "4 a name", "4 is keyword", "4 not keyword", "4 null keyword", "4 ) punctuation",
			"5 } punctuation"}},
		{"check function name is word and the rest is lexical", header + "table t {\n  a i64\n  check ck (f(a) = 1)\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 a name", "3 i64 type",
			"4 check keyword", "4 ck name", "4 ( punctuation", "4 f word", "4 ( punctuation", "4 a word", "4 ) punctuation",
			"4 = operator", "4 1 number", "4 ) punctuation",
			"5 } punctuation"}},
		{"null operand is word", header + "table t {\n  a i64\n  check ck (null = 1)\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 a name", "3 i64 type",
			"4 check keyword", "4 ck name", "4 ( punctuation", "4 null word", "4 = operator", "4 1 number", "4 ) punctuation",
			"5 } punctuation"}},
		{"between is word", header + "table t {\n  a i64\n  check ck (a between 1 and 2)\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 a name", "3 i64 type",
			"4 check keyword", "4 ck name", "4 ( punctuation", "4 a name", "4 between word", "4 1 number", "4 and word", "4 2 number", "4 ) punctuation",
			"5 } punctuation"}},
		{"use line", "dbspec 1 shop\nuse other { t1, t2 }\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 use keyword", "2 other name", "2 { punctuation", "2 t1 name", "2 , punctuation", "2 t2 name", "2 } punctuation"}},
		{"diagram with negative coordinate", "dbspec 1 shop\ndiagram d {\n  users at 1 -2\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 diagram keyword", "2 d name", "2 { punctuation",
			"3 users name", "3 at keyword", "3 1 number", "3 - operator", "3 2 number",
			"4 } punctuation"}},
		{"value word other than the value words is word", header + "table t {\n  n i64 default foo\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 n name", "3 i64 type", "3 default keyword", "3 foo word",
			"4 } punctuation"}},
		{"CR before LF is the line end, bare CR is offending", "dbspec 1 shop\ntable t {\r\n  id i64\rx\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id word", "3 i64 word", "3 x word",
			"4 } punctuation"}},
		{"invalid byte is one offending column", "dbspec 1 shop\ntable t {\n  id \xff i64\n}\n", []string{
			"1 dbspec keyword", "1 1 number", "1 shop name",
			"2 table keyword", "2 t name", "2 { punctuation",
			"3 id word", "3 i64 word",
			"4 } punctuation"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := describeTokens(c.text, Analyze(c.text, nil).Tokens)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("tokens:\n got %q\nwant %q", got, c.want)
			}
		})
	}
}

// TestAnalyzeLimitHasNoTokens checks that a limit stop yields no tokens at all.
func TestAnalyzeLimitHasNoTokens(t *testing.T) {
	var b strings.Builder
	b.WriteString("dbspec 1 shop\n")
	for i := 0; i <= maxTables; i++ {
		fmt.Fprintf(&b, "table t%d {\n}\n", i)
	}
	analysis := Analyze(b.String(), nil)
	if len(analysis.Tokens) != 0 {
		t.Fatalf("limit stop gave %d tokens", len(analysis.Tokens))
	}
	if len(analysis.Diagnostics) == 0 || analysis.Diagnostics[len(analysis.Diagnostics)-1].Rule != RuleLimit {
		t.Fatalf("diagnostics = %v, want a limit error", analysis.Diagnostics)
	}
}

// TestAnalyzeIsParse checks that Analyze returns the result of Parse unchanged.
func TestAnalyzeIsParse(t *testing.T) {
	for _, text := range []string{
		joinLines(sampleDocument, false),
		"dbspec 1 shop\ntable t {\n  id i64 identity foo\n}\n",
		"dbspec\t1 shop\n",
	} {
		document, positions, diagnostics := Parse(text, nil)
		analysis := Analyze(text, nil)
		if !reflect.DeepEqual(analysis.Document, document) || !reflect.DeepEqual(analysis.Positions, positions) || !reflect.DeepEqual(analysis.Diagnostics, diagnostics) {
			t.Fatalf("Analyze differs from Parse for %q", text)
		}
	}
}

// TestFormat checks that a document with no diagnostic formats to its
// canonical text, that the output formats to itself, and that a document with
// a diagnostic is refused with the diagnostics of Parse.
func TestFormat(t *testing.T) {
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
