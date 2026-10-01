package dbspec

import "strings"

// checkTyper validates the types of one check predicate of table t and
// rewrites its literals into the canonical default form of the column they
// meet (docs/dbspec.md "Checks"). It keeps every diagnostic; the caller
// reports the first in source order.
type checkTyper struct {
	v          *validator
	t          *tableNode
	propagated map[string]bool
	out        []Diagnostic
}

func (c *checkTyper) add(at token, format string, args ...any) {
	c.out = append(c.out, diagnosticAt(RuleCheck, at, format, args...))
}

// column resolves a column operand. It reports an unknown column, a column of
// a propagating foreign key and a bytes column, and returns nil for a column
// whose type cannot take part in the predicate.
func (c *checkTyper) column(ref ColumnRef) *columnNode {
	before := len(c.v.out)
	col := c.v.columnRef(c.t, ref.at, RuleCheck)
	if len(c.v.out) > before {
		c.out = append(c.out, c.v.out[before:]...)
		c.v.out = c.v.out[:before]
	}
	if col == nil {
		return nil
	}
	if c.propagated[ref.Name] {
		c.add(ref.at, "column %q belongs to a foreign key with cascade or set_null", ref.Name)
		return nil
	}
	if !col.typ.valid {
		return nil
	}
	if col.typ.typ.Kind == TypeBytes {
		c.add(ref.at, "bytes column %q cannot be part of a check", ref.Name)
		return nil
	}
	return col
}

// literal rewrites l into the canonical default form of a column of type typ.
func (c *checkTyper) literal(l Literal, typ Type) Literal {
	text, ok := checkLiteral(typ, l.at)
	if !ok {
		c.add(l.at, "%s is not a %s value", l.at.describe(), typ)
		return l
	}
	return Literal{Text: text, at: l.at}
}

// checkLiteral is the canonical default literal of the type; a text column
// takes the varchar form without a length.
func checkLiteral(typ Type, v token) (string, bool) {
	if typ.Kind == TypeText {
		if v.kind != tokenString || strings.ContainsRune(v.text, 0) {
			return "", false
		}
		return quote(v.text), true
	}
	if v.kind == tokenWord && v.text == "now" {
		return "", false
	}
	return canonicalDefault(typ, v)
}

// meets reports whether two column types compare alike on the three
// databases.
func meets(a, b Type) bool {
	switch {
	case isInteger(a):
		return isInteger(b)
	case a.Kind == TypeDecimal:
		return b.Kind == TypeDecimal && a.Scale == b.Scale
	case a.Kind == TypeVarchar || a.Kind == TypeText:
		return b.Kind == TypeVarchar || b.Kind == TypeText
	case a.Kind == TypeTime || a.Kind == TypeDatetime:
		return b.Kind == a.Kind && a.Precision == b.Precision
	}
	return a.Kind == b.Kind
}

var orderings = map[string]bool{"<": true, "<=": true, ">": true, ">=": true}

// isBoolLiteral reports whether e is the literal true or false.
func isBoolLiteral(e Expr) bool {
	l, ok := e.(Literal)
	return ok && l.at.kind == tokenWord && (l.at.text == "true" || l.at.text == "false")
}

// predicate types e as a predicate and returns it with canonical literals.
func (c *checkTyper) predicate(e Expr) Expr {
	switch e := e.(type) {
	case Binary:
		if e.Op == "and" || e.Op == "or" {
			return Binary{Op: e.Op, Left: c.predicate(e.Left), Right: c.predicate(e.Right), at: e.at}
		}
		return c.comparison(e)
	case Not:
		return Not{Operand: c.predicate(e.Operand)}
	case Paren:
		return Paren{Inner: c.predicate(e.Inner)}
	case ColumnRef:
		if col := c.column(e); col != nil && col.typ.typ.Kind != TypeBool {
			c.add(e.at, "column %q is %s; only a bool column is a predicate by itself", e.Name, col.typ.typ)
		}
		return e
	case IsNull:
		c.subject(e.Operand)
		return e
	case In:
		col := c.subject(e.Operand)
		list := make([]Literal, len(e.List))
		for i, l := range e.List {
			list[i] = l
			if col != nil {
				list[i] = c.literal(l, col.typ.typ)
			}
		}
		return In{Operand: e.Operand, Negated: e.Negated, List: list}
	case Between:
		col := c.subject(e.Operand)
		out := e
		if col != nil {
			if col.typ.typ.Kind == TypeBool {
				c.add(e.at, "between does not order bool values")
				return e
			}
			out.Low = c.literal(e.Low.(Literal), col.typ.typ)
			out.High = c.literal(e.High.(Literal), col.typ.typ)
		}
		return out
	}
	return e
}

// subject resolves the column of an in, between or is null predicate; reading
// has rejected a literal there.
func (c *checkTyper) subject(e Expr) *columnNode {
	return c.column(e.(ColumnRef))
}

// comparison types `<left> <op> <right>`, of which reading has made at least
// one side a column: a literal takes the column's default form, and two
// columns meet.
func (c *checkTyper) comparison(e Binary) Expr {
	left, leftColumn := e.Left.(ColumnRef)
	right, rightColumn := e.Right.(ColumnRef)
	var lc, rc *columnNode
	if leftColumn {
		lc = c.column(left)
	}
	if rightColumn {
		rc = c.column(right)
	}
	typed := lc
	if typed == nil {
		typed = rc
	}
	if (leftColumn && lc == nil) || (rightColumn && rc == nil) {
		return e
	}
	if orderings[e.Op] && (typed.typ.typ.Kind == TypeBool || isBoolLiteral(e.Left) || isBoolLiteral(e.Right)) {
		c.add(e.at, "%s does not order bool values", e.Op)
	}
	out := e
	switch {
	case leftColumn && rightColumn:
		if !meets(lc.typ.typ, rc.typ.typ) {
			c.add(right.at, "column %q is %s and does not meet %s", right.Name, rc.typ.typ, lc.typ.typ)
		}
	case leftColumn:
		out.Right = c.literal(e.Right.(Literal), lc.typ.typ)
	default:
		out.Left = c.literal(e.Left.(Literal), rc.typ.typ)
	}
	return out
}
