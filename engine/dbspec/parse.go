package dbspec

import (
	"slices"
	"strconv"
	"strings"
)

// The parse tree keeps every token with its position, so validation can
// point at the token that breaks a rule. A line with a syntax error is
// dropped and contributes only that error, except that a `table`, `diagram`
// or `settings` line still opens its block and a `}` line still closes it.
// The names on a dropped line are remembered, so references to them report
// nothing more.

type documentNode struct {
	name        token
	uses        []*useNode
	tables      []*tableNode
	diagrams    []*diagramNode
	trailing    []string
	constraints []token // index, unique, foreign key and check names in source order
}

type useNode struct {
	comments []string
	keyword  token
	document token
	tables   []token
}

type tableNode struct {
	comments    []string
	keyword     token
	name        token
	brace       token
	failed      bool // the table line had a syntax error
	failedNames map[string]bool
	failedLines int // column lines with a syntax error
	failedKey   bool
	failedPK    bool
	columns     []*columnNode
	byName      map[string]*columnNode
	primaryKeys []*keyNode
	uniques     []*keyNode
	indexes     []*keyNode
	foreignKeys []*foreignKeyNode
	checks      []*checkNode
	settings    *settingsNode
	closing     []string
	phase       int
	columnLines int
}

// anchor is the token that a rule about the whole table points at.
func (t *tableNode) anchor() token {
	if t.name.line != 0 {
		return t.name
	}
	return t.keyword
}

// failedName reports whether a column or foreign key line with this name had
// a syntax error.
func (t *tableNode) failedName(name string) bool { return t.failedNames[name] }

func (t *tableNode) markFailed(name token) {
	if name.line == 0 {
		return
	}
	if t.failedNames == nil {
		t.failedNames = map[string]bool{}
	}
	t.failedNames[name.text] = true
}

// column returns the first column with the given name.
func (t *tableNode) column(name string) *columnNode {
	if t.byName == nil {
		t.byName = make(map[string]*columnNode, len(t.columns))
		for _, c := range t.columns {
			if _, ok := t.byName[c.name.text]; !ok {
				t.byName[c.name.text] = c
			}
		}
	}
	return t.byName[name]
}

const (
	phaseColumns = iota
	phaseConstraints
	phaseAfterSettings
)

type columnNode struct {
	comments []string
	name     token
	typ      typeNode
	null     *token
	identity *token
	dflt     *token
	value    *token
	literal  string // canonical default literal, set by validation
}

type typeNode struct {
	word  token
	typ   Type
	valid bool
}

type keyNode struct {
	comments   []string
	keyword    token
	name       token
	columns    []token
	descending []bool
}

type foreignKeyNode struct {
	comments   []string
	keyword    token
	name       token
	columns    []token
	target     token
	references []token
	onDelete   *token
	onUpdate   *token
}

func actionOf(t *token) Action {
	if t == nil {
		return ActionRestrict
	}
	return Action(t.text)
}

// propagates reports whether the foreign key has a cascade or set_null action.
func (f *foreignKeyNode) propagates() bool {
	for _, a := range []Action{actionOf(f.onDelete), actionOf(f.onUpdate)} {
		if a == ActionCascade || a == ActionSetNull {
			return true
		}
	}
	return false
}

type checkNode struct {
	comments []string
	keyword  token
	name     token
	expr     Expr
	refs     []token
}

type settingsNode struct {
	comments []string
	keyword  token
	lines    []*settingNode
	closing  []string
}

type settingNode struct {
	comments []string
	keyword  token
	args     []token
	// lists는 audit의 exclude와 include 목록이다. 둘 다 쓴 setting은 검사가
	// 거부한다.
	lists []columnList
	// form은 state_machine 줄의 종류다: transition, terminal, initial, history 또는 limit.
	form string
}

// columnList는 `exclude (<column>, ...)`나 `include (<column>, ...)`다.
type columnList struct {
	keyword token
	columns []token
}

type diagramNode struct {
	comments []string
	keyword  token
	name     token
	failed   bool
	entries  []*entryNode
	closing  []string
}

type entryNode struct {
	comments []string
	table    token
	x        token
	y        token
}

type parsedDocument struct {
	document    *documentNode
	diagnostics []Diagnostic
	stopped     bool
}

const (
	stateTop = iota
	stateTable
	stateSettings
	stateDiagram
)

const (
	topUses = iota
	topTables
	topDiagrams
)

type parser struct {
	out         *parsedDocument
	doc         *documentNode
	state       int
	topPhase    int
	table       *tableNode
	settings    *settingsNode
	diagram     *diagramNode
	open        token
	pending     []string
	tables      int
	columns     int
	foreignKeys int
}

func (p *parser) add(d Diagnostic) { p.out.diagnostics = append(p.out.diagnostics, d) }

// stop records an encoding, header or limit error. It stops parsing; the
// diagnostics found before it stay, and whole-document validation does not
// run.
func (p *parser) stop(d Diagnostic) {
	p.add(d)
	p.out.stopped = true
}

// names checks a defining name on a line that parsed.
func (p *parser) names(t token) {
	p.out.diagnostics = append(p.out.diagnostics, nameDiagnostics(t)...)
}

func (p *parser) takeComments() []string {
	c := p.pending
	p.pending = nil
	return c
}

// parseStructure tokenizes and parses text into a parse tree. It reports
// encoding, header, limit, syntax, order and type errors, and errors of check
// expressions and unknown settings; validate reports the rest.
func parseStructure(text string) *parsedDocument {
	p := &parser{out: &parsedDocument{document: &documentNode{}}}
	p.doc = p.out.document
	lines, bad := splitSource(text)
	if bad != nil && len(lines) == 0 {
		p.stop(*bad)
		return p.out
	}
	if !p.header(lines) {
		return p.out
	}
	defer func() {
		if bad != nil && !p.out.stopped {
			p.stop(*bad)
		}
	}()
	for i := 1; i < len(lines) && !p.out.stopped; i++ {
		raw := lines[i]
		trimmed := strings.TrimLeft(raw, " ")
		if trimmed == "" {
			continue
		}
		if trimmed[0] == '#' {
			p.pending = append(p.pending, trimmed)
			continue
		}
		tokens, end, lexErr := lexLine(raw, i+1)
		if lexErr != nil {
			tokens = lexRecover(raw, i+1)
		}
		c := &cursor{p: p, tokens: tokens, line: i + 1, end: end, lexErr: lexErr}
		if len(tokens) == 0 {
			c.fail("a statement")
			continue
		}
		switch p.state {
		case stateTop:
			p.topLine(c)
		case stateTable:
			p.tableLine(c)
		case stateSettings:
			p.settingsLine(c)
		case stateDiagram:
			p.diagramLine(c)
		}
	}
	if p.out.stopped {
		return p.out
	}
	if bad != nil {
		return p.out
	}
	if p.state != stateTop {
		p.add(diagnosticAt(RuleSyntax, p.open, "block opened at this %s is not closed", p.open.describe()))
	}
	p.doc.trailing = p.takeComments()
	return p.out
}

// isHeaderNameRune reports whether r continues the document name of the
// header: an ASCII letter, digit or underscore.
func isHeaderNameRune(r rune) bool {
	return r == '_' || ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z') || ('0' <= r && r <= '9')
}

func (p *parser) header(lines []string) bool {
	fail := func(line, col int, message string) bool {
		p.stop(Diagnostic{Rule: RuleHeader, Line: line, Column: col, Message: message})
		return false
	}
	if len(lines) == 0 {
		return fail(1, 1, "document is empty; the first line must be dbspec 1 <document>")
	}
	// The error points at the first character that departs from
	// "dbspec 1 <name>", or one past the line end when a part is missing.
	const expected = "the first line is exactly dbspec 1 <document>"
	line := []rune(lines[0])
	col := 1
	for _, r := range "dbspec 1 " {
		if col > len(line) || line[col-1] != r {
			return fail(1, col, expected)
		}
		col++
	}
	start := col
	for col <= len(line) && isHeaderNameRune(line[col-1]) {
		col++
	}
	if col == start || col <= len(line) {
		return fail(1, col, expected)
	}
	tokens, _, _ := lexLine(lines[0], 1)
	p.doc.name = tokens[2]
	for _, d := range nameDiagnostics(tokens[2]) {
		p.add(d)
	}
	return true
}

// cursor reads the tokens of one line. Its first failure reports one syntax
// error; the caller then drops the line.
type cursor struct {
	p      *parser
	tokens []token
	i      int
	line   int
	end    int
	lexErr *Diagnostic
	failed bool
}

func (c *cursor) more() bool { return c.i < len(c.tokens) }

func (c *cursor) peekIs(kind tokenKind, text string) bool {
	return c.more() && c.tokens[c.i].is(kind, text)
}

func (c *cursor) fail(expected string) bool {
	c.failed = true
	switch {
	case c.lexErr != nil:
		c.p.add(*c.lexErr)
	case c.more():
		t := c.tokens[c.i]
		c.p.add(diagnosticAt(RuleSyntax, t, "unexpected %s, expected %s", t.describe(), expected))
	default:
		c.p.add(Diagnostic{Rule: RuleSyntax, Line: c.line, Column: c.end, Message: "line ends, expected " + expected})
	}
	return false
}

func (c *cursor) next() token {
	t := c.tokens[c.i]
	c.i++
	return t
}

func (c *cursor) keyword(text string) bool {
	if c.peekIs(tokenWord, text) {
		c.i++
		return true
	}
	return c.fail("'" + text + "'")
}

func (c *cursor) punct(text string) bool {
	if c.peekIs(tokenPunct, text) {
		c.i++
		return true
	}
	return c.fail("'" + text + "'")
}

// arrow consumes `->`, which the lexer writes as two operator tokens.
func (c *cursor) arrow() bool {
	if c.peekIs(tokenOperator, "-") && c.i+1 < len(c.tokens) && c.tokens[c.i+1].is(tokenOperator, ">") {
		c.i += 2
		return true
	}
	return c.fail("'->'")
}

// formAhead는 keyword 글자가 다음에 오고 전환의 from state가 아닌지 보고한다:
// 뒤에 전환 화살표 `->`가 오면 그 글자는 state 이름이다.
func (c *cursor) formAhead(text string) bool {
	if !c.peekIs(tokenWord, text) {
		return false
	}
	next := c.i + 1
	return next >= len(c.tokens) || !c.tokens[next].is(tokenOperator, "-")
}

// oneOf는 주어진 word 가운데 하나인 word를 소비하고, 아니면 what으로 실패한다.
func (c *cursor) oneOf(what string, words ...string) (token, bool) {
	if c.more() && c.tokens[c.i].kind == tokenWord && slices.Contains(words, c.tokens[c.i].text) {
		return c.next(), true
	}
	return token{}, c.fail(what)
}

// quoted는 string literal 하나를 읽는다. 그 text는 따옴표를 뺀 값이다.
func (c *cursor) quoted(what string) (token, bool) {
	if c.more() && c.tokens[c.i].kind == tokenString {
		return c.next(), true
	}
	return token{}, c.fail(what)
}

// optional consumes the keyword text when it comes next.
func (c *cursor) optional(text string) *token {
	if c.peekIs(tokenWord, text) {
		t := c.next()
		return &t
	}
	return nil
}

// name reads a name token. A number is read as a name so that the name rules
// report it.
func (c *cursor) name(what string) (token, bool) {
	if c.more() && (c.tokens[c.i].kind == tokenWord || c.tokens[c.i].kind == tokenNumber) {
		return c.next(), true
	}
	return token{}, c.fail(what)
}

// value reads one literal token; a '-' before a number makes it negative.
func (c *cursor) value(what string, allowString bool) (token, bool) {
	if c.peekIs(tokenOperator, "-") {
		minus := c.tokens[c.i]
		if c.i+1 < len(c.tokens) && c.tokens[c.i+1].kind == tokenNumber {
			c.i += 2
			return token{kind: tokenNumber, text: "-" + c.tokens[c.i-1].text, line: minus.line, col: minus.col}, true
		}
		c.i++
		return token{}, c.fail("a number after '-'")
	}
	if c.more() {
		switch c.tokens[c.i].kind {
		case tokenWord, tokenNumber:
			return c.next(), true
		case tokenString:
			if allowString {
				return c.next(), true
			}
		}
	}
	return token{}, c.fail(what)
}

func (c *cursor) done() bool {
	if !c.more() && c.lexErr == nil {
		return true
	}
	return c.fail("the end of the line")
}

// names reads `( name [asc|desc], ... )`.
func (c *cursor) names(directions bool) ([]token, []bool, bool) {
	if !c.punct("(") {
		return nil, nil, false
	}
	var names []token
	var descending []bool
	for {
		n, ok := c.name("a column name")
		if !ok {
			return nil, nil, false
		}
		names = append(names, n)
		if directions {
			desc := false
			if c.optional("asc") == nil && c.optional("desc") != nil {
				desc = true
			}
			descending = append(descending, desc)
		}
		if c.peekIs(tokenPunct, ")") {
			c.i++
			return names, descending, true
		}
		if !c.peekIs(tokenPunct, ",") {
			return nil, nil, c.fail("',' or ')'")
		}
		c.i++
	}
}

func (p *parser) topLine(c *cursor) {
	first := c.tokens[0]
	switch {
	case first.is(tokenWord, "use"):
		p.useLine(c)
	case first.is(tokenWord, "table"):
		p.openTable(c)
	case first.is(tokenWord, "diagram"):
		p.openDiagram(c)
	default:
		c.fail("'use', 'table' or 'diagram'")
	}
}

func (p *parser) useLine(c *cursor) {
	keyword := c.next()
	u := &useNode{keyword: keyword}
	var ok bool
	if u.document, ok = c.name("a document name"); !ok || !c.punct("{") {
		return
	}
	for {
		t, ok := c.name("a table name")
		if !ok {
			return
		}
		u.tables = append(u.tables, t)
		if c.peekIs(tokenPunct, "}") {
			c.i++
			break
		}
		if !c.peekIs(tokenPunct, ",") {
			c.fail("',' or '}'")
			return
		}
		c.i++
	}
	if !c.done() {
		return
	}
	if p.topPhase > topUses {
		p.add(diagnosticAt(RuleOrder, keyword, "use lines come before table and diagram blocks"))
	}
	u.comments = p.takeComments()
	p.doc.uses = append(p.doc.uses, u)
}

func (p *parser) openTable(c *cursor) {
	keyword := c.next()
	p.tables++
	if p.tables > maxTables {
		p.stop(diagnosticAt(RuleLimit, keyword, "document has more than %d tables", maxTables))
		return
	}
	t := &tableNode{comments: p.takeComments(), keyword: keyword}
	p.doc.tables = append(p.doc.tables, t)
	p.state, p.table, p.open = stateTable, t, keyword
	outOfOrder := p.topPhase > topTables
	p.topPhase = max(p.topPhase, topTables)
	name, ok := c.name("a table name")
	if ok {
		t.name = name
	}
	if !ok || !c.punct("{") {
		t.failed = true
		return
	}
	t.brace = c.tokens[c.i-1]
	p.open = t.brace
	if !c.done() {
		t.failed = true
		return
	}
	p.names(name)
	if outOfOrder {
		p.add(diagnosticAt(RuleOrder, keyword, "table blocks come before diagram blocks"))
	}
}

func (p *parser) openDiagram(c *cursor) {
	keyword := c.next()
	d := &diagramNode{comments: p.takeComments(), keyword: keyword}
	p.doc.diagrams = append(p.doc.diagrams, d)
	p.state, p.diagram, p.open = stateDiagram, d, keyword
	p.topPhase = topDiagrams
	name, ok := c.name("a diagram name")
	if ok {
		d.name = name
	}
	if !ok || !c.punct("{") {
		d.failed = true
		return
	}
	p.open = c.tokens[c.i-1]
	if !c.done() {
		d.failed = true
		return
	}
	p.names(name)
}

func (p *parser) tableLine(c *cursor) {
	t := p.table
	first := c.tokens[0]
	switch {
	case first.is(tokenPunct, "}"):
		c.i++
		t.closing = p.takeComments()
		p.state, p.table = stateTop, nil
		c.done()
	case first.is(tokenWord, "settings"):
		keyword := c.next()
		s := &settingsNode{comments: p.takeComments(), keyword: keyword}
		duplicate := t.settings != nil
		if !duplicate {
			t.settings = s
		}
		p.state, p.settings, p.open = stateSettings, s, keyword
		if c.punct("{") {
			p.open = c.tokens[c.i-1]
		}
		if !c.failed && c.done() && duplicate {
			p.add(diagnosticAt(RuleOrder, keyword, "a table has at most one settings block, after its other lines"))
		}
	case first.is(tokenWord, "primary"), first.is(tokenWord, "unique"), first.is(tokenWord, "index"),
		first.is(tokenWord, "foreign"), first.is(tokenWord, "check"):
		p.constraintLine(c)
	default:
		p.columnLine(c)
	}
}

func (p *parser) constraintOrder(t *tableNode, keyword token) {
	if t.phase == phaseAfterSettings {
		p.add(diagnosticAt(RuleOrder, keyword, "key, index, foreign key and check lines come before the settings block"))
		return
	}
	t.phase = phaseConstraints
}

func (p *parser) constraintLine(c *cursor) {
	t := p.table
	keyword := c.next()
	var name token
	defer func() {
		if !c.failed {
			return
		}
		switch keyword.text {
		case "primary":
			t.failedPK = true
		case "unique", "index":
			t.failedKey = true
		case "foreign":
			t.markFailed(name)
		}
	}()
	switch keyword.text {
	case "primary":
		if !c.keyword("key") {
			return
		}
		columns, _, ok := c.names(false)
		if !ok || !c.done() {
			return
		}
		p.constraintOrder(t, keyword)
		t.primaryKeys = append(t.primaryKeys, &keyNode{comments: p.takeComments(), keyword: keyword, columns: columns})
	case "unique", "index":
		var ok bool
		name, ok = c.name("a " + keyword.text + " name")
		if !ok {
			return
		}
		columns, descending, ok := c.names(keyword.text == "index")
		if !ok || !c.done() {
			return
		}
		p.constraintOrder(t, keyword)
		p.names(name)
		k := &keyNode{comments: p.takeComments(), keyword: keyword, name: name, columns: columns, descending: descending}
		if keyword.text == "unique" {
			t.uniques = append(t.uniques, k)
		} else {
			t.indexes = append(t.indexes, k)
		}
		p.doc.constraints = append(p.doc.constraints, name)
	case "foreign":
		p.foreignKeys++
		if p.foreignKeys > maxForeignKeys {
			p.stop(diagnosticAt(RuleLimit, keyword, "document has more than %d foreign keys", maxForeignKeys))
			return
		}
		f := &foreignKeyNode{keyword: keyword}
		var ok bool
		if !c.keyword("key") {
			return
		}
		if f.name, ok = c.name("a foreign key name"); !ok {
			return
		}
		name = f.name
		if f.columns, _, ok = c.names(false); !ok || !c.keyword("references") {
			return
		}
		if f.target, ok = c.name("a table name"); !ok {
			return
		}
		if f.references, _, ok = c.names(false); !ok {
			return
		}
		if c.peekIs(tokenWord, "on") && c.i+1 < len(c.tokens) && c.tokens[c.i+1].is(tokenWord, "delete") {
			c.i += 2
			a, ok := c.name("an action")
			if !ok {
				return
			}
			f.onDelete = &a
		}
		if c.optional("on") != nil {
			if !c.keyword("update") {
				return
			}
			a, ok := c.name("an action")
			if !ok {
				return
			}
			f.onUpdate = &a
		}
		if !c.done() {
			return
		}
		p.constraintOrder(t, keyword)
		p.names(f.name)
		f.comments = p.takeComments()
		t.foreignKeys = append(t.foreignKeys, f)
		p.doc.constraints = append(p.doc.constraints, f.name)
	case "check":
		var ok bool
		name, ok = c.name("a check name")
		if !ok || !c.punct("(") {
			return
		}
		if c.lexErr != nil {
			c.i = len(c.tokens)
			c.fail("a check expression")
			return
		}
		rest := c.tokens[c.i:]
		if len(rest) == 0 || !rest[len(rest)-1].is(tokenPunct, ")") {
			c.i = len(c.tokens)
			c.fail("')' at the end of the check")
			return
		}
		p.constraintOrder(t, keyword)
		p.names(name)
		k := &checkNode{comments: p.takeComments(), keyword: keyword, name: name}
		expr, refs, bad := parseExpression(rest[:len(rest)-1], rest[len(rest)-1])
		if bad != nil {
			p.add(*bad)
		} else {
			k.expr, k.refs = expr, refs
		}
		t.checks = append(t.checks, k)
		p.doc.constraints = append(p.doc.constraints, name)
	}
}

func (p *parser) columnLine(c *cursor) {
	t := p.table
	first := c.tokens[0]
	t.columnLines++
	p.columns++
	if t.columnLines > maxTableColumns {
		p.stop(diagnosticAt(RuleLimit, first, "table has more than %d columns", maxTableColumns))
		return
	}
	if p.columns > maxColumns {
		p.stop(diagnosticAt(RuleLimit, first, "document has more than %d columns", maxColumns))
		return
	}
	col := &columnNode{}
	defer func() {
		if c.failed {
			t.failedLines++
			t.markFailed(col.name)
		}
	}()
	var ok bool
	if col.name, ok = c.name("a column name, key, index, foreign key, check, settings or '}'"); !ok {
		return
	}
	if !c.more() || c.tokens[c.i].kind != tokenWord {
		c.fail("a type")
		return
	}
	col.typ.word = c.next()
	var params []token
	if c.peekIs(tokenPunct, "(") {
		c.i++
		for {
			v, ok := c.value("a type parameter", false)
			if !ok {
				return
			}
			params = append(params, v)
			if c.peekIs(tokenPunct, ")") {
				c.i++
				break
			}
			if !c.peekIs(tokenPunct, ",") {
				c.fail("',' or ')'")
				return
			}
			c.i++
		}
	}
	col.null = c.optional("null")
	col.identity = c.optional("identity")
	if col.dflt = c.optional("default"); col.dflt != nil {
		v, ok := c.value("a default value", true)
		if !ok {
			return
		}
		col.value = &v
	}
	if !c.done() {
		return
	}
	if t.phase != phaseColumns {
		p.add(diagnosticAt(RuleOrder, col.name, "column lines come before key, index, foreign key, check and settings lines"))
	}
	p.names(col.name)
	col.comments = p.takeComments()
	var bad *Diagnostic
	col.typ.typ, bad = resolveType(col.typ.word, params)
	if bad != nil {
		p.add(*bad)
	} else {
		col.typ.valid = true
	}
	t.columns = append(t.columns, col)
}

// resolveType checks a type name and its parameters.
func resolveType(word token, params []token) (Type, *Diagnostic) {
	kind := TypeKind(word.text)
	count := 0
	switch kind {
	case TypeI16, TypeI32, TypeI64, TypeBool, TypeF64, TypeText, TypeBytes, TypeUUID, TypeDate:
	case TypeVarchar, TypeTime, TypeDatetime:
		count = 1
	case TypeDecimal:
		count = 2
	default:
		d := diagnosticAt(RuleType, word, "type %q is not a dbspec type", word.text)
		return Type{}, &d
	}
	bad := func(format string, args ...any) (Type, *Diagnostic) {
		d := diagnosticAt(RuleType, word, format, args...)
		return Type{}, &d
	}
	if len(params) != count {
		return bad("type %s takes %d parameters, not %d", kind, count, len(params))
	}
	values := make([]int, count)
	for i, p := range params {
		v, err := strconv.Atoi(p.text)
		if err != nil || strings.Contains(p.text, ".") {
			return bad("type %s parameter %s is not an integer in range", kind, p.text)
		}
		values[i] = v
	}
	t := Type{Kind: kind}
	switch kind {
	case TypeVarchar:
		if values[0] < 1 || values[0] > 16383 {
			return bad("varchar(n) needs 1 <= n <= 16383, not %d", values[0])
		}
		t.Length = values[0]
	case TypeTime, TypeDatetime:
		if values[0] < 0 || values[0] > 6 {
			return bad("%s(p) needs 0 <= p <= 6, not %d", kind, values[0])
		}
		t.Precision = values[0]
	case TypeDecimal:
		if values[0] < 1 || values[0] > 18 || values[1] < 0 || values[1] > values[0] {
			return bad("decimal(p,s) needs 1 <= p <= 18 and 0 <= s <= p, not (%d,%d)", values[0], values[1])
		}
		t.Precision, t.Scale = values[0], values[1]
	}
	return t, nil
}

func (p *parser) settingsLine(c *cursor) {
	s := p.settings
	first := c.tokens[0]
	if first.is(tokenPunct, "}") {
		c.i++
		s.closing = p.takeComments()
		p.state, p.settings, p.open = stateTable, nil, p.table.brace
		if p.table.brace.line == 0 {
			p.open = p.table.keyword
		}
		p.table.phase = phaseAfterSettings
		c.done()
		return
	}
	if first.kind != tokenWord {
		c.fail("a setting or '}'")
		return
	}
	keyword := c.next()
	line := &settingNode{keyword: keyword}
	arg := func(what string) bool {
		t, ok := c.name(what)
		if ok {
			line.args = append(line.args, t)
		}
		return ok
	}
	rest := func(what string) bool {
		if !arg(what) {
			return false
		}
		for c.more() {
			if !arg(what) {
				return false
			}
		}
		return true
	}
	ok := true
	switch keyword.text {
	case "entity":
		ok = arg("an entity name")
	case "updated", "soft_delete", "aes_version":
		ok = arg("a column name")
	case "select":
		ok = c.keyword("explicit") && rest("a column name")
	case "codec":
		ok = arg("a column name") && rest("a codec stage")
	case "blind_index":
		ok = arg("the AES column") && arg("the index column")
	case "navigation":
		ok = arg("a foreign key name") && arg("the child relation name") && arg("the parent relation name")
	case "immutable":
	case "markdown":
		ok = arg("a column name")
	case "store":
		var kind token
		kind, ok = c.oneOf("'files', 'document' or 'block'", "files", "document", "block")
		if ok {
			line.args = append(line.args, kind)
		}
		if ok && kind.text == "block" {
			ok = arg("a foreign key name")
		}
		if ok && kind.text != "files" {
			var shape token
			shape, ok = c.oneOf("'list' or 'table'", "list", "table")
			if ok {
				line.args = append(line.args, shape)
			}
		}
	case "key_prefix":
		var prefix token
		prefix, ok = c.quoted("a key prefix in quotes")
		if ok {
			line.args = append(line.args, prefix)
		}
	case "title", "body", "order":
		ok = arg("a column name")
	case "checkbox":
		ok = arg("the state column") && arg("a state name")
		if ok {
			var glyph token
			glyph, ok = c.quoted("a glyph in quotes")
			if ok {
				line.args = append(line.args, glyph)
			}
		}
	case "state_machine":
		ok = arg("the state column")
		switch {
		case !ok:
		case c.formAhead("initial"):
			c.next()
			line.form = "initial"
			ok = arg("a state name")
		case c.formAhead("terminal"):
			c.next()
			line.form = "terminal"
			ok = arg("a state name")
		case c.formAhead("history"):
			c.next()
			line.form = "history"
			ok = arg("the history table") && c.keyword("row") && arg("the foreign key column") &&
				c.keyword("from") && arg("the from column") && c.keyword("to") && arg("the to column") &&
				c.keyword("at") && arg("the at column")
		case c.formAhead("limit"):
			c.next()
			line.form = "limit"
			ok = arg("a state name")
			if ok {
				var count token
				count, ok = c.value("a row count", false)
				if ok {
					line.args = append(line.args, count)
				}
			}
		default:
			line.form = "transition"
			ok = arg("the from state") && c.arrow() && arg("the to state")
		}
		if ok && (line.form == "transition" || line.form == "terminal") && c.peekIs(tokenWord, "require") {
			require := c.next()
			list := columnList{keyword: require}
			list.columns, _, ok = c.names(false)
			line.lists = append(line.lists, list)
		}
		if ok && c.more() && c.lexErr == nil {
			ok = c.fail("the end of the line")
		}
	case "audit":
		ok = c.keyword("into") && arg("the history table") &&
			c.keyword("column") && arg("the audit column") &&
			c.keyword("references") && arg("the audit record table") &&
			c.keyword("action") && arg("the action column") &&
			c.keyword("previous") && arg("the previous column")
		for ok && (c.peekIs(tokenWord, "exclude") || c.peekIs(tokenWord, "include")) {
			list := columnList{keyword: c.next()}
			list.columns, _, ok = c.names(false)
			line.lists = append(line.lists, list)
		}
		if ok && c.more() && c.lexErr == nil {
			ok = c.fail("'exclude', 'include' or the end of the line")
		}
	default:
		if c.lexErr != nil {
			c.fail("a setting")
			return
		}
		p.add(diagnosticAt(RuleSetting, keyword, "setting %q is unknown", keyword.text))
		return
	}
	if !ok || !c.done() {
		return
	}
	switch keyword.text {
	case "entity":
		p.names(line.args[0])
	case "navigation":
		p.names(line.args[1])
		p.names(line.args[2])
	}
	line.comments = p.takeComments()
	s.lines = append(s.lines, line)
}

func (p *parser) diagramLine(c *cursor) {
	d := p.diagram
	if c.tokens[0].is(tokenPunct, "}") {
		c.i++
		d.closing = p.takeComments()
		p.state, p.diagram = stateTop, nil
		c.done()
		return
	}
	e := &entryNode{}
	var ok bool
	if e.table, ok = c.name("a table name or '}'"); !ok || !c.keyword("at") {
		return
	}
	if e.x, ok = c.value("the x coordinate", true); !ok {
		return
	}
	if e.y, ok = c.value("the y coordinate", true); !ok || !c.done() {
		return
	}
	e.comments = p.takeComments()
	d.entries = append(d.entries, e)
}
