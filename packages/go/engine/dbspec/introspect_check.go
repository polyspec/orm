package dbspec

import (
	"fmt"
	"strings"
)

// decodeCheck reads the dialect catalog's check expression as dbspec predicate text
// (docs/spec/dialects.md "Introspection", "Checks"). columns are the table's columns
// with their types, and a literal is read as a value of the column it meets. An expression that cannot be read is
// an error.
func decodeCheck(dialect Dialect, text string, columns map[string]Type) (string, error) {
	if dialect == DialectMySQL {
		text = unescapeMySQLClause(text)
	}
	if dialect == DialectPostgres {
		inner, ok := strings.CutPrefix(text, "CHECK ")
		if !ok {
			return "", fmt.Errorf("constraint definition %q does not start with CHECK", text)
		}
		text = inner
	}
	tokens, err := checkTokens(dialect, text)
	if err != nil {
		return "", err
	}
	d := &checkDecoder{tokens: tokens, columns: columns, dialect: dialect}
	node, err := d.expression()
	if err != nil {
		return "", err
	}
	if d.i != len(d.tokens) {
		return "", fmt.Errorf("unexpected %q", d.tokens[d.i].text)
	}
	predicate, ok := node.(cPredicate)
	if !ok {
		return "", fmt.Errorf("an operand alone is not a predicate")
	}
	return d.write(predicate)
}

// unescapeMySQLClause undoes the second escape that CHECK_CLAUSE adds to string literals:
// `\\` becomes `\`, and `\'` becomes `'`.
func unescapeMySQLClause(text string) string {
	var b strings.Builder
	for i := 0; i < len(text); i++ {
		if text[i] == '\\' && i+1 < len(text) && (text[i+1] == '\\' || text[i+1] == '\'') {
			b.WriteByte(text[i+1])
			i++
			continue
		}
		b.WriteByte(text[i])
	}
	return b.String()
}

type cToken struct {
	kind string // ident, word, number, string, op, punct
	text string
}

func checkTokens(dialect Dialect, text string) ([]cToken, error) {
	var out []cToken
	for i := 0; i < len(text); {
		ch := text[i]
		switch {
		case ch == ' ':
			i++
		case ch == '`' || ch == '"':
			j := strings.IndexByte(text[i+1:], ch)
			if j < 0 {
				return nil, fmt.Errorf("unclosed identifier")
			}
			out = append(out, cToken{"ident", text[i+1 : i+1+j]})
			i += j + 2
		case ch == '\'':
			value, n, err := readSQLString(dialect, text[i:])
			if err != nil {
				return nil, err
			}
			out = append(out, cToken{"string", value})
			i += n
		case ch >= '0' && ch <= '9':
			j := i
			for j < len(text) && (text[j] >= '0' && text[j] <= '9' || text[j] == '.') {
				j++
			}
			out = append(out, cToken{"number", text[i:j]})
			i = j
		case ch == '_' || ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z':
			j := i
			for j < len(text) && (text[j] == '_' || text[j] >= 'a' && text[j] <= 'z' || text[j] >= 'A' && text[j] <= 'Z' || text[j] >= '0' && text[j] <= '9') {
				j++
			}
			word := text[i:j]
			// The character set introducer before a MySQL string is not a value.
			if dialect == DialectMySQL && strings.HasPrefix(word, "_") && j < len(text) && text[j] == '\'' {
				i = j
				continue
			}
			out = append(out, cToken{"word", word})
			i = j
		case strings.HasPrefix(text[i:], "::"):
			out = append(out, cToken{"op", "::"})
			i += 2
		case strings.HasPrefix(text[i:], "<>") || strings.HasPrefix(text[i:], "<=") || strings.HasPrefix(text[i:], ">="):
			out = append(out, cToken{"op", text[i : i+2]})
			i += 2
		case ch == '=' || ch == '<' || ch == '>' || ch == '-':
			out = append(out, cToken{"op", string(ch)})
			i++
		case ch == '(' || ch == ')' || ch == ',' || ch == '[' || ch == ']':
			out = append(out, cToken{"punct", string(ch)})
			i++
		default:
			return nil, fmt.Errorf("unexpected character %q", ch)
		}
	}
	return out, nil
}

// readSQLString reads the string literal at the start of text and returns its value and length.
// PostgreSQL and SQLite escape only by doubling the quote, and MySQL also uses backslash escapes.
func readSQLString(dialect Dialect, text string) (string, int, error) {
	var b strings.Builder
	for i := 1; i < len(text); i++ {
		ch := text[i]
		switch {
		case ch == '\'' && i+1 < len(text) && text[i+1] == '\'':
			b.WriteByte('\'')
			i++
		case ch == '\'':
			return b.String(), i + 1, nil
		case ch == '\\' && dialect == DialectMySQL && i+1 < len(text):
			i++
			switch text[i] {
			case '0':
				b.WriteByte(0)
			case 'b':
				b.WriteByte('\b')
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case 'Z':
				b.WriteByte(26)
			default:
				b.WriteByte(text[i])
			}
		default:
			b.WriteByte(ch)
		}
	}
	return "", 0, fmt.Errorf("unclosed string literal")
}

type cNode interface{}

// cOperand is a column or a literal. kind is column, number, string, or bool.
type cOperand struct{ kind, text string }

// cPredicate is a comparison, in, is null, and, or.
type cPredicate struct {
	op       string // and, or, compare, in, null
	left     cNode
	right    cNode
	operator string
	list     []cOperand
	negated  bool
}

type checkDecoder struct {
	tokens  []cToken
	i       int
	columns map[string]Type
	dialect Dialect
}

func (d *checkDecoder) peek() cToken {
	if d.i < len(d.tokens) {
		return d.tokens[d.i]
	}
	return cToken{}
}

func (d *checkDecoder) word(text string) bool {
	t := d.peek()
	if t.kind == "word" && strings.EqualFold(t.text, text) {
		d.i++
		return true
	}
	return false
}

func (d *checkDecoder) punct(text string) bool {
	if t := d.peek(); t.kind == "punct" && t.text == text {
		d.i++
		return true
	}
	return false
}

func (d *checkDecoder) expect(text string) error {
	if !d.punct(text) {
		return fmt.Errorf("expected %q at token %d", text, d.i)
	}
	return nil
}

func (d *checkDecoder) expression() (cNode, error) {
	left, err := d.and()
	if err != nil {
		return nil, err
	}
	for d.word("or") {
		right, err := d.and()
		if err != nil {
			return nil, err
		}
		left = cPredicate{op: "or", left: left, right: right}
	}
	return left, nil
}

func (d *checkDecoder) and() (cNode, error) {
	left, err := d.predicate()
	if err != nil {
		return nil, err
	}
	for d.word("and") {
		right, err := d.predicate()
		if err != nil {
			return nil, err
		}
		left = cPredicate{op: "and", left: left, right: right}
	}
	return left, nil
}

// predicate reads one predicate that starts with a parenthesized expression or an operand.
func (d *checkDecoder) predicate() (cNode, error) {
	left, err := d.term()
	if err != nil {
		return nil, err
	}
	operand, isOperand := left.(cOperand)
	if !isOperand {
		return left, nil
	}
	t := d.peek()
	switch {
	case t.kind == "op" && (t.text == "=" || t.text == "<>" || t.text == "<" || t.text == "<=" || t.text == ">" || t.text == ">="):
		d.i++
		if d.word("any") || d.word("all") {
			list, err := d.array()
			if err != nil {
				return nil, err
			}
			if t.text == "=" {
				return cPredicate{op: "in", left: operand, list: list}, nil
			}
			if t.text == "<>" {
				return cPredicate{op: "in", left: operand, list: list, negated: true}, nil
			}
			return nil, fmt.Errorf("%s with ANY or ALL", t.text)
		}
		right, err := d.term()
		if err != nil {
			return nil, err
		}
		if _, ok := right.(cOperand); !ok {
			return nil, fmt.Errorf("a comparison with a predicate")
		}
		return cPredicate{op: "compare", left: operand, right: right, operator: t.text}, nil
	case d.word("is"):
		negated := d.word("not")
		if !d.word("null") {
			return nil, fmt.Errorf("expected null after is")
		}
		return cPredicate{op: "null", left: operand, negated: negated}, nil
	case d.word("not"):
		if !d.word("in") {
			return nil, fmt.Errorf("not outside not in")
		}
		list, err := d.list()
		return cPredicate{op: "in", left: operand, list: list, negated: true}, err
	case d.word("in"):
		list, err := d.list()
		return cPredicate{op: "in", left: operand, list: list}, err
	}
	return operand, nil
}

// term reads a parenthesized expression or an operand, and the cast after it. If what is inside the parentheses is one
// operand.
func (d *checkDecoder) term() (cNode, error) {
	var node cNode
	if d.punct("(") {
		inner, err := d.expression()
		if err != nil {
			return nil, err
		}
		if err := d.expect(")"); err != nil {
			return nil, err
		}
		node = inner
	} else {
		operand, err := d.operand()
		if err != nil {
			return nil, err
		}
		node = operand
	}
	for d.peek().kind == "op" && d.peek().text == "::" {
		d.i++
		typeName := d.castType()
		operand, ok := node.(cOperand)
		if !ok {
			return nil, fmt.Errorf("a cast of a predicate")
		}
		if operand.kind == "string" && numericCast(typeName) {
			operand.kind = "number"
		}
		node = operand
	}
	return node, nil
}

// castType reads the type name after `::`: words, and (n), [].
func (d *checkDecoder) castType() string {
	var words []string
	for {
		t := d.peek()
		switch {
		case t.kind == "word" && !strings.EqualFold(t.text, "and") && !strings.EqualFold(t.text, "or") &&
			!strings.EqualFold(t.text, "is") && !strings.EqualFold(t.text, "not") && !strings.EqualFold(t.text, "in"):
			words = append(words, t.text)
			d.i++
		case t.kind == "punct" && t.text == "[" && d.i+1 < len(d.tokens) && d.tokens[d.i+1].text == "]":
			d.i += 2
		default:
			return strings.Join(words, " ")
		}
	}
}

func numericCast(typeName string) bool {
	switch typeName {
	case "smallint", "integer", "bigint", "numeric", "double precision", "real":
		return true
	}
	return false
}

func (d *checkDecoder) operand() (cOperand, error) {
	t := d.peek()
	switch {
	case t.kind == "ident":
		d.i++
		return cOperand{"column", t.text}, nil
	case t.kind == "number":
		d.i++
		return cOperand{"number", t.text}, nil
	case t.kind == "string":
		d.i++
		return cOperand{"string", t.text}, nil
	case t.kind == "op" && t.text == "-":
		d.i++
		if d.punct("(") {
			n := d.peek()
			if n.kind != "number" {
				return cOperand{}, fmt.Errorf("expected a number after -(")
			}
			d.i++
			if err := d.expect(")"); err != nil {
				return cOperand{}, err
			}
			return cOperand{"number", "-" + n.text}, nil
		}
		n := d.peek()
		if n.kind != "number" {
			return cOperand{}, fmt.Errorf("expected a number after -")
		}
		d.i++
		return cOperand{"number", "-" + n.text}, nil
	case t.kind == "word" && (strings.EqualFold(t.text, "true") || strings.EqualFold(t.text, "false")):
		d.i++
		return cOperand{"bool", strings.ToLower(t.text)}, nil
	case t.kind == "word":
		d.i++
		return cOperand{"column", t.text}, nil
	}
	return cOperand{}, fmt.Errorf("unexpected %q", t.text)
}

// list reads the (a, b, ...) after in.
func (d *checkDecoder) list() ([]cOperand, error) {
	if err := d.expect("("); err != nil {
		return nil, err
	}
	return d.literals(")", "an in list holds literals only")
}

// literals reads the literal operands separated by commas, up to and including
// the closing punctuation closer; a column or other operand that is not a
// literal fails with msg.
func (d *checkDecoder) literals(closer, msg string) ([]cOperand, error) {
	var out []cOperand
	for {
		node, err := d.term()
		if err != nil {
			return nil, err
		}
		operand, ok := node.(cOperand)
		if !ok || operand.kind == "column" {
			return nil, fmt.Errorf("%s", msg)
		}
		out = append(out, operand)
		if d.punct(closer) {
			return out, nil
		}
		if err := d.expect(","); err != nil {
			return nil, err
		}
	}
}

// array reads the (ARRAY[...]) or ((ARRAY[...])::type[]) after PostgreSQL's ANY or ALL,
// and it is read.
func (d *checkDecoder) array() ([]cOperand, error) {
	if err := d.expect("("); err != nil {
		return nil, err
	}
	wrapped := d.punct("(")
	if !d.word("array") {
		return nil, fmt.Errorf("expected ARRAY")
	}
	if err := d.expect("["); err != nil {
		return nil, err
	}
	out, err := d.literals("]", "an array holds literals only")
	if err != nil {
		return nil, err
	}
	if wrapped {
		if err := d.expect(")"); err != nil {
			return nil, err
		}
		if d.peek().text == "::" {
			d.i++
			d.castType()
		}
	}
	return out, d.expect(")")
}

// write writes the predicate as dbspec text. It may have more parentheses than needed;
// the canonical form is decided by parse.
func (d *checkDecoder) write(p cPredicate) (string, error) {
	switch p.op {
	case "and", "or":
		left, err := d.side(p.left)
		if err != nil {
			return "", err
		}
		right, err := d.side(p.right)
		if err != nil {
			return "", err
		}
		return "(" + left + " " + p.op + " " + right + ")", nil
	case "compare":
		left, err := operandOf(p.left)
		if err != nil {
			return "", err
		}
		right, err := operandOf(p.right)
		if err != nil {
			return "", err
		}
		typ := d.typeOf(left, right)
		l, err := d.operandText(left, typ)
		if err != nil {
			return "", err
		}
		r, err := d.operandText(right, typ)
		if err != nil {
			return "", err
		}
		return l + " " + p.operator + " " + r, nil
	case "in":
		left, err := operandOf(p.left)
		if err != nil {
			return "", err
		}
		typ := d.typeOf(left, cOperand{})
		l, err := d.operandText(left, typ)
		if err != nil {
			return "", err
		}
		items := make([]string, len(p.list))
		for i, item := range p.list {
			if items[i], err = d.operandText(item, typ); err != nil {
				return "", err
			}
		}
		keyword := " in ("
		if p.negated {
			keyword = " not in ("
		}
		return l + keyword + strings.Join(items, ", ") + ")", nil
	case "null":
		left, err := operandOf(p.left)
		if err != nil {
			return "", err
		}
		l, err := d.operandText(left, Type{})
		if err != nil {
			return "", err
		}
		if p.negated {
			return l + " is not null", nil
		}
		return l + " is null", nil
	}
	return "", fmt.Errorf("unknown predicate %s", p.op)
}

// operandOf returns the value of a predicate operand; a predicate in that place is an error of the file.
func operandOf(n cNode) (cOperand, error) {
	op, ok := n.(cOperand)
	if !ok {
		return cOperand{}, fmt.Errorf("a predicate stands where an operand is expected")
	}
	return op, nil
}

func (d *checkDecoder) side(n cNode) (string, error) {
	p, ok := n.(cPredicate)
	if !ok {
		return "", fmt.Errorf("an operand alone is not a predicate")
	}
	return d.write(p)
}

func (d *checkDecoder) typeOf(a, b cOperand) Type {
	for _, o := range []cOperand{a, b} {
		if o.kind == "column" {
			return d.columns[o.text]
		}
	}
	return Type{}
}

// operandText writes an operand in dbspec notation. The 1 and 0 of a bool column become true and
// false, and an integer of a SQLite decimal is the value divided by the scale.
func (d *checkDecoder) operandText(o cOperand, typ Type) (string, error) {
	switch o.kind {
	case "column":
		if _, ok := d.columns[o.text]; !ok {
			return "", fmt.Errorf("unknown column %s", o.text)
		}
		return o.text, nil
	case "string":
		return quote(o.text), nil
	case "bool":
		return o.text, nil
	}
	switch {
	case typ.Kind == TypeBool && o.text == "1":
		return "true", nil
	case typ.Kind == TypeBool && o.text == "0":
		return "false", nil
	case typ.Kind == TypeDecimal && d.dialect == DialectSQLite:
		return unscaledDecimal(o.text, typ.Scale), nil
	}
	return o.text, nil
}

// unscaledDecimal writes an integer text multiplied by 10^scale as a decimal with scale digits.
func unscaledDecimal(text string, scale int) string {
	negative := strings.HasPrefix(text, "-")
	digits := strings.TrimPrefix(text, "-")
	if scale > 0 {
		if len(digits) <= scale {
			digits = strings.Repeat("0", scale-len(digits)+1) + digits
		}
		digits = digits[:len(digits)-scale] + "." + digits[len(digits)-scale:]
	}
	if negative {
		return "-" + digits
	}
	return digits
}
