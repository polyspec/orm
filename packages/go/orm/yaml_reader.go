package orm

// The YAML reader of orm (docs/spec/codec.md COD-74 to COD-80): the grammar of YAML 1.2.2, chapters 5 to 9, with the core
// schema (10.3.2), read in Go with no library. A number in brackets names the production of that number in YAML 1.2.2.
//
// The reader reads the stream once, in its order, into a list of events: the start of each sequence and mapping, its end, each
// scalar once it is read whole, and a marker at each anchor, tag and alias and at the start of a second document. It stops at
// the first place where the stream leaves the grammar and records that place. The rules of COD-70 are then met over the events
// in their order, so a node that starts before that place is met before the yaml-parse error, and a scalar that the place
// interrupts is not (COD-80).
//
// That a node is an implicit key is known only from the ":" after it (COD-80). The reader reads the node once and then looks
// for the ":"; the start of the mapping or the flow pair that the key opens is a placeholder event, set once the ":" is found,
// so the mapping is met before its key. A node that is not a key keeps its events as the events of a node that is no key.
//
// Neither the reading nor the meeting of the rules uses a recursion that the caller's stack decides: the rules are met over the
// events with an explicit stack, and the reading recurses once for each nested collection, which it reads to at most
// yamlReadDepth levels (see yamlReadDepth).

import (
	"fmt"
	"math"
	"strings"
	"unicode/utf8"
)

// yamlKeyLimit is the number of characters of an implicit key, from its first character to its ":" (COD-76, COD-77).
const yamlKeyLimit = 1024

// yamlReadDepth is the number of nested collections that the reader reads before it stops. The nesting rule refuses a list
// or a map at level maxNesting+1, and only an implicit key, which is at most yamlKeyLimit characters, each nested collection
// at least one, can make that collection a key whose own rule comes first; so past maxNesting+yamlKeyLimit levels every
// collection at level maxNesting+1 is met by its nesting rule, or an earlier rule, before the reader would read further.
const yamlReadDepth = maxNesting + yamlKeyLimit + 8

type yamlEventKind uint8

const (
	yamlEventPlaceholder yamlEventKind = iota // the start of a mapping not yet known to be one
	yamlEventSequence
	yamlEventMapping
	yamlEventEnd
	yamlEventScalar
	yamlEventAnchor
	yamlEventTag
	yamlEventAlias
	yamlEventDocument // the start of a second document
)

type yamlEvent struct {
	kind  yamlEventKind
	key   bool // the node is a map key
	plain bool // a plain scalar, which resolves by the core schema
	text  string
}

// yamlSyntaxError is the error of the reader where the stream leaves the grammar, with its line and its column, each
// counted from 1, the column in Unicode characters (COD-80).
type yamlSyntaxError struct {
	Line   int
	Column int
	Reason string
}

func (e *yamlSyntaxError) Error() string {
	return fmt.Sprintf("yaml reader: line %d, column %d: %s", e.Line, e.Column, e.Reason)
}

type yamlReader struct {
	s        []rune
	breaks   []int32 // breaks[i] is the number of CR and LF characters before s[i]
	p        int
	events   []yamlEvent
	errAt    int
	reason   string
	failed   bool
	halted   bool // the reader stopped where nothing after it can change the result: a marker or a second document
	pending  int  // the implicit-key candidates being read
	marker   bool // an anchor, tag or alias marker was emitted
	depth    int
	document bool
}

// yamlDecode reads one YAML document by the reader of orm and returns its value (COD-29, COD-74).
func yamlDecode(b []byte) (any, error) {
	b, err := yamlStream(b)
	if err != nil {
		return nil, err
	}
	r := &yamlReader{s: []rune(string(b))}
	r.breaks = make([]int32, len(r.s)+1)
	for i, c := range r.s {
		r.breaks[i+1] = r.breaks[i]
		if c == '\n' || c == '\r' {
			r.breaks[i+1]++
		}
	}
	r.stream()
	return r.value()
}

// ---- characters ----

func (r *yamlReader) at(i int) rune {
	if i >= 0 && i < len(r.s) {
		return r.s[i]
	}
	return -1
}

func (r *yamlReader) cur() rune { return r.at(r.p) }

func (r *yamlReader) eof() bool { return r.p >= len(r.s) }

func yamlWhite(c rune) bool { return c == ' ' || c == '\t' }

func yamlBreakChar(c rune) bool { return c == '\n' || c == '\r' }

// yamlNsChar is ns-char [34]: a printable character that is not white space or a line break; the stream rules leave only
// printable characters and no byte order mark (COD-75).
func yamlNsChar(c rune) bool { return c >= 0 && !yamlWhite(c) && !yamlBreakChar(c) }

func yamlFlowIndicator(c rune) bool { return c == ',' || c == '[' || c == ']' || c == '{' || c == '}' }

// yamlIndicator is c-indicator [22].
func yamlIndicator(c rune) bool { return c >= 0 && strings.ContainsRune("-?:,[]{}#&*!|>'\"%@`", c) }

// yamlPlainSafe is ns-plain-safe(c) [129]: in a flow collection a flow indicator ends a plain scalar.
func yamlPlainSafe(c rune, flow bool) bool { return yamlNsChar(c) && (!flow || !yamlFlowIndicator(c)) }

func yamlWordChar(c rune) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '-'
}

// yamlHexValue is the value of a hex digit that yamlHexDigit accepts.
func yamlHexValue(c rune) rune {
	switch {
	case c >= 'a':
		return c - 'a' + 10
	case c >= 'A':
		return c - 'A' + 10
	}
	return c - '0'
}

func yamlHexDigit(c rune) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

// blankAt reports white space, a line break or the end of the stream at i.
func (r *yamlReader) blankAt(i int) bool {
	c := r.at(i)
	return c < 0 || yamlWhite(c) || yamlBreakChar(c)
}

// breakLen is the length of the line break b-break [28] at i: CR LF, CR or LF.
func (r *yamlReader) breakLen(i int) int {
	switch r.at(i) {
	case '\n':
		return 1
	case '\r':
		if r.at(i+1) == '\n' {
			return 2
		}
		return 1
	}
	return 0
}

func (r *yamlReader) lineStart(i int) bool { return i == 0 || i <= len(r.s) && yamlBreakChar(r.s[i-1]) }

// markerAt reports a document marker, `---` or `...` at the start of a line followed by white space, a line break or the
// end of the stream (c-forbidden [206]).
func (r *yamlReader) markerAt(i int) bool {
	if !r.lineStart(i) || i+3 > len(r.s) {
		return false
	}
	m := string(r.s[i : i+3])
	return (m == "---" || m == "...") && r.blankAt(i+3)
}

func (r *yamlReader) spacesAt(i int) int {
	n := 0
	for r.at(i+n) == ' ' {
		n++
	}
	return n
}

// skipWhite skips white space on the line and reports whether there was any.
func (r *yamlReader) skipWhite() bool {
	start := r.p
	for yamlWhite(r.cur()) {
		r.p++
	}
	return r.p > start
}

func (r *yamlReader) column() int {
	i := r.p
	for i > 0 && !yamlBreakChar(r.s[i-1]) {
		i--
	}
	return r.p - i
}

func (r *yamlReader) oneLine(from, to int) bool { return r.breaks[from] == r.breaks[to] }

// ---- control ----

func (r *yamlReader) stopped() bool { return r.failed || r.halted }

// fail records the place where the stream leaves the grammar; the reader reads nothing after it.
func (r *yamlReader) fail(reason string) bool {
	if !r.stopped() {
		r.failed, r.errAt, r.reason = true, r.p, reason
	}
	return false
}

func (r *yamlReader) emit(kind yamlEventKind) int {
	r.events = append(r.events, yamlEvent{kind: kind})
	return len(r.events) - 1
}

func (r *yamlReader) emitScalar(key, plain bool, text string) {
	r.events = append(r.events, yamlEvent{kind: yamlEventScalar, key: key, plain: plain, text: text})
}

func (r *yamlReader) emitNull() bool {
	r.emitScalar(false, true, "")
	return true
}

// emitMarker emits the marker of an anchor, a tag or an alias, which the rules meet at that character whatever follows it
// (COD-79). Outside an implicit-key candidate nothing after it changes the result, so the reader stops there.
func (r *yamlReader) emitMarker(kind yamlEventKind) bool {
	r.emit(kind)
	r.marker = true
	if r.pending == 0 {
		r.halted = true
		return false
	}
	return true
}

// deeper counts a collection that starts; the reader stops past yamlReadDepth levels, where the nesting rule has already
// refused a collection that the events hold.
func (r *yamlReader) deeper() bool {
	r.depth++
	if r.depth > yamlReadDepth {
		r.halted = true
		return false
	}
	return true
}

func (r *yamlReader) open(kind yamlEventKind) bool {
	r.emit(kind)
	return r.deeper()
}

func (r *yamlReader) resolve(holder int) bool {
	r.events[holder].kind = yamlEventMapping
	return r.deeper()
}

func (r *yamlReader) close() bool {
	r.depth--
	r.emit(yamlEventEnd)
	return true
}

// flagKey marks the first event from idx, the start of a node, as a map key.
func (r *yamlReader) flagKey(idx int) {
	for i := idx; i < len(r.events); i++ {
		if r.events[i].kind != yamlEventPlaceholder {
			r.events[i].key = true
			return
		}
	}
}

// ---- lines and comments ----

// skipCommentLines skips, from the start of a line, the lines that hold only white space or a comment (l-comment [78]).
func (r *yamlReader) skipCommentLines() {
	for {
		j := r.p
		for yamlWhite(r.at(j)) {
			j++
		}
		if r.at(j) == '#' {
			for j < len(r.s) && !yamlBreakChar(r.s[j]) {
				j++
			}
		}
		if bl := r.breakLen(j); bl > 0 {
			r.p = j + bl
			continue
		}
		if j >= len(r.s) {
			r.p = j
		}
		return
	}
}

// lineEnd reads s-l-comments [79] after a node: white space, a comment after white space, and the line break or the end of
// the stream, then the comment lines that follow.
func (r *yamlReader) lineEnd() bool {
	r.skipWhite()
	if r.cur() == '#' && (r.lineStart(r.p) || yamlWhite(r.s[r.p-1])) {
		for !r.eof() && !yamlBreakChar(r.cur()) {
			r.p++
		}
	}
	if bl := r.breakLen(r.p); bl > 0 {
		r.p += bl
		r.skipCommentLines()
		return true
	}
	if r.eof() {
		return true
	}
	return r.fail("a node is followed by more on its line")
}

// endOfLine reports that nothing more stands on the line at p: a line break, the end of the stream or a comment.
func (r *yamlReader) endOfLine(white bool) bool {
	c := r.cur()
	return c < 0 || yamlBreakChar(c) || c == '#' && white
}

// ---- the stream ----

// stream reads l-yaml-stream [211]: the document prefixes, the documents with their directives and markers, and the suffixes.
// A second document is met where it starts and read no further (COD-75).
func (r *yamlReader) stream() {
	suffix := false
	for !r.stopped() {
		r.skipCommentLines()
		if r.eof() {
			return
		}
		if r.markerAt(r.p) && r.cur() == '.' {
			r.p += 3
			if !r.lineEnd() {
				return
			}
			suffix = true
			continue
		}
		if r.document {
			if suffix || r.markerAt(r.p) {
				r.emit(yamlEventDocument)
				r.halted = true
				return
			}
			r.fail("a document is followed by content that no document holds")
			return
		}
		r.document, suffix = true, false
		switch {
		case r.cur() == '%':
			if !r.directives() {
				return
			}
			r.p += 3
			r.blockInline(-1, false)
		case r.markerAt(r.p):
			r.p += 3
			r.blockInline(-1, false)
		default:
			r.blockNext(-1, false)
		}
	}
}

// directives reads the directives of a document ([82] to [98]) and leaves p at its `---`, which must follow them (COD-75).
func (r *yamlReader) directives() bool {
	version := false
	handles := map[string]bool{}
	for r.cur() == '%' && r.lineStart(r.p) {
		r.p++
		start := r.p
		for yamlNsChar(r.cur()) {
			r.p++
		}
		switch string(r.s[start:r.p]) {
		case "YAML":
			if version {
				return r.fail("a document has a second %YAML directive")
			}
			version = true
			if !r.skipWhite() {
				return r.fail("a %YAML directive has a version")
			}
			major := r.digits()
			if r.cur() != '.' {
				return r.fail("a %YAML version is two numbers")
			}
			r.p++
			minor := r.digits()
			if major == "" || minor == "" {
				return r.fail("a %YAML version is two numbers")
			}
			if major != "1" || minor != "2" {
				return r.fail("the %YAML version is not 1.2")
			}
		case "TAG":
			if !r.skipWhite() {
				return r.fail("a %TAG directive has a handle")
			}
			handle, ok := r.tagHandle()
			if !ok {
				return false
			}
			if handles[handle] {
				return r.fail("a %TAG directive repeats a handle")
			}
			handles[handle] = true
			if !r.skipWhite() {
				return r.fail("a %TAG directive has a prefix")
			}
			if !r.tagPrefix() {
				return false
			}
		default:
			return r.fail("a directive that is not %YAML or %TAG")
		}
		if !r.lineEnd() {
			return false
		}
	}
	if !r.markerAt(r.p) || r.cur() != '-' {
		return r.fail("directives are followed by ---")
	}
	return true
}

func (r *yamlReader) digits() string {
	start := r.p
	for c := r.cur(); c >= '0' && c <= '9'; c = r.cur() {
		r.p++
	}
	return string(r.s[start:r.p])
}

// tagHandle reads c-tag-handle [89]: `!`, `!!` or `!` word characters `!`.
func (r *yamlReader) tagHandle() (string, bool) {
	start := r.p
	if r.cur() != '!' {
		return "", r.fail("a tag handle starts with !")
	}
	r.p++
	if r.blankAt(r.p) {
		return "!", true
	}
	if r.cur() == '!' {
		r.p++
		return "!!", true
	}
	for yamlWordChar(r.cur()) {
		r.p++
	}
	if r.cur() != '!' {
		return "", r.fail("a named tag handle ends with !")
	}
	r.p++
	return string(r.s[start:r.p]), true
}

// tagPrefix reads ns-tag-prefix [93] up to the end of its token.
func (r *yamlReader) tagPrefix() bool {
	if r.cur() == '!' {
		r.p++
	} else if !r.tagChar() {
		return r.fail("a tag prefix")
	}
	for r.uriChar() {
	}
	if !r.blankAt(r.p) {
		return r.fail("a tag prefix")
	}
	return true
}

// uriChar reads one ns-uri-char [39], a %-escape included, and reports whether it read one.
func (r *yamlReader) uriChar() bool {
	c := r.cur()
	switch {
	case c == '%':
		if yamlHexDigit(r.at(r.p+1)) && yamlHexDigit(r.at(r.p+2)) {
			r.p += 3
			return true
		}
		return false
	case yamlWordChar(c), c >= 0 && strings.ContainsRune("#;/?:@&=+$,_.!~*'()[]", c):
		r.p++
		return true
	}
	return false
}

// tagChar reads one ns-tag-char [40]: an ns-uri-char that is not `!` or a flow indicator.
func (r *yamlReader) tagChar() bool {
	if c := r.cur(); c == '!' || yamlFlowIndicator(c) {
		return false
	}
	return r.uriChar()
}

// ---- block nodes ----

// blockInline reads s-l+block-node(n,c) [196] after an indicator on its line: the `:` of an implicit key or `---`. A block
// collection never starts on that line (COD-75, COD-76).
func (r *yamlReader) blockInline(n int, out bool) bool {
	if r.endOfLine(r.skipWhite()) {
		if !r.lineEnd() {
			return false
		}
		return r.blockNext(n, out)
	}
	return r.blockSameLine(n)
}

// blockSameLine reads a node that starts at p after separation that is no indentation: a block scalar or a flow node
// (s-l+flow-in-block [197]) and the comments after it.
func (r *yamlReader) blockSameLine(n int) bool {
	if c := r.cur(); c == '|' || c == '>' {
		return r.blockScalar(n)
	}
	content, ok := r.flowContent(n+1, false)
	if !ok {
		return false
	}
	r.finishValue(content, n+1, false)
	return r.lineEnd()
}

// finishValue emits a node that flowContent read and that is no key: the rest of a plain scalar, or the null of a node with
// properties and no content.
func (r *yamlReader) finishValue(c yamlContent, n int, flow bool) {
	switch {
	case c.plain:
		r.plainMore(n, flow, &c.text)
		r.emitScalar(false, true, string(c.text))
	case c.empty:
		r.emitNull()
	}
}

// blockNext reads s-l+block-node(n,c) whose node starts on a later line, from the start of a line: a block sequence, a block
// mapping, a flow node or a block scalar indented beyond n, or an empty node, a null. A sequence that is the value of a
// mapping key (out) may stand at the indentation n of the key (seq-space [201]).
func (r *yamlReader) blockNext(n int, out bool) bool {
	if r.eof() || r.markerAt(r.p) {
		return r.emitNull()
	}
	sp := r.spacesAt(r.p)
	q := r.p + sp
	c := r.at(q)
	if c == '-' && r.blankAt(q+1) {
		if sp > n || out && sp >= n {
			r.p = q
			return r.blockSequence(sp)
		}
		return r.emitNull()
	}
	if sp <= n {
		return r.emitNull()
	}
	r.p = q
	if yamlWhite(c) {
		// A tab ends the indentation, so no block collection starts after it (COD-76).
		r.skipWhite()
		return r.blockSameLine(n)
	}
	return r.blockStart(sp, n)
}

// blockIndented reads s-l+block-indented(n,c) [185] after `-`, `?` or the `:` of an explicit entry: a compact sequence or
// mapping on the line, indented by spaces only, or a block node.
func (r *yamlReader) blockIndented(n int, out bool) bool {
	spaces := true
	start := r.p
	for yamlWhite(r.cur()) {
		if r.cur() == '\t' {
			spaces = false
		}
		r.p++
	}
	if r.endOfLine(r.p > start) {
		if !r.lineEnd() {
			return false
		}
		return r.blockNext(n, out)
	}
	if !spaces {
		return r.blockSameLine(n)
	}
	col := r.column()
	if r.cur() == '-' && r.blankAt(r.p+1) {
		return r.blockSequence(col)
	}
	return r.blockStart(col, n)
}

// blockStart reads the node that starts at p, at column col, where a block mapping of that indentation may start: its first
// entry is explicit, has an empty key, or has an implicit key that the reader finds by its `:`; any other node is a flow node
// or a block scalar whose parent has the indentation n.
func (r *yamlReader) blockStart(col, n int) bool {
	c := r.cur()
	switch {
	case c == '|' || c == '>':
		return r.blockScalar(n)
	case (c == '?' || c == ':') && r.blankAt(r.p+1):
		if !r.open(yamlEventMapping) {
			return false
		}
		return r.blockMappingEntries(col, false)
	}
	holder := r.emit(yamlEventPlaceholder)
	content, key, ok := r.candidate(n+1, false, holder)
	if !ok {
		return false
	}
	if key {
		return r.blockMappingValue(col) && r.blockMappingEntries(col, true)
	}
	r.finishValue(content, n+1, false)
	return r.lineEnd()
}

// blockSequence reads l+block-sequence [183] whose entries stand at indentation m, from its first `-`.
func (r *yamlReader) blockSequence(m int) bool {
	if !r.open(yamlEventSequence) {
		return false
	}
	for {
		r.p++
		if !r.blockIndented(m, false) {
			return false
		}
		r.skipCommentLines()
		if r.eof() || r.markerAt(r.p) {
			break
		}
		sp := r.spacesAt(r.p)
		if sp != m || r.at(r.p+sp) != '-' || !r.blankAt(r.p+sp+1) {
			break
		}
		r.p += sp
	}
	return r.close()
}

// blockMappingEntries reads the entries of the open block mapping ([187]) at indentation m, the first one too unless done.
func (r *yamlReader) blockMappingEntries(m int, done bool) bool {
	if !done && !r.blockMappingEntry(m) {
		return false
	}
	for {
		r.skipCommentLines()
		if r.eof() || r.markerAt(r.p) || r.spacesAt(r.p) != m {
			break
		}
		r.p += m
		if !r.blockMappingEntry(m) {
			return false
		}
	}
	return r.close()
}

// blockMappingEntry reads ns-l-block-map-entry [188] at p, column m.
func (r *yamlReader) blockMappingEntry(m int) bool {
	c := r.cur()
	if c == '?' && r.blankAt(r.p+1) {
		r.p++
		idx := len(r.events)
		ok := r.blockIndented(m, true)
		r.flagKey(idx)
		if !ok {
			return false
		}
		r.skipCommentLines()
		if !r.eof() && !r.markerAt(r.p) && r.spacesAt(r.p) == m && r.at(r.p+m) == ':' && r.blankAt(r.p+m+1) {
			r.p += m + 1
			return r.blockIndented(m, true)
		}
		return r.emitNull()
	}
	if c == ':' && r.blankAt(r.p+1) {
		r.emitScalar(true, true, "")
		return r.blockMappingValue(m)
	}
	content, key, ok := r.candidate(m+1, false, -1)
	if !ok {
		return false
	}
	if !key {
		if content.plain {
			r.emitScalar(false, true, string(content.text))
		}
		return r.fail("an entry of a block mapping is a key followed by :")
	}
	return r.blockMappingValue(m)
}

// blockMappingValue reads c-l-block-map-implicit-value [195] from its `:`.
func (r *yamlReader) blockMappingValue(m int) bool {
	r.p++
	return r.blockInline(m, true)
}

// blockScalar reads a literal or folded scalar ([162] to [182]) whose parent has the indentation n, from its indicator.
func (r *yamlReader) blockScalar(n int) bool {
	folded := r.cur() == '>'
	r.p++
	indicator, chomp := 0, rune(0)
	for range 2 {
		c := r.cur()
		if c >= '1' && c <= '9' && indicator == 0 {
			indicator = int(c - '0')
		} else if (c == '-' || c == '+') && chomp == 0 {
			chomp = c
		} else {
			break
		}
		r.p++
	}
	white := r.skipWhite()
	if r.cur() == '#' && white {
		for !r.eof() && !yamlBreakChar(r.cur()) {
			r.p++
		}
	}
	if bl := r.breakLen(r.p); bl > 0 {
		r.p += bl
	} else if !r.eof() {
		return r.fail("a block scalar header ends its line")
	}
	indent := -1
	if indicator > 0 {
		indent = n + indicator
	} else {
		// The content indentation is that of the first line that is not empty; a leading empty line has no more spaces (8.1.1.1).
		widest, widestAt := 0, 0
		for i := r.p; ; {
			if i >= len(r.s) || r.markerAt(i) {
				break
			}
			sp := r.spacesAt(i)
			if bl := r.breakLen(i + sp); bl > 0 {
				if sp > widest {
					widest, widestAt = sp, i+sp
				}
				i += sp + bl
				continue
			}
			if i+sp >= len(r.s) {
				break
			}
			if sp > n {
				indent = sp
				if widest > indent {
					r.p = widestAt
					return r.fail("a leading empty line of a block scalar is indented beyond its content")
				}
			}
			break
		}
		if indent < 0 {
			indent = max(n+1, widest)
		}
	}
	type blockLine struct {
		text      []rune
		empty     bool
		lineBreak bool
	}
	var lines []blockLine
	for !r.eof() && !r.markerAt(r.p) {
		sp := r.spacesAt(r.p)
		j := r.p + sp
		if bl := r.breakLen(j); bl > 0 || j >= len(r.s) {
			if sp > indent {
				lines = append(lines, blockLine{text: r.s[r.p+indent : j], lineBreak: bl > 0})
			} else if bl > 0 {
				lines = append(lines, blockLine{empty: true, lineBreak: true})
			}
			r.p = j + bl
			continue
		}
		if sp < indent {
			break
		}
		e := j
		for e < len(r.s) && !yamlBreakChar(r.s[e]) {
			e++
		}
		bl := r.breakLen(e)
		lines = append(lines, blockLine{text: r.s[r.p+indent : e], lineBreak: bl > 0})
		r.p = e + bl
	}
	last := -1
	for i, l := range lines {
		if !l.empty {
			last = i
		}
	}
	var out []rune
	if last >= 0 {
		if folded {
			// Between two lines whose text starts with no white space a line break folds (6.5); one beside a more-indented line
			// is kept, and each empty line is a line feed ([175] to [181]).
			first, text, empties := true, false, 0
			for _, l := range lines[:last+1] {
				if l.empty {
					empties++
					continue
				}
				spaced := len(l.text) > 0 && yamlWhite(l.text[0])
				switch {
				case first:
				case text && !spaced && empties == 0:
					out = append(out, ' ')
				case text && !spaced:
				default:
					out = append(out, '\n')
				}
				for range empties {
					out = append(out, '\n')
				}
				out = append(out, l.text...)
				first, text, empties = false, !spaced, 0
			}
		} else {
			for i, l := range lines[:last+1] {
				if i > 0 {
					out = append(out, '\n')
				}
				out = append(out, l.text...)
			}
		}
		// Chomping (8.1.1.2); the end of the stream stands for the final line break.
		if chomp != '-' && lines[last].lineBreak {
			out = append(out, '\n')
		}
		if chomp == '+' {
			for range lines[last+1:] {
				out = append(out, '\n')
			}
		}
	} else if chomp == '+' {
		for range lines {
			out = append(out, '\n')
		}
	}
	r.emitScalar(false, false, string(out))
	return true
}

// ---- flow nodes ----

// yamlContent is what flowContent read: a plain scalar of which only the first line is read and nothing emitted, a node with
// properties and no content, or another node, whose events are emitted.
type yamlContent struct {
	plain bool
	text  []rune
	empty bool
	json  bool // a quoted scalar or a flow collection, after which a value may be adjacent to the ":" (c-flow-json-node [157])
}

// candidate reads a node that may be an implicit key (ns-s-implicit-yaml-key [154], c-s-implicit-json-key [155]) and reports
// whether it is one: a `:` follows it on its line, at most yamlKeyLimit characters from its start, as the context needs it.
// A plain key is emitted as a key; the first event of any other key is marked as a key, and the placeholder holder, if any,
// becomes the start of the mapping the key opens. A node that is no key keeps its events, and a plain scalar that is no key
// is left for the caller to finish (COD-80).
func (r *yamlReader) candidate(n int, flow bool, holder int) (yamlContent, bool, bool) {
	start, idx := r.p, len(r.events)
	r.pending++
	content, ok := r.flowContent(n, flow)
	r.pending--
	if !ok {
		return content, false, false
	}
	q := r.p
	for yamlWhite(r.at(q)) {
		q++
	}
	key := r.at(q) == ':' && q-start <= yamlKeyLimit && r.oneLine(start, q)
	if key {
		next := r.at(q + 1)
		switch {
		case !flow:
			key = r.blankAt(q + 1)
		case !content.json:
			key = !yamlPlainSafe(next, true)
		}
	}
	if key {
		switch {
		case content.plain:
			r.emitScalar(true, true, string(content.text))
		case content.empty:
			r.emitScalar(true, true, "")
		default:
			r.flagKey(idx)
		}
		r.p = q
		if holder >= 0 && !r.resolve(holder) {
			return content, true, false
		}
	}
	if r.pending == 0 && r.marker {
		r.halted = true
		return content, key, false
	}
	return content, key, true
}

// flowContent reads ns-flow-node [161] at p: its properties, then an alias, a flow collection, a quoted scalar or the first
// line of a plain scalar. n is the indentation that its lines after the first need.
func (r *yamlReader) flowContent(n int, flow bool) (yamlContent, bool) {
	var content yamlContent
	had, separated, ok := r.properties()
	if !ok {
		return content, false
	}
	c := r.cur()
	if had {
		end := r.blankAt(r.p) || c == '#' || flow && yamlFlowIndicator(c) || c == ':' && !yamlPlainSafe(r.at(r.p+1), flow)
		if end {
			content.empty = true
			return content, true
		}
		if !separated {
			return content, r.fail("properties are separated from their content")
		}
	}
	switch {
	case c == '*':
		if !r.emitMarker(yamlEventAlias) {
			return content, false
		}
		r.p++
		if !r.anchorName() {
			return content, r.fail("an alias has a name")
		}
		return content, true
	case c == '[':
		content.json = true
		return content, r.flowSequence(n)
	case c == '{':
		content.json = true
		return content, r.flowMapping(n)
	case c == '"' || c == '\'':
		text, ok := r.quoted(n, c == '"')
		if !ok {
			return content, false
		}
		r.emitScalar(false, false, text)
		content.json = true
		return content, true
	case r.plainFirst(r.p, flow):
		content.plain = true
		content.text = append(content.text, c)
		r.p++
		r.plainInLine(flow, &content.text)
		return content, true
	}
	return content, r.fail("no node starts with this character")
}

// properties reads c-ns-properties [96], a tag and an anchor in either order, and emits a marker for each. It reports
// whether there were any and whether white space followed them.
func (r *yamlReader) properties() (had, separated, ok bool) {
	for range 2 {
		c := r.cur()
		if c != '&' && c != '!' || had && !separated {
			break
		}
		kind := yamlEventTag
		if c == '&' {
			kind = yamlEventAnchor
		}
		if !r.emitMarker(kind) {
			return true, false, false
		}
		r.p++
		if c == '&' && !r.anchorName() {
			return true, false, r.fail("an anchor has a name")
		}
		if c == '!' && !r.tagProperty() {
			return true, false, false
		}
		had = true
		separated = r.skipWhite()
	}
	return had, separated, true
}

// anchorName reads ns-anchor-name [103]: ns-char that are not flow indicators.
func (r *yamlReader) anchorName() bool {
	start := r.p
	for c := r.cur(); yamlNsChar(c) && !yamlFlowIndicator(c); c = r.cur() {
		r.p++
	}
	return r.p > start
}

// tagProperty reads c-ns-tag-property [97] after its `!`: a verbatim tag, a shorthand tag or the non-specific tag `!`.
func (r *yamlReader) tagProperty() bool {
	if r.cur() == '<' {
		r.p++
		start := r.p
		for r.cur() != '>' && r.uriChar() {
		}
		if r.p == start || r.cur() != '>' {
			return r.fail("a verbatim tag")
		}
		r.p++
		return true
	}
	if r.cur() == '!' {
		r.p++
		return r.tagChars() || r.fail("a tag has a suffix")
	}
	i := r.p
	for yamlWordChar(r.at(i)) {
		i++
	}
	if i > r.p && r.at(i) == '!' {
		r.p = i + 1
		return r.tagChars() || r.fail("a tag has a suffix")
	}
	r.tagChars()
	return true
}

func (r *yamlReader) tagChars() bool {
	start := r.p
	for r.tagChar() {
	}
	return r.p > start
}

// plainFirst is ns-plain-first(c) [126] at i.
func (r *yamlReader) plainFirst(i int, flow bool) bool {
	c := r.at(i)
	if !yamlNsChar(c) {
		return false
	}
	if c == '?' || c == ':' || c == '-' {
		return yamlPlainSafe(r.at(i+1), flow)
	}
	return !yamlIndicator(c)
}

// plainChar is ns-plain-char(c) [130] at i: a `:` is content before a plain-safe character, and a `#` after an ns-char.
func (r *yamlReader) plainChar(i int, flow bool) bool {
	switch c := r.at(i); c {
	case ':':
		return yamlPlainSafe(r.at(i+1), flow)
	case '#':
		return i > 0 && yamlNsChar(r.s[i-1])
	default:
		return yamlPlainSafe(c, flow)
	}
}

// plainInLine reads nb-ns-plain-in-line(c) [132]; the white space at the end of the line is not part of the scalar.
func (r *yamlReader) plainInLine(flow bool, text *[]rune) {
	for {
		q := r.p
		for yamlWhite(r.at(q)) {
			q++
		}
		if !r.plainChar(q, flow) {
			return
		}
		*text = append(*text, r.s[r.p:q+1]...)
		r.p = q + 1
	}
}

// plainMore reads the lines of a plain scalar after its first (s-ns-plain-next-line [134]), each indented by n spaces and no
// document marker, and folds them (6.5). p stays after the last character of the scalar.
func (r *yamlReader) plainMore(n int, flow bool, text *[]rune) {
	for {
		end := r.p
		i := end
		for yamlWhite(r.at(i)) {
			i++
		}
		bl := r.breakLen(i)
		if bl == 0 {
			return
		}
		i += bl
		empties := 0
		for {
			if r.markerAt(i) {
				return
			}
			sp := r.spacesAt(i)
			j := i + sp
			if sp >= n {
				for yamlWhite(r.at(j)) {
					j++
				}
			}
			if bl := r.breakLen(j); bl > 0 {
				empties++
				i = j + bl
				continue
			}
			if j >= len(r.s) || sp < n || !r.plainChar(j, flow) {
				return
			}
			if empties == 0 {
				*text = append(*text, ' ')
			}
			for range empties {
				*text = append(*text, '\n')
			}
			*text = append(*text, r.s[j])
			r.p = j + 1
			r.plainInLine(flow, text)
			break
		}
	}
}

// quoted reads a single-quoted ([117] to [125]) or double-quoted ([107] to [116]) scalar from its opening quote; its lines
// after the first are indented by n spaces and fold (6.5).
func (r *yamlReader) quoted(n int, double bool) (string, bool) {
	r.p++
	var text []rune
	for {
		c := r.cur()
		switch {
		case c < 0:
			return "", r.fail("a quoted scalar is not closed")
		case !double && c == '\'':
			if r.at(r.p+1) == '\'' {
				text = append(text, '\'')
				r.p += 2
				continue
			}
			r.p++
			return string(text), true
		case double && c == '"':
			r.p++
			return string(text), true
		case double && c == '\\':
			if bl := r.breakLen(r.p + 1); bl > 0 {
				// An escaped line break joins the lines and keeps the white space before the `\` ([112]).
				r.p += 1 + bl
				empties, ok := r.quotedLines(n)
				if !ok {
					return "", false
				}
				for range empties {
					text = append(text, '\n')
				}
				continue
			}
			ch, ok := r.escape()
			if !ok {
				return "", false
			}
			text = append(text, ch)
		case yamlWhite(c) || yamlBreakChar(c):
			i := r.p
			for yamlWhite(r.at(i)) {
				i++
			}
			bl := r.breakLen(i)
			if bl == 0 {
				text = append(text, r.s[r.p:i]...)
				r.p = i
				continue
			}
			r.p = i + bl
			empties, ok := r.quotedLines(n)
			if !ok {
				return "", false
			}
			if empties == 0 {
				text = append(text, ' ')
			}
			for range empties {
				text = append(text, '\n')
			}
		default:
			text = append(text, c)
			r.p++
		}
	}
}

// quotedLines reads, after a line break inside a quoted scalar, its empty lines and the prefix of its next line
// (s-flow-line-prefix [69]); it returns the number of empty lines.
func (r *yamlReader) quotedLines(n int) (int, bool) {
	empties := 0
	for {
		if r.markerAt(r.p) {
			return 0, r.fail("a document marker inside a quoted scalar")
		}
		sp := r.spacesAt(r.p)
		j := r.p + sp
		if sp >= n {
			for yamlWhite(r.at(j)) {
				j++
			}
		}
		if bl := r.breakLen(j); bl > 0 {
			empties++
			r.p = j + bl
			continue
		}
		if j >= len(r.s) {
			r.p = j
			return 0, r.fail("a quoted scalar is not closed")
		}
		if sp < n {
			r.p = j
			return 0, r.fail("a line of a quoted scalar is indented less than its node")
		}
		r.p = j
		return empties, true
	}
}

// yamlEscapes are the escapes of one character of 5.7, and yamlEscapeWidths the number of hex digits of the others.
var (
	yamlEscapes = map[rune]rune{
		'0': 0, 'a': 7, 'b': 8, 't': 9, '\t': 9, 'n': 10, 'v': 11, 'f': 12, 'r': 13, 'e': 0x1B, ' ': ' ', '"': '"',
		'/': '/', '\\': '\\', 'N': 0x85, '_': 0xA0, 'L': 0x2028, 'P': 0x2029,
	}
	yamlEscapeWidths = map[rune]int{'x': 2, 'u': 4, 'U': 8}
)

// escape reads an escape sequence of a double-quoted scalar from its `\` (5.7).
func (r *yamlReader) escape() (rune, bool) {
	c := r.at(r.p + 1)
	if ch, ok := yamlEscapes[c]; ok {
		r.p += 2
		return ch, true
	}
	width := yamlEscapeWidths[c]
	if width == 0 {
		return 0, r.fail("an escape that YAML does not have")
	}
	var code rune
	for k := range width {
		d := r.at(r.p + 2 + k)
		if !yamlHexDigit(d) {
			return 0, r.fail("an escape has fewer hex digits than it needs")
		}
		code = code<<4 | yamlHexValue(d)
	}
	if !utf8.ValidRune(code) {
		return 0, r.fail("an escape of a number that is not a Unicode scalar value")
	}
	r.p += 2 + width
	return code, true
}

// flowSep reads s-separate(n, flow-in) [80], which may be empty: white space, comments after white space, and line breaks,
// each line after one indented by n spaces before any tab.
func (r *yamlReader) flowSep(n int) bool {
	white := r.skipWhite() || r.lineStart(r.p)
	for {
		if r.cur() == '#' && white {
			for !r.eof() && !yamlBreakChar(r.cur()) {
				r.p++
			}
		}
		bl := r.breakLen(r.p)
		if bl == 0 {
			return true
		}
		r.p += bl
		for {
			if r.markerAt(r.p) {
				return r.fail("a document marker inside a flow collection")
			}
			sp := r.spacesAt(r.p)
			j := r.p + sp
			for yamlWhite(r.at(j)) {
				j++
			}
			if c := r.at(j); c < 0 || yamlBreakChar(c) || c == '#' {
				r.p, white = j, true
				break
			}
			if sp < n {
				r.p += sp
				return r.fail("a line of a flow collection is indented less than its node")
			}
			r.p = j
			return true
		}
	}
}

// flowSequence reads c-flow-sequence [137] from its `[`.
func (r *yamlReader) flowSequence(n int) bool {
	if !r.open(yamlEventSequence) {
		return false
	}
	r.p++
	if !r.flowSep(n) {
		return false
	}
	for {
		switch r.cur() {
		case ']':
			r.p++
			return r.close()
		case ',':
			return r.fail("a flow sequence has an entry before each ,")
		}
		if !r.flowSequenceEntry(n) || !r.flowSep(n) {
			return false
		}
		switch r.cur() {
		case ',':
			r.p++
			if !r.flowSep(n) {
				return false
			}
		case ']':
		default:
			return r.fail("a flow sequence entry is followed by , or ]")
		}
	}
}

// flowSequenceEntry reads ns-flow-seq-entry [139]: a flow pair, a map of one entry ([150]), or a flow node.
func (r *yamlReader) flowSequenceEntry(n int) bool {
	c := r.cur()
	if c == '?' && r.blankAt(r.p+1) || c == ':' && !yamlPlainSafe(r.at(r.p+1), true) {
		if !r.open(yamlEventMapping) {
			return false
		}
		if c == '?' {
			r.p++
			if !r.flowExplicitEntry(n, ']') {
				return false
			}
		} else if !r.flowImplicitEntry(n) {
			return false
		}
		return r.close()
	}
	holder := r.emit(yamlEventPlaceholder)
	content, key, ok := r.candidate(n, true, holder)
	if !ok {
		return false
	}
	if key {
		if !r.flowValue(n, content.json) {
			return false
		}
		return r.close()
	}
	r.finishValue(content, n, true)
	return true
}

// flowMapping reads c-flow-mapping [140] from its `{`. Every node that starts an entry is its key.
func (r *yamlReader) flowMapping(n int) bool {
	if !r.open(yamlEventMapping) {
		return false
	}
	r.p++
	if !r.flowSep(n) {
		return false
	}
	for {
		switch r.cur() {
		case '}':
			r.p++
			return r.close()
		case ',':
			return r.fail("a flow mapping has an entry before each ,")
		}
		if r.cur() == '?' && r.blankAt(r.p+1) {
			r.p++
			if !r.flowExplicitEntry(n, '}') {
				return false
			}
		} else if !r.flowImplicitEntry(n) {
			return false
		}
		if !r.flowSep(n) {
			return false
		}
		switch r.cur() {
		case ',':
			r.p++
			if !r.flowSep(n) {
				return false
			}
		case '}':
		default:
			return r.fail("a flow mapping entry is followed by , or }")
		}
	}
}

// flowExplicitEntry reads ns-flow-map-explicit-entry [143] after its `?`: an entry, or an empty key and value.
func (r *yamlReader) flowExplicitEntry(n int, closing rune) bool {
	if !r.flowSep(n) {
		return false
	}
	if c := r.cur(); c == ',' || c == closing {
		r.emitScalar(true, true, "")
		return r.emitNull()
	}
	return r.flowImplicitEntry(n)
}

// flowImplicitEntry reads ns-flow-map-implicit-entry [144], whose key is known where it starts: a key and a value, a key
// alone, whose value is a null, or an empty key with a value.
func (r *yamlReader) flowImplicitEntry(n int) bool {
	if r.cur() == ':' && !yamlPlainSafe(r.at(r.p+1), true) {
		r.emitScalar(true, true, "")
		return r.flowValue(n, false)
	}
	idx := len(r.events)
	content, ok := r.flowContent(n, true)
	if !ok {
		return false
	}
	switch {
	case content.plain:
		r.plainMore(n, true, &content.text)
		r.emitScalar(true, true, string(content.text))
	case content.empty:
		r.emitScalar(true, true, "")
	default:
		r.flagKey(idx)
	}
	if !r.flowSep(n) {
		return false
	}
	if r.cur() == ':' && (content.json || !yamlPlainSafe(r.at(r.p+1), true)) {
		return r.flowValue(n, content.json)
	}
	return r.emitNull()
}

// flowValue reads the value of a flow entry from its `:`: after a JSON-like key it may be adjacent to the `:`
// (c-ns-flow-map-adjacent-value [148]), else it follows separation (c-ns-flow-map-separate-value [147]); with none, it is
// a null.
func (r *yamlReader) flowValue(n int, json bool) bool {
	r.p++
	if !json && !r.blankAt(r.p) {
		// The ":" of a plain key is followed here by a flow indicator, with no separation before a value: the value is empty.
		return r.emitNull()
	}
	if !r.flowSep(n) {
		return false
	}
	if c := r.cur(); c < 0 || c == ',' || c == ']' || c == '}' {
		return r.emitNull()
	}
	content, ok := r.flowContent(n, true)
	if !ok {
		return false
	}
	r.finishValue(content, n, true)
	return true
}

// ---- the rules ----

// value meets the rules of COD-70 over the events in their order, with an explicit stack, and returns the value of the
// document, or the first error: a rule of a node where the node starts, and the error of the reader after every node that
// started before the place where the stream leaves the grammar (COD-80).
func (r *yamlReader) value() (any, error) {
	type frame struct {
		list   []any
		object map[string]any
		isMap  bool
		key    string
		hasKey bool
	}
	var stack []*frame
	var root any
	attach := func(v any) {
		if len(stack) == 0 {
			root = v
			return
		}
		f := stack[len(stack)-1]
		if !f.isMap {
			f.list = append(f.list, v)
		} else if f.hasKey {
			f.object[f.key] = v
			f.hasKey = false
		}
	}
	for _, ev := range r.events {
		switch ev.kind {
		case yamlEventPlaceholder:
		case yamlEventAnchor:
			return nil, codecErr(CodeCodecDecode, "yaml: anchors are not supported")
		case yamlEventTag:
			return nil, codecErr(CodeCodecDecode, "yaml: explicit tags are not supported")
		case yamlEventAlias:
			return nil, codecErr(CodeCodecDecode, "yaml: aliases are not supported")
		case yamlEventDocument:
			return nil, codecErr(CodeCodecDecode, "yaml: multiple documents are not supported")
		case yamlEventSequence, yamlEventMapping:
			if len(stack)+1 > maxNesting {
				return nil, errNesting(CodeCodecDecode, "yaml")
			}
			if ev.key {
				return nil, codecErr(CodeCodecDecode, "yaml: map keys must be scalar strings")
			}
			f := &frame{isMap: ev.kind == yamlEventMapping}
			if f.isMap {
				f.object = map[string]any{}
			} else {
				f.list = []any{}
			}
			stack = append(stack, f)
		case yamlEventEnd:
			f := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if f.isMap {
				attach(f.object)
			} else {
				attach(f.list)
			}
		case yamlEventScalar:
			if ev.key {
				key, err := yamlKeyText(ev)
				if err != nil {
					return nil, err
				}
				f := stack[len(stack)-1]
				if _, repeated := f.object[key]; repeated {
					return nil, codecErr(CodeCodecDecode, "yaml: duplicate map key")
				}
				f.key, f.hasKey = key, true
				continue
			}
			v := any(ev.text)
			if ev.plain {
				var err error
				if v, err = yamlCoreScalar(ev.text); err != nil {
					return nil, err
				}
			}
			attach(v)
		}
	}
	if r.failed {
		line := int(r.lineOf(r.errAt))
		col := r.errAt
		for col > 0 && !yamlBreakChar(r.s[col-1]) {
			col--
		}
		cause := &yamlSyntaxError{Line: line, Column: r.errAt - col + 1, Reason: r.reason}
		return nil, codecCause(CodeCodecDecode, "yaml: the stream does not parse", cause)
	}
	if !r.document {
		return nil, codecErr(CodeCodecDecode, "yaml: no document")
	}
	return root, nil
}

// lineOf is the 1-based line of s[i]; CR LF is one line break.
func (r *yamlReader) lineOf(i int) int {
	line := 1
	for k := 0; k < i && k < len(r.s); k++ {
		if r.s[k] == '\n' || r.s[k] == '\r' && r.at(k+1) != '\n' {
			line++
		}
	}
	return line
}

// yamlKeyText is the string of a map key (COD-79): a plain key that resolves to an integer is the decimal text of its value,
// one that resolves to a null, a bool or a float is refused, and any other key is its text.
func yamlKeyText(ev yamlEvent) (string, error) {
	if !ev.plain {
		return ev.text, nil
	}
	switch ev.text {
	case "", "~", "null", "Null", "NULL", "true", "True", "TRUE", "false", "False", "FALSE":
		return "", codecErr(CodeCodecDecode, "yaml: map keys must be strings or integers")
	}
	if yamlCoreInt.MatchString(ev.text) {
		v, err := yamlCoreScalar(ev.text)
		if err != nil {
			return "", err
		}
		// yamlCoreScalar resolves the text of an integer of the core schema to its int64.
		return fmt.Sprint(v), nil
	}
	if yamlCoreFloat.MatchString(ev.text) || yamlCoreNonFinite.MatchString(ev.text) {
		return "", codecErr(CodeCodecDecode, "yaml: map keys must be strings or integers")
	}
	return ev.text, nil
}

// yamlSameValue reports whether got, which the reader read from a written text, is the value want (yaml-read-back): a
// float by its bits, so that -0.0 is not 0.0, and an integer by its value.
func yamlSameValue(want, got any) bool {
	switch w := want.(type) {
	case nil:
		return got == nil
	case bool, string:
		return got == w
	case int:
		return got == int64(w)
	case int32:
		return got == int64(w)
	case int64:
		return got == w
	case uint64:
		return w <= math.MaxInt64 && got == int64(w)
	case float64:
		g, ok := got.(float64)
		return ok && math.Float64bits(g) == math.Float64bits(w)
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return false
		}
		for i := range w {
			if !yamlSameValue(w[i], g[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok || len(g) != len(w) {
			return false
		}
		for k, v := range w {
			gv, ok := g[k]
			if !ok || !yamlSameValue(v, gv) {
				return false
			}
		}
		return true
	}
	return false
}
