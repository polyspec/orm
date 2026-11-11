// Package message writes the names and texts of an error message with the quoting that every runtime shares (INT-187,
// DBS-144), so a message reads the same in every runtime.
package message

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"unicode/utf8"
)

// Quote is text between two delim characters: delim and a backslash take a backslash before them, the controls BEL, BS,
// FF, LF, CR, TAB and VT are written \a, \b, \f, \n, \r, \t and \v, any other code point below U+0020 and U+007F is \x
// and two lower-case hex digits, a byte that is not part of UTF-8 is \x and its two lower-case hex digits, and every
// other code point is written as it is. The quoting needs no Unicode table.
func Quote(text string, delim rune) string {
	var b strings.Builder
	b.WriteRune(delim)
	for i := 0; i < len(text); {
		r, size := utf8.DecodeRuneInString(text[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			hex(&b, text[i])
		case r == delim || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\a':
			b.WriteString(`\a`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\v':
			b.WriteString(`\v`)
		case r < 0x20 || r == 0x7f:
			hex(&b, byte(r))
		default:
			b.WriteRune(r)
		}
		i += size
	}
	b.WriteRune(delim)
	return b.String()
}

func hex(b *strings.Builder, c byte) {
	b.WriteString(`\x`)
	b.WriteByte("0123456789abcdef"[c>>4])
	b.WriteByte("0123456789abcdef"[c&0xf])
}

// Sprintf formats a message as fmt.Sprintf does, except that a %q of a text argument is Quote of it with double quotes and
// a %q of a rune is Quote of it with single quotes: the verb becomes %s and the argument its quoted text.
func Sprintf(format string, args ...any) string {
	format, args = quoting(format, args)
	return fmt.Sprintf(format, args...)
}

// Errorf is the error of Sprintf, which wraps an argument of %w as fmt.Errorf does.
func Errorf(format string, args ...any) error {
	format, args = quoting(format, args)
	return fmt.Errorf(format, args...)
}

// quoting is format and args with each %q of a text or a rune turned into %s of its quoted text.
func quoting(format string, args []any) (string, []any) {
	verbs := []byte(format)
	quoted := slices.Clone(args)
	arg := 0
	for i := 0; i < len(verbs); i++ {
		if verbs[i] != '%' {
			continue
		}
		j := i + 1
		for j < len(verbs) && strings.IndexByte("+-# 0123456789.", verbs[j]) >= 0 {
			j++
		}
		if j == len(verbs) {
			break
		}
		if verbs[j] != '%' {
			if arg < len(quoted) && verbs[j] == 'q' {
				// A %q of any other value has no shared quoting: it is written as fmt writes a verb of the wrong type, so the
				// message shows the mistake and no host quoting stands in for it.
				text, ok := quotedArgument(quoted[arg])
				if !ok {
					text = fmt.Sprintf("%%!q(%T=%v)", quoted[arg], quoted[arg])
				}
				verbs[j] = 's'
				quoted[arg] = text
			}
			arg++
		}
		i = j
	}
	return string(verbs), quoted
}

// quotedArgument is the quoted text of a %q argument: a value whose kind is string or a []byte in double quotes, and a
// rune in single quotes. A byte is not a character of a text, so it has none.
func quotedArgument(value any) (string, bool) {
	switch v := value.(type) {
	case []byte:
		return Quote(string(v), '"'), true
	case rune:
		return Quote(string(v), '\''), true
	}
	if v := reflect.ValueOf(value); v.Kind() == reflect.String {
		return Quote(v.String(), '"'), true
	}
	return "", false
}
