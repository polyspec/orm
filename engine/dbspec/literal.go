package dbspec

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// CanonicalLiteral returns the canonical text of text, a literal written as
// the default of a column of type t, or false when text is not a literal of
// t. A literal is one token on one line with no space around it: a number
// whose minus sign is attached, a word (true, false or now) or a quoted
// string. A text or bytes column has no literal.
func CanonicalLiteral(t Type, text string) (string, bool) {
	v, ok := literalToken(text)
	if !ok {
		return "", false
	}
	canonical, ok := canonicalDefault(t, v)
	if !ok {
		return "", false
	}
	return canonical, true
}

// literalToken lexes text as one literal token. A minus sign attached to a
// number belongs to the number, as the parser reads a default value.
func literalToken(text string) (token, bool) {
	if text != strings.Trim(text, " ") || strings.ContainsAny(text, "\r\n") {
		return token{}, false
	}
	tokens, _, bad := lexLine(text, 1)
	if bad != nil {
		return token{}, false
	}
	switch {
	case len(tokens) == 1 && tokens[0].kind != tokenPunct && tokens[0].kind != tokenOperator:
		return tokens[0], true
	case len(tokens) == 2 && tokens[0].is(tokenOperator, "-") && tokens[1].kind == tokenNumber && tokens[1].col == tokens[0].col+1:
		return token{kind: tokenNumber, text: "-" + tokens[1].text, line: 1, col: 1}, true
	}
	return token{}, false
}

// canonicalDefault returns the canonical text of a default value v for a
// column of type t, or false when v is not a literal of t. Callers handle
// text and bytes, which have no default.
func canonicalDefault(t Type, v token) (string, bool) {
	if v.is(tokenWord, "now") {
		return "now", t.Kind == TypeDatetime
	}
	switch t.Kind {
	case TypeI16, TypeI32, TypeI64:
		if v.kind != tokenNumber || strings.Contains(v.text, ".") {
			return "", false
		}
		text := canonicalNumber(v.text)
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return "", false
		}
		switch t.Kind {
		case TypeI16:
			return text, n >= math.MinInt16 && n <= math.MaxInt16
		case TypeI32:
			return text, n >= math.MinInt32 && n <= math.MaxInt32
		}
		return text, true
	case TypeBool:
		return v.text, v.is(tokenWord, "true") || v.is(tokenWord, "false")
	case TypeDecimal:
		if v.kind != tokenNumber {
			return "", false
		}
		return canonicalDecimal(v.text, t.Precision, t.Scale)
	case TypeF64:
		if v.kind != tokenNumber {
			return "", false
		}
		f, err := strconv.ParseFloat(v.text, 64)
		if err != nil {
			return "", false
		}
		if f == 0 {
			return "0", true
		}
		return strconv.FormatFloat(f, 'f', -1, 64), true
	case TypeVarchar:
		if v.kind != tokenString || strings.ContainsRune(v.text, 0) || utf8.RuneCountInString(v.text) > t.Length {
			return "", false
		}
		return quote(v.text), true
	case TypeUUID:
		if v.kind != tokenString || !isUUID(v.text) {
			return "", false
		}
		return quote(strings.ToLower(v.text)), true
	case TypeDate:
		if v.kind != tokenString || !isDate(v.text) {
			return "", false
		}
		return quote(v.text), true
	case TypeTime:
		if v.kind != tokenString {
			return "", false
		}
		text, ok := canonicalTime(v.text, t.Precision)
		return quote(text), ok
	case TypeDatetime:
		if v.kind != tokenString || len(v.text) < 11 || v.text[10] != ' ' || !isDate(v.text[:10]) {
			return "", false
		}
		text, ok := canonicalTime(v.text[11:], t.Precision)
		return quote(v.text[:11] + text), ok
	}
	return "", false
}

// canonicalDecimal writes a decimal with exactly scale fraction digits; more
// fraction digits than the scale are an error, even when they are zeros.
func canonicalDecimal(s string, precision, scale int) (string, bool) {
	negative := strings.HasPrefix(s, "-")
	integer, fraction, _ := strings.Cut(strings.TrimPrefix(s, "-"), ".")
	integer = strings.TrimLeft(integer, "0")
	if len(fraction) > scale {
		return "", false
	}
	fraction += strings.Repeat("0", scale-len(fraction))
	if len(integer) > precision-scale {
		return "", false
	}
	if integer == "" {
		integer = "0"
	}
	out := integer
	if scale > 0 {
		out += "." + fraction
	}
	if negative && strings.Trim(out, "0.") != "" {
		out = "-" + out
	}
	return out, true
}

func digits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F')) {
				return false
			}
		}
	}
	return true
}

// isDate reports whether s is YYYY-MM-DD from 0001-01-01 to 9999-12-31.
func isDate(s string) bool {
	if len(s) != 10 || s[4] != '-' || s[7] != '-' || !digits(s[:4]) || !digits(s[5:7]) || !digits(s[8:]) {
		return false
	}
	year, _ := strconv.Atoi(s[:4])
	month, _ := strconv.Atoi(s[5:7])
	day, _ := strconv.Atoi(s[8:])
	if year < 1 || month < 1 || month > 12 || day < 1 {
		return false
	}
	days := [...]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}[month-1]
	if month == 2 && year%4 == 0 && (year%100 != 0 || year%400 == 0) {
		days = 29
	}
	return day <= days
}

// canonicalTime checks HH:MM:SS[.fraction] below 24:00:00 and writes it with
// exactly precision fraction digits; more fraction digits are an error.
func canonicalTime(s string, precision int) (string, bool) {
	clock, fraction, hasFraction := strings.Cut(s, ".")
	if len(clock) != 8 || clock[2] != ':' || clock[5] != ':' || !digits(clock[:2]) || !digits(clock[3:5]) || !digits(clock[6:]) {
		return "", false
	}
	if hasFraction && !digits(fraction) {
		return "", false
	}
	hour, _ := strconv.Atoi(clock[:2])
	minute, _ := strconv.Atoi(clock[3:5])
	second, _ := strconv.Atoi(clock[6:])
	if hour > 23 || minute > 59 || second > 59 {
		return "", false
	}
	if len(fraction) > precision {
		return "", false
	}
	fraction += strings.Repeat("0", precision-len(fraction))
	if precision > 0 {
		return clock + "." + fraction, true
	}
	return clock, true
}
