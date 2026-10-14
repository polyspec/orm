package dbspec

import (
	"strings"
	"unicode/utf8"
)

// Analysis is the result of Analyze: the result of Parse, unchanged, and the
// tokens of the text (docs/dbspec.md "Syntax analysis").
type Analysis struct {
	Document    *Document
	Positions   []Position
	Diagnostics []Diagnostic
	Tokens      []Token
}

// Token is one token of the text: its 1-based line, the number of Unicode
// code points before it on the line, the number before the code point after
// it, and its class.
type Token struct {
	Line  int
	Start int
	End   int
	Class string
}

// tokenClass is a class that the parser gives a token where it reads it. The
// zero class is the lexical class of the token's kind.
type tokenClass uint8

const (
	classLexical tokenClass = iota
	classKeyword
	className
	classType
	classSetting
)

var classNames = [...]string{classKeyword: "keyword", className: "name", classType: "type", classSetting: "setting"}

// lexicalClassName is the class of a token that the parser does not classify.
func lexicalClassName(kind tokenKind) string {
	switch kind {
	case tokenNumber:
		return "number"
	case tokenString:
		return "string"
	case tokenPunct:
		return "punctuation"
	case tokenOperator:
		return "operator"
	}
	return "word"
}

// Analyze parses text as Parse does and returns the result unchanged with the
// tokens of the text. A limit error yields no tokens (docs/dbspec.md "Syntax
// analysis").
func Analyze(text string, documents map[string]string) Analysis {
	tr := &trace{lines: map[int]*traceLine{}}
	document, positions, diagnostics := parse(text, documents, tr)
	out := Analysis{Document: document, Positions: positions, Diagnostics: diagnostics}
	for _, d := range diagnostics {
		if d.Rule == RuleLimit {
			return out
		}
	}
	out.Tokens = tr.tokens(text)
	return out
}

// Format returns the canonical text of a document with no diagnostic, and
// otherwise the diagnostics and no text: a document with a diagnostic is never
// rewritten (docs/dbspec.md "Formatting").
func Format(text string, documents map[string]string) (string, []Diagnostic) {
	document, _, diagnostics := Parse(text, documents)
	if len(diagnostics) > 0 {
		return "", diagnostics
	}
	return Emit(document), nil
}

// trace records, for each line the parser reads, its tokens and the classes
// the parser gave them. A nil trace records nothing.
type trace struct {
	lines map[int]*traceLine
}

type traceLine struct {
	comment bool
	raw     string
	tokens  []token
	// marks is nil for a line that keeps its lexical classes.
	marks []tokenClass
}

// addLine records the tokens of a line and returns the classes to set on
// them, or nil when the line is not traced or keeps its lexical classes.
func (tr *trace) addLine(line int, tokens []token, marked bool) []tokenClass {
	if tr == nil {
		return nil
	}
	l := &traceLine{tokens: tokens}
	if marked {
		l.marks = make([]tokenClass, len(tokens))
	}
	tr.lines[line] = l
	return l.marks
}

// addComment records a comment line; its text is not lexed.
func (tr *trace) addComment(line int, raw string) {
	if tr != nil {
		tr.lines[line] = &traceLine{comment: true, raw: raw}
	}
}

// marked reports whether the parser sets classes on the line it is reading:
// a line of a block whose opening line failed keeps its lexical classes.
func (p *parser) marked() bool {
	return p.trace != nil && !p.lexicalBlock()
}

// lexicalBlock reports whether the current line is inside a block whose
// opening line failed (docs/dbspec.md "Syntax analysis").
func (p *parser) lexicalBlock() bool {
	switch p.state {
	case stateTable:
		return p.table.failed
	case stateSettings:
		return p.table.failed || p.settingsFailed
	case stateDiagram:
		return p.diagram.failed
	}
	return false
}

// tokens returns the tokens of every line of text in source order.
func (tr *trace) tokens(text string) []Token {
	out := []Token{}
	for i, raw := range sourceLines(text) {
		line := i + 1
		l := tr.lines[line]
		if l != nil && l.comment {
			out = append(out, commentToken(line, raw))
			continue
		}
		var tokens []token
		var marks []tokenClass
		if l != nil {
			tokens, marks = l.tokens, l.marks
		} else {
			trimmed := strings.TrimLeft(raw, " ")
			if trimmed == "" {
				continue
			}
			if trimmed[0] == '#' {
				out = append(out, commentToken(line, raw))
				continue
			}
			tokens = lexRecover(raw, line)
		}
		for k, t := range tokens {
			start := t.col - 1
			class := lexicalClassName(t.kind)
			if marks != nil && marks[k] != classLexical {
				class = classNames[marks[k]]
			}
			out = append(out, Token{Line: line, Start: start, End: start + tokenWidth(t), Class: class})
		}
	}
	return out
}

// commentToken is the comment token of a comment line: from its '#' to the
// line end, any carriage return included.
func commentToken(line int, raw string) Token {
	trimmed := strings.TrimLeft(raw, " ")
	start := len(raw) - len(trimmed) // leading spaces are ASCII
	return Token{Line: line, Start: start, End: start + utf8.RuneCountInString(trimmed), Class: "comment"}
}

// tokenWidth is the number of code points of the source text of t. A string
// token's text is its value, so its quotes and the doubled quotes count too.
func tokenWidth(t token) int {
	if t.kind == tokenString {
		return 2 + utf8.RuneCountInString(t.text) + strings.Count(t.text, "'")
	}
	return utf8.RuneCountInString(t.text)
}

// sourceLines splits text at its line feeds. A carriage return before a line
// feed ends the line with it; any other carriage return stays in the line, as
// the lexical lines after an encoding stop do.
func sourceLines(text string) []string {
	var lines []string
	for {
		i := strings.IndexByte(text, '\n')
		if i < 0 {
			if text != "" {
				lines = append(lines, text)
			}
			return lines
		}
		lines = append(lines, strings.TrimSuffix(text[:i], "\r"))
		text = text[i+1:]
	}
}
