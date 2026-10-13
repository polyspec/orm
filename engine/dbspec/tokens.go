package dbspec

import (
	"regexp"
	"strings"
)

// Token is one highlighted span of a dbspec document: the class the editor paints, the 1-based
// line and the range of its columns in code points (docs/dbspec.md "Document"). The classes:
// kw a keyword of the grammar, ty a column type, num a number, str a quoted literal, cmt a
// comment line, punc the braces, parentheses and commas.
type Token struct {
	Cls   string `json:"cls"`
	Line  int    `json:"line"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

var tokenName = regexp.MustCompile(`[a-zA-Z_][a-zA-Z0-9_]*`)

// blockWords open a block or a line of one; typeWords are the column types (docs/dbspec.md).
var blockWords = map[string]bool{"table": true, "settings": true, "diagram": true, "dbspec": true}
var typeWords = map[string]bool{"i16": true, "i32": true, "i64": true, "f64": true, "decimal": true,
	"varchar": true, "text": true, "bytes": true, "uuid": true, "bool": true, "date": true,
	"time": true, "datetime": true}

// Tokens returns the highlighted spans of text, in line and column order. The reading follows the
// grammar without judging it, so every document — a valid one or one with diagnostics —
// highlights: the header line, a `#` comment line, the block keywords, the types, the numbers,
// the quoted literals and the punctuation of each line.
func Tokens(text string) []Token {
	var out []Token
	for n, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			out = append(out, Token{Cls: "cmt", Line: n + 1, Start: 0, End: len(line)})
			continue
		}
		for _, m := range tokenName.FindAllStringIndex(line, -1) {
			name := line[m[0]:m[1]]
			cls := ""
			switch {
			case blockWords[name]:
				cls = "kw"
			case typeWords[name]:
				cls = "ty"
			case name == "primary" || name == "key" || name == "unique" || name == "index" || name == "foreign" ||
				name == "references" || name == "on" || name == "delete" || name == "update" || name == "restrict" ||
				name == "cascade" || name == "default" || name == "now" || name == "null" || name == "check" ||
				name == "use" || name == "at" || name == "asc" || name == "desc":
				cls = "kw"
			}
			if cls != "" {
				out = append(out, Token{Cls: cls, Line: n + 1, Start: m[0], End: m[1]})
			}
		}
		for i := 0; i < len(line); i++ {
			c := line[i]
			if c == '\'' {
				end := strings.IndexByte(line[i+1:], '\'')
				if end < 0 {
					out = append(out, Token{Cls: "str", Line: n + 1, Start: i, End: len(line)})
					break
				}
				out = append(out, Token{Cls: "str", Line: n + 1, Start: i, End: i + end + 2})
				i += end + 1
				continue
			}
			if c >= '0' && c <= '9' && (i == 0 || !isNameByte(line[i-1])) {
				end := i
				for end < len(line) && (line[end] >= '0' && line[end] <= '9' || line[end] == '.') {
					end++
				}
				out = append(out, Token{Cls: "num", Line: n + 1, Start: i, End: end})
				i = end - 1
				continue
			}
			if c == '{' || c == '}' || c == '(' || c == ')' || c == ',' {
				out = append(out, Token{Cls: "punc", Line: n + 1, Start: i, End: i + 1})
			}
		}
	}
	return out
}

func isNameByte(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}
