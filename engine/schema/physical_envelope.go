package schema

import (
	"bytes"
	"unicode/utf8"
)

// PhysicalEnvelope contains byte ranges only, not a validated physical schema.
type PhysicalEnvelope struct{ Start, Body, Close, End int }
type PhysicalEnvelopeError struct{ line int }

func (e *PhysicalEnvelopeError) Error() string { return "SCHEMA_INVALID" }
func (e *PhysicalEnvelopeError) Line() int     { return e.line }
func envelopeError(line int) error             { return &PhysicalEnvelopeError{line: line} }

// LocatePhysicalEnvelope leaves input ownership with the caller. No line/body
// copies or Markdown/diagram interpretation are performed.
func LocatePhysicalEnvelope(source []byte) (PhysicalEnvelope, error) {
	var result PhysicalEnvelope
	fail := func(line int) (PhysicalEnvelope, error) { return PhysicalEnvelope{}, envelopeError(line) }
	if len(source) > 64*1024*1024 || !utf8.Valid(source) || bytes.HasPrefix(source, []byte{239, 187, 191}) {
		return fail(0)
	}
	lines := 1
	for i, c := range source {
		if c == '\n' {
			lines++
		}
		if lines > 200000 || c == '\r' && (i+1 == len(source) || source[i+1] != '\n') {
			return fail(0)
		}
	}
	active, run, opened, blocks, found := byte(0), 0, 0, 0, false
	owned := false
	for start, line := 0, 1; start < len(source); line++ {
		end := len(source)
		if n := bytes.IndexByte(source[start:], '\n'); n >= 0 {
			end = start + n + 1
		}
		contentEnd := end
		if contentEnd > start && source[contentEnd-1] == '\n' {
			contentEnd--
		}
		if contentEnd > start && source[contentEnd-1] == '\r' {
			contentEnd--
		}
		p := start
		for p < contentEnd && p-start < 4 && source[p] == ' ' {
			p++
		}
		if p-start <= 3 && p < contentEnd && (source[p] == '`' || source[p] == '~') {
			ch := source[p]
			q := p
			for q < contentEnd && source[q] == ch {
				q++
			}
			length := q - p
			left, right := q, contentEnd
			for left < right && (source[left] == ' ' || source[left] == '\t') {
				left++
			}
			for right > left && (source[right-1] == ' ' || source[right-1] == '\t') {
				right--
			}
			if active != 0 {
				if ch == active && length >= run && left == right {
					if owned {
						result.Close = start
						result.End = end
					}
					active = 0
					owned = false
				}
			} else if length >= 3 && (ch != '`' || !bytes.ContainsRune(source[q:contentEnd], '`')) {
				blocks++
				if blocks > 4096 {
					return fail(0)
				}
				info := source[left:right]
				owned = p == start && bytes.HasPrefix(info, []byte("mermaid orm-physical-"))
				if owned {
					if !bytes.Equal(info, []byte("mermaid orm-physical-v1")) || found {
						return fail(line)
					}
					found = true
					result.Start = start
					result.Body = end
				}
				active, run, opened = ch, length, line
			}
		}
		start = end
	}
	if active != 0 {
		return fail(opened)
	}
	if !found {
		return fail(0)
	}
	return result, nil
}
