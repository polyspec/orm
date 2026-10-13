package dbspec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

// TestTokens pins the dbspec highlighter over the shared case database and the grammar readings:
// every span of every canonical case lies in its line and names its class, the header, a comment,
// a type and a string take theirs, and a document with diagnostics highlights all the same — the
// reading follows the grammar without judging it.
func TestTokens(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	b, err := os.ReadFile(filepath.Join("..", "..", "tests", "dbspec", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases struct {
		Canonical []struct {
			Documents map[string][]string `json:"documents"`
			Main      string              `json:"main"`
		} `json:"canonical"`
		Invalid []struct {
			Documents map[string][]string `json:"documents"`
			Main      string              `json:"main"`
		} `json:"invalid"`
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	join := func(lines []string) string {
		out := ""
		for _, l := range lines {
			out += l + "\n"
		}
		return out
	}
	check := func(name, text string) {
		t.Helper()
		lines := append([]string{}, strings.Split(text, "\n")...)
		for _, tok := range Tokens(text) {
			if tok.Line < 1 || tok.Line > len(lines) || tok.Start < 0 || tok.End > len(lines[tok.Line-1]) || tok.Start >= tok.End {
				t.Fatalf("%s: token %+v outside its line", name, tok)
			}
		}
	}
	for _, c := range cases.Canonical {
		check(c.Main, join(c.Documents[c.Main]))
	}
	for _, c := range cases.Invalid {
		check(c.Main, join(c.Documents[c.Main]))
	}
	got := Tokens("dbspec 1 shop\n# note\n  id i64 identity default 'x'\n")
	want := []Token{
		{Cls: "kw", Line: 1, Start: 0, End: 6},
		{Cls: "num", Line: 1, Start: 7, End: 8},
		{Cls: "cmt", Line: 2, Start: 0, End: 6},
		{Cls: "ty", Line: 3, Start: 5, End: 8},
		{Cls: "kw", Line: 3, Start: 18, End: 25},
		{Cls: "str", Line: 3, Start: 26, End: 29},
	}
	if len(got) != len(want) {
		t.Fatalf("tokens %+v; want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("token %d: %+v; want %+v", i, got[i], want[i])
		}
	}
}
