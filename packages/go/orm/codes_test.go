package orm

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// catalogCode is one code of docs/errors.yaml with the note that its generated constant carries: the origin, then
// ": " and the comment of the code when it has one.
type catalogCode struct{ code, note string }

// readCatalog reads docs/errors.yaml, a flat list of "- code: X  # comment" lines each followed by "origin: Y".
func readCatalog(t *testing.T) []catalogCode {
	t.Helper()
	src, err := os.ReadFile("../../../docs/errors.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var out []catalogCode
	var comment string
	for _, line := range strings.Split(string(src), "\n") {
		text := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(text, "- code:"):
			code, rest, _ := strings.Cut(strings.TrimSpace(strings.TrimPrefix(text, "- code:")), "#")
			out = append(out, catalogCode{code: strings.TrimSpace(code)})
			comment = strings.TrimSpace(rest)
		case strings.HasPrefix(text, "origin:") && len(out) > 0:
			note := strings.TrimSpace(strings.TrimPrefix(text, "origin:"))
			if comment != "" {
				note += ": " + comment
			}
			out[len(out)-1].note = note
		}
	}
	if len(out) == 0 {
		t.Fatal("docs/errors.yaml lists no codes")
	}
	return out
}

// TestCodeCatalog compares codes.go, which orm-gen errors generates, with docs/errors.yaml: every code is a constant
// with the note of the catalog, and the file holds no other code.
func TestCodeCatalog(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	src, err := os.ReadFile("codes.go")
	if err != nil {
		t.Fatal(err)
	}
	codes := readCatalog(t)
	for _, c := range codes {
		line := regexp.MustCompile(`(?m)^\s*Code\w+\s*=\s*"` + regexp.QuoteMeta(c.code) + `"\s*// (.*)$`).FindSubmatch(src)
		switch {
		case line == nil:
			t.Errorf("codes.go has no constant for %s", c.code)
		case string(line[1]) != c.note:
			t.Errorf("codes.go %s: %q, docs/errors.yaml: %q; run orm-gen errors --lang go", c.code, line[1], c.note)
		}
	}
	if got := len(regexp.MustCompile(`(?m)^\s*Code\w+\s*=`).FindAll(src, -1)); got != len(codes) {
		t.Errorf("codes.go holds %d codes, docs/errors.yaml %d", got, len(codes))
	}
}
