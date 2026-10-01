package dbspec

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Document limits (docs/dbspec.md "Limits and errors").
const (
	maxDocumentBytes   = 32 << 20
	maxTables          = 4096
	maxColumns         = 120000
	maxForeignKeys     = 20000
	maxTableColumns    = 1000
	maxNameBytes       = 63
	maxKeyColumns      = 16
	maxKeyVarcharChars = 640
)

type tokenKind uint8

const (
	tokenWord tokenKind = iota + 1
	tokenNumber
	tokenString
	tokenPunct
	tokenOperator
)

// token is one lexical token. text is the source text, except for a string
// token, whose text is the decoded value without quotes.
type token struct {
	kind tokenKind
	text string
	line int
	col  int
}

func (t token) is(kind tokenKind, text string) bool { return t.kind == kind && t.text == text }

func (t token) describe() string {
	if t.kind == tokenString {
		return "string '" + t.text + "'"
	}
	return "'" + t.text + "'"
}

func diagnosticAt(rule string, t token, format string, args ...any) Diagnostic {
	return Diagnostic{Rule: rule, Line: t.line, Column: t.col, Message: fmt.Sprintf(format, args...)}
}

// splitSource checks the size and the encoding of text and splits it into
// lines without their line ends. A final line end does not start a line.
// On an encoding error it returns the complete lines before the offending
// line, so they are parsed before the error is reported.
func splitSource(text string) ([]string, *Diagnostic) {
	if len(text) > maxDocumentBytes {
		return nil, &Diagnostic{Rule: RuleLimit, Line: 1, Column: 1, Message: fmt.Sprintf("document has %d bytes, more than %d", len(text), maxDocumentBytes)}
	}
	if strings.HasPrefix(text, "\xef\xbb\xbf") {
		return nil, &Diagnostic{Rule: RuleEncoding, Line: 1, Column: 1, Message: "document starts with a byte order mark"}
	}
	lines := make([]string, 0, strings.Count(text, "\n")+1)
	line, col, start := 1, 1, 0
	for i := 0; i < len(text); {
		c := text[i]
		if c < utf8.RuneSelf {
			switch c {
			case '\n':
				end := i
				if end > start && text[end-1] == '\r' {
					end--
				}
				lines = append(lines, text[start:end])
				i++
				start = i
				line++
				col = 1
				continue
			case '\r':
				if i+1 >= len(text) || text[i+1] != '\n' {
					return lines, &Diagnostic{Rule: RuleEncoding, Line: line, Column: col, Message: "carriage return without a following line feed"}
				}
			}
			i++
			col++
			continue
		}
		r, size := utf8.DecodeRuneInString(text[i:])
		if r == utf8.RuneError && size == 1 {
			return lines, &Diagnostic{Rule: RuleEncoding, Line: line, Column: col, Message: "text is not valid UTF-8"}
		}
		i += size
		col++
	}
	if start < len(text) {
		lines = append(lines, text[start:])
	}
	return lines, nil
}

func isWordRune(r rune) bool {
	if r < utf8.RuneSelf {
		return r == '_' || r == '.' || ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z') || ('0' <= r && r <= '9')
	}
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// isNumberText reports whether s is digits with an optional fraction.
func isNumberText(s string) bool {
	digits, dot := 0, false
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case '0' <= c && c <= '9':
			digits++
		case c == '.' && !dot && digits > 0 && i+1 < len(s):
			dot = true
			digits = 0
		default:
			return false
		}
	}
	return digits > 0
}

// lexLine splits one line into tokens. It returns the tokens before the
// first character that cannot start a token, the column just after the line,
// and the syntax diagnostic of that character, if any.
func lexLine(s string, line int) ([]token, int, *Diagnostic) {
	tokens := make([]token, 0, 8)
	col := 1
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == ' ':
			i++
			col++
		case c == '(' || c == ')' || c == '{' || c == '}' || c == ',':
			tokens = append(tokens, token{kind: tokenPunct, text: s[i : i+1], line: line, col: col})
			i++
			col++
		case c == '<' || c == '>':
			n := 1
			if i+1 < len(s) && (s[i+1] == '=' || (c == '<' && s[i+1] == '>')) {
				n = 2
			}
			tokens = append(tokens, token{kind: tokenOperator, text: s[i : i+n], line: line, col: col})
			i += n
			col += n
		case c == '=' || c == '+' || c == '-' || c == '*' || c == '/':
			tokens = append(tokens, token{kind: tokenOperator, text: s[i : i+1], line: line, col: col})
			i++
			col++
		case c == '\'':
			start := col
			var value strings.Builder
			j := i + 1
			col++
			closed := false
			for j < len(s) {
				if s[j] == '\'' {
					if j+1 < len(s) && s[j+1] == '\'' {
						value.WriteByte('\'')
						j += 2
						col += 2
						continue
					}
					j++
					col++
					closed = true
					break
				}
				_, size := utf8.DecodeRuneInString(s[j:])
				value.WriteString(s[j : j+size])
				j += size
				col++
			}
			if !closed {
				return tokens, 0, &Diagnostic{Rule: RuleSyntax, Line: line, Column: start, Message: "string is not closed on its line"}
			}
			tokens = append(tokens, token{kind: tokenString, text: value.String(), line: line, col: start})
			i = j
		default:
			r, size := rune(c), 1
			if c >= utf8.RuneSelf {
				r, size = utf8.DecodeRuneInString(s[i:])
			}
			if !isWordRune(r) {
				return tokens, 0, &Diagnostic{Rule: RuleSyntax, Line: line, Column: col, Message: fmt.Sprintf("character %q is not allowed here", r)}
			}
			start, startCol := i, col
			i += size
			col++
			for i < len(s) {
				r, size = rune(s[i]), 1
				if s[i] >= utf8.RuneSelf {
					r, size = utf8.DecodeRuneInString(s[i:])
				}
				if !isWordRune(r) {
					break
				}
				i += size
				col++
			}
			kind := tokenWord
			if isNumberText(s[start:i]) {
				kind = tokenNumber
			}
			tokens = append(tokens, token{kind: kind, text: s[start:i], line: line, col: startCol})
		}
	}
	return tokens, col, nil
}

// lexRecover lexes a line that has a lexical error again with every
// offending character read as a space, so the kind and the names of the
// failed line are known. Columns stay the same.
func lexRecover(s string, line int) []token {
	runes := []rune(s)
	for range runes {
		tokens, _, bad := lexLine(string(runes), line)
		if bad == nil {
			return tokens
		}
		runes[bad.Column-1] = ' '
	}
	return nil
}

// nameDiagnostics checks a defining name: format, then length.
func nameDiagnostics(t token) []Diagnostic {
	var out []Diagnostic
	if !validNameFormat(t.text) {
		out = append(out, diagnosticAt(RuleNameFormat, t, "name %q does not match [a-z][a-z0-9_]* or is a reserved word", t.text))
	}
	if len(t.text) > maxNameBytes {
		out = append(out, diagnosticAt(RuleNameLength, t, "name %q has %d bytes, more than %d", t.text, len(t.text), maxNameBytes))
	}
	return out
}

// reservedWords are not valid names (docs/dbspec.md "Names").
var reservedWords = map[string]bool{
	"dbspec": true, "use": true, "table": true, "diagram": true, "primary": true,
	"unique": true, "index": true, "foreign": true, "check": true, "settings": true,
	"null": true, "identity": true, "default": true, "true": true, "false": true,
	"and": true, "or": true, "not": true, "in": true, "between": true, "is": true,
}

func validNameFormat(s string) bool {
	if s == "" || reservedWords[s] || s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if !(('a' <= c && c <= 'z') || ('0' <= c && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}

// wellFormed reports whether a referenced name follows the name rules.
func wellFormed(s string) bool { return validNameFormat(s) && len(s) <= maxNameBytes }
