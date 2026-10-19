package dbspec

import "strings"

// Expr is a check predicate or its operand (docs/spec/dbspec.md "Checks"). The tree holds no
// parentheses; emission writes only the parentheses that an or inside an and requires.
type Expr interface{ expr() }

// ColumnRef refers to a column of the same table.
type ColumnRef struct {
	Name string
	at   token
}

// Literal is an integer, decimal, string, true or false literal in the
// canonical default form of the column it meets.
type Literal struct {
	Text string
	at   token
}

// Binary is `<left> <op> <right>` for and, or and the comparisons.
type Binary struct {
	Op    string
	Left  Expr
	Right Expr
	at    token
}

// In is `<operand> [not] in (<literal>, ...)`.
type In struct {
	Operand Expr
	Negated bool
	List    []Literal
}

// IsNull is `<operand> is [not] null`.
type IsNull struct {
	Operand Expr
	Negated bool
}

func (ColumnRef) expr() {}
func (Literal) expr()   {}
func (Binary) expr()    {}
func (In) expr()        {}
func (IsNull) expr()    {}

var expressionKeywords = map[string]bool{
	"and": true, "or": true, "not": true, "in": true, "between": true,
	"is": true, "null": true, "true": true, "false": true,
}

type expressionParser struct {
	tokens []token
	i      int
	end    token
	refs   []token
	bad    *Diagnostic
	// marks are the classes of tokens, parallel to tokens; nil unless analyzing.
	marks []tokenClass
}

// mark sets the class of token i when the expression is traced.
func (p *expressionParser) mark(i int, class tokenClass) {
	if p.marks != nil {
		p.marks[i] = class
	}
}

// parseExpression parses the tokens of a check expression; end is the
// closing parenthesis of the check. It returns the expression and its column
// references, or the check diagnostic at the first token outside the neutral
// set. marks, when not nil, receives the class of each token the reader reads.
func parseExpression(tokens []token, end token, marks []tokenClass) (Expr, []token, *Diagnostic) {
	p := &expressionParser{tokens: tokens, end: end, marks: marks}
	e := p.or()
	if p.bad == nil && p.i < len(p.tokens) {
		p.fail("is not allowed here")
	}
	if p.bad != nil {
		return nil, nil, p.bad
	}
	return e, p.refs, nil
}

func (p *expressionParser) peek() token {
	if p.i < len(p.tokens) {
		return p.tokens[p.i]
	}
	return p.end
}

// literalAt fails at a literal written where the predicate forms need a
// column.
func (p *expressionParser) literalAt(l Literal, reason string) Expr {
	if p.bad == nil {
		d := diagnosticAt(RuleCheck, l.at, "%s %s", l.at.describe(), reason)
		p.bad = &d
	}
	return nil
}

func (p *expressionParser) fail(reason string) Expr {
	if p.bad == nil {
		t := p.peek()
		d := diagnosticAt(RuleCheck, t, "%s %s in a check expression", t.describe(), reason)
		if p.i >= len(p.tokens) {
			d.Message = "check expression ends early"
		}
		p.bad = &d
	}
	return nil
}

func (p *expressionParser) word(text string) bool {
	if p.i < len(p.tokens) && p.tokens[p.i].is(tokenWord, text) {
		p.mark(p.i, classKeyword)
		p.i++
		return true
	}
	return false
}

func (p *expressionParser) or() Expr {
	left := p.and()
	for p.bad == nil && p.word("or") {
		left = Binary{Op: "or", Left: left, Right: p.and()}
	}
	return left
}

func (p *expressionParser) and() Expr {
	left := p.predicate()
	for p.bad == nil && p.word("and") {
		left = Binary{Op: "and", Left: left, Right: p.predicate()}
	}
	return left
}

// predicate reads one predicate form. Parentheses only group the predicate and
// leave no node, because emission writes the parentheses that precedence requires.
func (p *expressionParser) predicate() Expr {
	if p.punct("(") {
		inner := p.or()
		if p.bad != nil {
			return nil
		}
		if !p.punct(")") {
			return p.fail("is not allowed here; expected )")
		}
		return inner
	}
	left := p.operand()
	if p.bad != nil {
		return nil
	}
	literal, isLiteral := left.(Literal)
	if p.i >= len(p.tokens) {
		return p.alone(left)
	}
	t := p.tokens[p.i]
	switch {
	case t.kind == tokenOperator && (t.text == "=" || t.text == "<>" || t.text == "<" || t.text == "<=" || t.text == ">" || t.text == ">="):
		p.i++
		right := p.operand()
		if _, both := right.(Literal); p.bad == nil && isLiteral && both {
			return p.literalAt(literal, "is compared with a literal; a comparison needs a column")
		}
		return Binary{Op: t.text, Left: left, Right: right, at: t}
	case isLiteral && (t.is(tokenWord, "is") || t.is(tokenWord, "in") ||
		(t.is(tokenWord, "not") && p.i+1 < len(p.tokens) && p.tokens[p.i+1].is(tokenWord, "in"))):
		return p.literalAt(literal, "is not a column")
	case t.is(tokenWord, "is"):
		p.mark(p.i, classKeyword)
		p.i++
		negated := p.word("not")
		if !p.word("null") {
			return p.fail("is not allowed here; expected null")
		}
		return IsNull{Operand: left, Negated: negated}
	}
	negated := false
	if t.is(tokenWord, "not") && p.i+1 < len(p.tokens) && p.tokens[p.i+1].is(tokenWord, "in") {
		p.mark(p.i, classKeyword)
		p.i++
		negated = true
	}
	if p.word("in") {
		if !p.punct("(") {
			return p.fail("is not allowed here; expected (")
		}
		var list []Literal
		for {
			l, ok := p.literal()
			if !ok {
				return p.fail("is not a literal")
			}
			list = append(list, l)
			if p.punct(")") {
				return In{Operand: left, Negated: negated, List: list}
			}
			if !p.punct(",") {
				return p.fail("is not allowed here; expected , or )")
			}
		}
	}
	return p.alone(left)
}

// alone reports an operand that is not followed by a comparison, in, or is. When followed by and, or, a closing parenthesis,
// or the end, it reports at the operand, and elsewhere at the token that follows.
func (p *expressionParser) alone(operand Expr) Expr {
	if next := p.peek(); p.i < len(p.tokens) && !next.is(tokenWord, "and") && !next.is(tokenWord, "or") && !next.is(tokenPunct, ")") {
		return p.fail("is not allowed here")
	}
	at := token{}
	switch o := operand.(type) {
	case ColumnRef:
		at = o.at
	case Literal:
		at = o.at
	}
	if p.bad == nil {
		d := diagnosticAt(RuleCheck, at, "%s alone is not a predicate", at.describe())
		p.bad = &d
	}
	return nil
}

func (p *expressionParser) punct(text string) bool {
	if p.i < len(p.tokens) && p.tokens[p.i].is(tokenPunct, text) {
		p.i++
		return true
	}
	return false
}

// operand reads a literal or a column reference. Arithmetic, functions and the
// null literal are not operands.
func (p *expressionParser) operand() Expr {
	if p.bad != nil {
		return nil
	}
	if l, ok := p.literal(); ok {
		return l
	}
	if p.i >= len(p.tokens) {
		return p.fail("")
	}
	t := p.tokens[p.i]
	if t.kind != tokenWord || expressionKeywords[t.text] {
		return p.fail("is not allowed here")
	}
	if p.i+1 < len(p.tokens) && p.tokens[p.i+1].is(tokenPunct, "(") {
		return p.fail("is a function; check predicates have no functions")
	}
	p.mark(p.i, className)
	p.i++
	p.refs = append(p.refs, t)
	return ColumnRef{Name: t.text, at: t}
}

// literal reads a literal: an optionally negative number, a string, true or
// false. Its text is canonical once validation knows the column it meets.
func (p *expressionParser) literal() (Literal, bool) {
	if p.i >= len(p.tokens) {
		return Literal{}, false
	}
	t := p.tokens[p.i]
	switch {
	case t.kind == tokenNumber:
		p.i++
		return Literal{Text: t.text, at: t}, true
	case t.is(tokenOperator, "-") && p.i+1 < len(p.tokens) && p.tokens[p.i+1].kind == tokenNumber:
		p.i += 2
		number := p.tokens[p.i-1]
		return Literal{Text: "-" + number.text, at: token{kind: tokenNumber, text: "-" + number.text, line: t.line, col: t.col}}, true
	case t.kind == tokenString:
		p.i++
		return Literal{Text: quote(t.text), at: t}, true
	case t.is(tokenWord, "true"), t.is(tokenWord, "false"):
		p.mark(p.i, classKeyword)
		p.i++
		return Literal{Text: t.text, at: t}, true
	}
	return Literal{}, false
}

// canonicalNumber removes leading zeros of the integer part and the sign of
// zero; the fraction digits stay as written.
func canonicalNumber(s string) string {
	negative := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	integer, fraction, hasFraction := strings.Cut(s, ".")
	integer = strings.TrimLeft(integer, "0")
	if integer == "" {
		integer = "0"
	}
	out := integer
	if hasFraction {
		out += "." + fraction
	}
	if negative && strings.Trim(out, "0.") != "" {
		out = "-" + out
	}
	return out
}

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func writeExpr(b *strings.Builder, e Expr) {
	switch e := e.(type) {
	case ColumnRef:
		b.WriteString(e.Name)
	case Literal:
		b.WriteString(e.Text)
	case Binary:
		writeOperand(b, e.Op, e.Left)
		b.WriteString(" " + e.Op + " ")
		writeOperand(b, e.Op, e.Right)
	case In:
		writeExpr(b, e.Operand)
		if e.Negated {
			b.WriteString(" not")
		}
		b.WriteString(" in (")
		for i, l := range e.List {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(l.Text)
		}
		b.WriteString(")")
	case IsNull:
		writeExpr(b, e.Operand)
		if e.Negated {
			b.WriteString(" is not null")
		} else {
			b.WriteString(" is null")
		}
	}
}

// needsParentheses reports whether e, the operand of op, is an or inside an and.
func needsParentheses(op string, e Expr) bool {
	inner, ok := e.(Binary)
	return op == "and" && ok && inner.Op == "or"
}

func writeOperand(b *strings.Builder, op string, e Expr) {
	if needsParentheses(op, e) {
		b.WriteString("(")
		writeExpr(b, e)
		b.WriteString(")")
		return
	}
	writeExpr(b, e)
}
