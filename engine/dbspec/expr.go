package dbspec

import "strings"

// Expr is a check expression of the neutral set (docs/dbspec.md "Checks").
// Parentheses written in the source are kept as Paren nodes, so emission
// reproduces the grouping.
type Expr interface{ expr() }

// ColumnRef refers to a column of the same table.
type ColumnRef struct{ Name string }

// Literal is an integer, decimal, string, true, false or null literal in
// canonical form: numbers without leading zeros or a sign on zero, strings in
// single quotes with ” for a quote.
type Literal struct{ Text string }

// Not is `not <operand>`.
type Not struct{ Operand Expr }

// Binary is `<left> <op> <right>` for and, or, comparison and arithmetic
// operators.
type Binary struct {
	Op    string
	Left  Expr
	Right Expr
}

// In is `<operand> [not] in (<literal>, ...)`.
type In struct {
	Operand Expr
	Negated bool
	List    []Literal
}

// Between is `<operand> [not] between <low> and <high>`.
type Between struct {
	Operand Expr
	Negated bool
	Low     Expr
	High    Expr
}

// IsNull is `<operand> is [not] null`.
type IsNull struct {
	Operand Expr
	Negated bool
}

// Paren is a parenthesized expression.
type Paren struct{ Inner Expr }

func (ColumnRef) expr() {}
func (Literal) expr()   {}
func (Not) expr()       {}
func (Binary) expr()    {}
func (In) expr()        {}
func (Between) expr()   {}
func (IsNull) expr()    {}
func (Paren) expr()     {}

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
}

// parseExpression parses the tokens of a check expression; end is the
// closing parenthesis of the check. It returns the expression and its column
// references, or the check diagnostic at the first token outside the neutral
// set.
func parseExpression(tokens []token, end token) (Expr, []token, *Diagnostic) {
	p := &expressionParser{tokens: tokens, end: end}
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
	left := p.not()
	for p.bad == nil && p.word("and") {
		left = Binary{Op: "and", Left: left, Right: p.not()}
	}
	return left
}

func (p *expressionParser) not() Expr {
	if p.word("not") {
		return Not{Operand: p.not()}
	}
	return p.predicate()
}

func (p *expressionParser) predicate() Expr {
	left := p.additive()
	if p.bad != nil || p.i >= len(p.tokens) {
		return left
	}
	t := p.tokens[p.i]
	switch {
	case t.kind == tokenOperator && (t.text == "=" || t.text == "<>" || t.text == "<" || t.text == "<=" || t.text == ">" || t.text == ">="):
		p.i++
		return Binary{Op: t.text, Left: left, Right: p.additive()}
	case t.is(tokenWord, "is"):
		p.i++
		negated := p.word("not")
		if !p.word("null") {
			return p.fail("is not allowed here; expected null")
		}
		return IsNull{Operand: left, Negated: negated}
	}
	negated := false
	if t.is(tokenWord, "not") && p.i+1 < len(p.tokens) &&
		(p.tokens[p.i+1].is(tokenWord, "in") || p.tokens[p.i+1].is(tokenWord, "between")) {
		p.i++
		negated = true
	}
	switch {
	case p.word("in"):
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
	case p.word("between"):
		low := p.additive()
		if p.bad != nil {
			return nil
		}
		if !p.word("and") {
			return p.fail("is not allowed here; expected and")
		}
		return Between{Operand: left, Negated: negated, Low: low, High: p.additive()}
	}
	return left
}

func (p *expressionParser) punct(text string) bool {
	if p.i < len(p.tokens) && p.tokens[p.i].is(tokenPunct, text) {
		p.i++
		return true
	}
	return false
}

func (p *expressionParser) additive() Expr {
	left := p.multiplicative()
	for p.bad == nil && p.i < len(p.tokens) && (p.tokens[p.i].is(tokenOperator, "+") || p.tokens[p.i].is(tokenOperator, "-")) {
		op := p.tokens[p.i].text
		p.i++
		left = Binary{Op: op, Left: left, Right: p.multiplicative()}
	}
	return left
}

func (p *expressionParser) multiplicative() Expr {
	left := p.primary()
	for p.bad == nil && p.i < len(p.tokens) && (p.tokens[p.i].is(tokenOperator, "*") || p.tokens[p.i].is(tokenOperator, "/")) {
		op := p.tokens[p.i].text
		p.i++
		left = Binary{Op: op, Left: left, Right: p.primary()}
	}
	return left
}

func (p *expressionParser) primary() Expr {
	if p.bad != nil {
		return nil
	}
	if p.punct("(") {
		inner := p.or()
		if p.bad != nil {
			return nil
		}
		if !p.punct(")") {
			return p.fail("is not allowed here; expected )")
		}
		return Paren{Inner: inner}
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
		return p.fail("is a function; check expressions have no functions")
	}
	p.i++
	p.refs = append(p.refs, t)
	return ColumnRef{Name: t.text}
}

// literal reads a literal: an optionally negative number, a string, true,
// false or null.
func (p *expressionParser) literal() (Literal, bool) {
	if p.i >= len(p.tokens) {
		return Literal{}, false
	}
	t := p.tokens[p.i]
	switch {
	case t.kind == tokenNumber:
		p.i++
		return Literal{Text: canonicalNumber(t.text)}, true
	case t.is(tokenOperator, "-") && p.i+1 < len(p.tokens) && p.tokens[p.i+1].kind == tokenNumber:
		p.i += 2
		return Literal{Text: canonicalNumber("-" + p.tokens[p.i-1].text)}, true
	case t.kind == tokenString:
		p.i++
		return Literal{Text: quote(t.text)}, true
	case t.is(tokenWord, "true"), t.is(tokenWord, "false"), t.is(tokenWord, "null"):
		p.i++
		return Literal{Text: t.text}, true
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
	case Not:
		b.WriteString("not ")
		writeExpr(b, e.Operand)
	case Binary:
		writeExpr(b, e.Left)
		b.WriteString(" " + e.Op + " ")
		writeExpr(b, e.Right)
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
	case Between:
		writeExpr(b, e.Operand)
		if e.Negated {
			b.WriteString(" not")
		}
		b.WriteString(" between ")
		writeExpr(b, e.Low)
		b.WriteString(" and ")
		writeExpr(b, e.High)
	case IsNull:
		writeExpr(b, e.Operand)
		if e.Negated {
			b.WriteString(" is not null")
		} else {
			b.WriteString(" is null")
		}
	case Paren:
		b.WriteString("(")
		writeExpr(b, e.Inner)
		b.WriteString(")")
	}
}
