package schema

import (
	"bytes"
	"regexp"
	"strings"
)

var physicalRawEnd = regexp.MustCompile(`</(?:[pP][rR][eE]|[sS][cC][rR][iI][pP][tT]|[sS][tT][yY][lL][eE]|[tT][eE][xX][tT][aA][rR][eE][aA])>`)

var physicalBlockTags = func() map[string]bool {
	tags := map[string]bool{}
	for _, tag := range strings.Fields("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul") {
		tags[tag] = true
	}
	return tags
}()

func physicalHTMLBlankStart(line []byte) bool {
	if len(line) < 2 || line[0] != '<' {
		return false
	}
	p := 1
	if line[p] == '/' {
		p++
	}
	start := p
	for p < len(line) && (line[p] >= 'a' && line[p] <= 'z' || line[p] >= 'A' && line[p] <= 'Z' || line[p] >= '0' && line[p] <= '9') {
		p++
		if p-start > 10 {
			return false
		}
	}
	if !physicalBlockTags[strings.ToLower(string(line[start:p]))] {
		return false
	}
	return p == len(line) || line[p] == ' ' || line[p] == '\t' || line[p] == '>' || line[p] == '/' && p+1 < len(line) && line[p+1] == '>'
}

// Find the terminator once per opaque block, not once per contained line.
// The returned offset ends on the terminating line; its suffix is still opaque.
func physicalHTMLEnd(source []byte, p, end int) (int, bool) {
	line := source[p:end]
	delimiter := ""
	switch {
	case bytes.HasPrefix(line, []byte("<!--")):
		delimiter = "-->"
	case bytes.HasPrefix(line, []byte("<?")):
		delimiter = "?>"
	case bytes.HasPrefix(line, []byte("<![CDATA[")):
		delimiter = "]]>"
	case len(line) > 2 && line[0] == '<' && line[1] == '!' && (line[2] >= 'A' && line[2] <= 'Z' || line[2] >= 'a' && line[2] <= 'z'):
		delimiter = ">"
	default:
		raw := false
		for _, tag := range []string{"pre", "script", "style", "textarea"} {
			if len(line) < len(tag)+1 || line[0] != '<' {
				continue
			}
			matched := true
			for i, c := range []byte(tag) {
				v := line[i+1]
				if v >= 'A' && v <= 'Z' {
					v += 32
				}
				if v != c {
					matched = false
					break
				}
			}
			n := len(tag) + 1
			if matched && (n == len(line) || line[n] == ' ' || line[n] == '\t' || line[n] == '>') {
				raw = true
				break
			}
		}
		if !raw {
			return 0, false
		}
		match := physicalRawEnd.FindIndex(source[p:])
		if match == nil {
			return -1, true
		}
		return p + match[1], true
	}
	match := bytes.Index(source[p:], []byte(delimiter))
	if match < 0 {
		return -1, true
	}
	return p + match + len(delimiter), true
}
