package schema

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const physicalJSONBytes = 32 * 1024 * 1024

var physicalJSONNumber = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$`)

type physicalJSONScanner struct {
	text       []byte
	pos, nodes int
}

func (s *physicalJSONScanner) space() {
	for s.pos < len(s.text) && strings.ContainsRune(" \r\n\t", rune(s.text[s.pos])) {
		s.pos++
	}
}
func (s *physicalJSONScanner) peek() byte {
	if s.pos >= len(s.text) {
		return 0
	}
	return s.text[s.pos]
}
func (s *physicalJSONScanner) take(c byte) bool {
	if s.peek() != c {
		return false
	}
	s.pos++
	return true
}
func (s *physicalJSONScanner) str() (string, error) {
	start := s.pos
	if !s.take('"') {
		return "", graphError("")
	}
	for s.pos < len(s.text) {
		c := s.text[s.pos]
		s.pos++
		if c == '"' {
			var value string
			if json.Unmarshal(s.text[start:s.pos], &value) != nil {
				return "", graphError("")
			}
			return value, nil
		}
		if c < 32 {
			return "", graphError("")
		}
		if c == '\\' {
			if s.pos >= len(s.text) {
				return "", graphError("")
			}
			escape := s.text[s.pos]
			s.pos++
			if escape == 'u' {
				code, err := s.hex()
				if err != nil {
					return "", err
				}
				if code >= 0xd800 && code <= 0xdbff {
					if !s.take('\\') || !s.take('u') {
						return "", graphError("")
					}
					low, err := s.hex()
					if err != nil || low < 0xdc00 || low > 0xdfff {
						return "", graphError("")
					}
				} else if code >= 0xdc00 && code <= 0xdfff {
					return "", graphError("")
				}
			} else if !strings.ContainsRune(`"\/bfnrt`, rune(escape)) {
				return "", graphError("")
			}
		}
	}
	return "", graphError("")
}
func (s *physicalJSONScanner) hex() (uint64, error) {
	if len(s.text)-s.pos < 4 {
		return 0, graphError("")
	}
	code, err := strconv.ParseUint(string(s.text[s.pos:s.pos+4]), 16, 16)
	if err != nil {
		return 0, graphError("")
	}
	s.pos += 4
	return code, nil
}
func exactPhysicalJSONNumber(token string) bool {
	if len(token) > 64 || !physicalJSONNumber.MatchString(token) {
		return false
	}
	parts := strings.Split(strings.ToLower(strings.TrimPrefix(token, "-")), "e")
	mantissa := strings.Split(parts[0], ".")
	fraction := ""
	if len(mantissa) == 2 {
		fraction = mantissa[1]
	}
	digits := strings.TrimLeft(mantissa[0]+fraction, "0")
	if digits == "" {
		return true
	}
	exponent := 0
	if len(parts) == 2 {
		var err error
		exponent, err = strconv.Atoi(parts[1])
		if err != nil {
			return false
		}
	}
	if exponent < -128 || exponent > 128 {
		return false
	}
	shift := exponent - len(fraction)
	if shift < -64 || shift > 64 {
		return false
	}
	if shift < 0 {
		remove := -shift
		if remove > len(digits) || strings.Trim(digits[len(digits)-remove:], "0") != "" {
			return false
		}
		digits = digits[:len(digits)-remove]
	} else {
		if len(digits)+shift > 16 {
			return false
		}
		digits += strings.Repeat("0", shift)
	}
	return len(digits) < 16 || (len(digits) == 16 && digits <= "9007199254740991")
}
func (s *physicalJSONScanner) value(depth int) error {
	s.space()
	s.nodes++
	if s.nodes > 3000000 {
		return graphError("")
	}
	c := s.peek()
	if c == '{' || c == '[' {
		if depth >= 16 {
			return graphError("")
		}
		s.pos++
		object := c == '{'
		close := byte(']')
		if object {
			close = '}'
		}
		s.space()
		if s.take(close) {
			return nil
		}
		keys := map[string]bool{}
		for {
			if object {
				s.space()
				key, err := s.str()
				if err != nil || keys[key] {
					return graphError("")
				}
				keys[key] = true
				s.space()
				if !s.take(':') {
					return graphError("")
				}
			}
			if err := s.value(depth + 1); err != nil {
				return err
			}
			s.space()
			if s.take(close) {
				return nil
			}
			if !s.take(',') {
				return graphError("")
			}
		}
	}
	if c == '"' {
		_, err := s.str()
		return err
	}
	for _, literal := range []string{"true", "false", "null"} {
		if bytes.HasPrefix(s.text[s.pos:], []byte(literal)) {
			s.pos += len(literal)
			return nil
		}
	}
	if c == '-' || (c >= '0' && c <= '9') {
		start := s.pos
		for s.pos < len(s.text) && !strings.ContainsRune(" \r\n\t,]}", rune(s.text[s.pos])) {
			s.pos++
		}
		if exactPhysicalJSONNumber(string(s.text[start:s.pos])) {
			return nil
		}
	}
	return graphError("")
}
func PhysicalGraphFromJSON(text []byte) (*PhysicalGraph, error) {
	value, err := decodePhysicalJSON(text)
	if err != nil {
		return nil, err
	}
	root, ok := value.(map[string]any)
	if !ok {
		return nil, graphError("")
	}
	return PhysicalGraphFromValue(root)
}
func decodePhysicalJSON(text []byte) (any, error) {
	if len(text) > physicalJSONBytes || !utf8.Valid(text) {
		return nil, graphError("")
	}
	scan := physicalJSONScanner{text: text}
	if err := scan.value(0); err != nil {
		return nil, err
	}
	scan.space()
	if scan.pos != len(text) {
		return nil, graphError("")
	}
	var value any
	if json.Unmarshal(text, &value) != nil {
		return nil, graphError("")
	}
	return value, nil
}
func (graph *PhysicalGraph) JSON() ([]byte, error) {
	if graph == nil || graph.value == nil {
		return nil, graphError("")
	}
	text, err := json.Marshal(graph.value)
	if err != nil || len(text) > physicalJSONBytes {
		return nil, graphError("")
	}
	return text, nil
}
