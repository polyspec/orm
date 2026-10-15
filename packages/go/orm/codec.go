package orm

// Column-style codecs (docs/codec.md): json/jsons, serialize, base64, gz, yaml.
// Styles are listed in write order; Decode applies them in reverse.

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/goccy/go-yaml/ast"
	yamlparser "github.com/goccy/go-yaml/parser"
	"github.com/goccy/go-yaml/token"
	orderedjson "github.com/polyspec/ordered-json/packages/go"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	goyaml "go.yaml.in/yaml/v3"
)

func codecErr(code, format string, a ...any) error {
	return &ir.Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}

func checkCodecStyles(styles []string) error {
	for _, style := range styles {
		switch style {
		case "gz", "base64", "serialize", "yaml", "ordered_json":
		default:
			return codecErr(CodeCodecUnsupported, "style %s", style)
		}
	}
	return nil
}

// Decode turns a stored cell (string/[]byte/nil) into a styled value.
// JSON and JSONS value variants contain *orderedjson.Value.
func Decode(styles []string, raw any) (StyledValue, error) {
	if err := checkCodecStyles(styles); err != nil {
		return StyledValue{}, err
	}
	var b []byte
	switch x := raw.(type) {
	case nil:
		return SqlNull(), nil
	case string:
		b = []byte(x)
	case []byte:
		b = x
	default:
		return StyledValue{}, codecErr(CodeCodecDecode, "cell is %T, not bytes", raw)
	}
	// An empty cell is CODEC_DECODE, except under a last base64 stage, whose encoder writes an empty cell
	// for empty bytes (docs/codec.md, Stage lists).
	if len(b) == 0 && (len(styles) == 0 || styles[len(styles)-1] != "base64") {
		return StyledValue{}, codecErr(CodeCodecDecode, "styled cell is empty")
	}
	var v any = b
	for i := len(styles) - 1; i >= 0; i-- {
		cur, ok := v.([]byte)
		if !ok {
			return StyledValue{}, codecErr(CodeCodecDecode, "style %s after a decoded value", styles[i])
		}
		var err error
		switch styles[i] {
		case "gz":
			r, e := zlib.NewReader(bytes.NewReader(cur))
			if e != nil {
				return StyledValue{}, codecErr(CodeCodecDecode, "gz: %v", e)
			}
			v, err = io.ReadAll(r)
			closeErr := r.Close()
			if err != nil {
				return StyledValue{}, codecErr(CodeCodecDecode, "gz: %v", err)
			}
			if closeErr != nil {
				return StyledValue{}, codecErr(CodeCodecDecode, "gz: %v", closeErr)
			}
		case "base64":
			// 저장 cell은 encoder가 쓰는 형태로만 decode한다: 공백, 줄바꿈, 빠진 padding, 0이 아닌
			// padding bit는 CODEC_DECODE다(docs/codec.md). Go의 decoder는 \r과 \n을 건너뛰므로 따로 거절한다.
			if bytes.ContainsAny(cur, "\r\n") {
				return StyledValue{}, codecErr(CodeCodecDecode, "base64: line break in stored text")
			}
			v, err = base64.StdEncoding.Strict().DecodeString(string(cur))
			if err != nil {
				return StyledValue{}, codecErr(CodeCodecDecode, "base64: %v", err)
			}
		case "serialize":
			v, err = phpUnserialize(cur)
			if err != nil {
				return StyledValue{}, err
			}
		case "yaml":
			v, err = yamlDecode(cur)
			if err != nil {
				return StyledValue{}, err
			}
		case "ordered_json":
			v, err = orderedjson.ParseBytes(cur)
			if err != nil {
				return StyledValue{}, codecErr(CodeCodecDecode, "json: %v", err)
			}
		default:
			return StyledValue{}, codecErr(CodeCodecUnsupported, "style %s", styles[i])
		}
	}
	// 첫 stage가 gz나 base64면 값은 그 stage가 받은 text다.
	if raw, ok := v.([]byte); ok {
		if !utf8.Valid(raw) {
			return StyledValue{}, codecErr(CodeCodecDecode, "decoded text is not valid UTF-8")
		}
		return Value(string(raw)), nil
	}
	return Value(v), nil
}

// Encode turns a value into the stored representation (string, or []byte for gz).
func Encode(styles []string, v StyledValue) (any, error) {
	if err := checkCodecStyles(styles); err != nil {
		return nil, err
	}
	if v.kind == 1 {
		return nil, nil
	}
	if v.kind != 2 {
		return nil, codecErr(CodeCodecEncode, "styled value is unset")
	}
	var cur []byte
	var err error
	value := v.value
	for i, st := range styles {
		switch st {
		case "serialize":
			if i != 0 {
				return nil, codecErr(CodeCodecUnsupported, "serialize must be the first encoding style")
			}
			var sb strings.Builder
			if err := phpSerialize(&sb, value); err != nil {
				return nil, err
			}
			cur = []byte(sb.String())
		case "yaml":
			if i != 0 {
				return nil, codecErr(CodeCodecUnsupported, "yaml must be the first style")
			}
			var err error
			cur, err = goyaml.Marshal(value)
			if err != nil {
				return nil, codecErr(CodeCodecEncode, "yaml: %v", err)
			}
			if _, err := yamlDecode(cur); err != nil {
				return nil, codecErr(CodeCodecEncode, "yaml: encoded value is outside the common value model: %v", err)
			}
		case "ordered_json":
			if i != 0 {
				return nil, codecErr(CodeCodecUnsupported, "json must be the first style")
			}
			ordered, err := orderedJSONValue(value)
			if err != nil {
				return nil, err
			}
			raw, err := ordered.Compact()
			if err != nil {
				return nil, codecErr(CodeCodecEncode, "json: %v", err)
			}
			cur = []byte(raw)
		case "base64":
			if i == 0 {
				if cur, err = firstStageText(st, value); err != nil {
					return nil, err
				}
			}
			cur = []byte(base64.StdEncoding.EncodeToString(cur))
		case "gz":
			if i == 0 {
				if cur, err = firstStageText(st, value); err != nil {
					return nil, err
				}
			}
			var buf bytes.Buffer
			w, err := zlib.NewWriterLevel(&buf, zlib.BestCompression)
			if err != nil {
				return nil, codecErr(CodeCodecEncode, "gz: %v", err)
			}
			if _, err := w.Write(cur); err != nil {
				return nil, codecErr(CodeCodecEncode, "gz: %v", err)
			}
			if err := w.Close(); err != nil {
				return nil, codecErr(CodeCodecEncode, "gz: %v", err)
			}
			return buf.Bytes(), nil
		default:
			return nil, codecErr(CodeCodecUnsupported, "style %s", st)
		}
	}
	return string(cur), nil
}

// firstStageText는 첫 stage인 gz나 base64가 encode하는 값이다. 그 stage는
// byte를 받으므로 값은 string이어야 한다.
func firstStageText(stage string, value any) ([]byte, error) {
	s, ok := value.(string)
	if !ok {
		return nil, codecErr(CodeCodecEncode, "%s as the first stage encodes a string value, got %T", stage, value)
	}
	return []byte(s), nil
}

// NormalizeStyled validates a generated setter input and returns its decoded
// value model so an in-memory model matches a row read from storage.
func NormalizeStyled(styles []string, nullable bool, v StyledValue) (StyledValue, error) {
	if v.kind == 1 && !nullable {
		return StyledValue{}, codecErr(CodeCodecEncode, "SQL NULL is not allowed for this column")
	}
	stored, err := Encode(styles, v)
	if err != nil {
		return StyledValue{}, err
	}
	return Decode(styles, stored)
}

// yamlDecode reads one YAML 1.2 document. goccy/go-yaml reads U+0085 as content, as YAML 1.2
// rules (5.4), where yaml.v3 reads it as a line break; its AST keeps each scalar's source text
// and style, so the plain scalars resolve by the core schema below.
func yamlDecode(b []byte) (any, error) {
	file, err := yamlparser.ParseBytes(b, 0)
	if err != nil {
		return nil, codecErr(CodeCodecDecode, "yaml: %v", err)
	}
	switch len(file.Docs) {
	case 0:
		return nil, codecErr(CodeCodecDecode, "yaml: no document")
	case 1:
	default:
		return nil, codecErr(CodeCodecDecode, "yaml: multiple documents are not supported")
	}
	if doc := file.Docs[0]; doc.Body == nil {
		// A stream without content has no document; `---` alone is a null document.
		if doc.Start == nil {
			return nil, codecErr(CodeCodecDecode, "yaml: no document")
		}
		return nil, nil
	}
	return yamlNode(file.Docs[0].Body)
}

func yamlLine(node ast.Node) int {
	if t := node.GetToken(); t != nil && t.Position != nil {
		return t.Position.Line
	}
	return 0
}

func yamlNode(node ast.Node) (any, error) {
	switch n := node.(type) {
	case *ast.SequenceNode:
		out := make([]any, len(n.Values))
		for i, item := range n.Values {
			var err error
			out[i], err = yamlNode(item)
			if err != nil {
				return nil, err
			}
		}
		return out, nil
	case *ast.MappingNode:
		return yamlMapping(n.Values)
	case *ast.MappingValueNode:
		return yamlMapping([]*ast.MappingValueNode{n})
	case *ast.TagNode:
		return nil, codecErr(CodeCodecDecode, "yaml: explicit tag %q at line %d is not supported", n.Start.Value, yamlLine(n))
	case *ast.AliasNode:
		return nil, codecErr(CodeCodecDecode, "yaml: aliases are not supported at line %d", yamlLine(n))
	case *ast.AnchorNode:
		return nil, codecErr(CodeCodecDecode, "yaml: anchors are not supported at line %d", yamlLine(n))
	case *ast.LiteralNode:
		return n.Value.Value, nil
	}
	if text, plain, ok := yamlScalar(node); ok {
		if plain {
			return yamlCoreScalar(text, yamlLine(node))
		}
		return text, nil
	}
	return nil, codecErr(CodeCodecDecode, "yaml: node %s at line %d is not supported", node.Type(), yamlLine(node))
}

func yamlMapping(values []*ast.MappingValueNode) (map[string]any, error) {
	out := make(map[string]any, len(values))
	for _, item := range values {
		key, err := yamlMapKey(item.Key)
		if err != nil {
			return nil, err
		}
		if _, exists := out[key]; exists {
			return nil, codecErr(CodeCodecDecode, "yaml: duplicate map key %q at line %d", key, yamlLine(item.Key))
		}
		value, err := yamlNode(item.Value)
		if err != nil {
			return nil, err
		}
		out[key] = value
	}
	return out, nil
}

// yamlScalar returns a scalar's text and whether it is plain, whose tag the reader resolves.
// The AST types goccy/go-yaml gives plain scalars follow its own resolution, so only the
// source text and the style are used.
func yamlScalar(node ast.Node) (string, bool, bool) {
	switch n := node.(type) {
	case *ast.LiteralNode:
		return n.Value.Value, false, true
	case ast.ScalarNode:
		t := n.GetToken()
		if t == nil {
			return "", false, false
		}
		switch t.Type {
		case token.SingleQuoteType, token.DoubleQuoteType:
			return t.Value, false, true
		}
		return t.Value, true, true
	}
	return "", false, false
}

var (
	yamlCoreInt   = regexp.MustCompile(`^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$`)
	yamlCoreFloat = regexp.MustCompile(`^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$`)
)

// yamlCoreScalar resolves a plain scalar by the tags of the YAML 1.2 core schema (YAML 1.2.2,
// 10.3.2): null, bool, int and float by their regular expressions, and str otherwise. An
// integer outside int64 and a float that is not finite are outside the common value model.
func yamlCoreScalar(text string, line int) (any, error) {
	switch text {
	case "", "~", "null", "Null", "NULL":
		return nil, nil
	case "true", "True", "TRUE":
		return true, nil
	case "false", "False", "FALSE":
		return false, nil
	}
	switch {
	case yamlCoreInt.MatchString(text):
		var value int64
		var err error
		switch {
		case strings.HasPrefix(text, "0o"):
			value, err = strconv.ParseInt(text[2:], 8, 64)
		case strings.HasPrefix(text, "0x"):
			value, err = strconv.ParseInt(text[2:], 16, 64)
		default:
			value, err = strconv.ParseInt(text, 10, 64)
		}
		if err != nil {
			return nil, codecErr(CodeCodecDecode, "yaml: integer %s at line %d is outside the int64 range", text, line)
		}
		return value, nil
	case yamlCoreFloat.MatchString(text):
		value, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, codecErr(CodeCodecDecode, "yaml: non-finite or invalid float %s at line %d", text, line)
		}
		return value, nil
	}
	return text, nil
}

func yamlMapKey(node ast.Node) (string, error) {
	line := yamlLine(node)
	var value any
	var err error
	switch node.(type) {
	case *ast.TagNode, *ast.AnchorNode, *ast.AliasNode:
		// yamlNode refuses each of these forms.
		_, err = yamlNode(node)
		return "", err
	default:
		text, plain, ok := yamlScalar(node)
		switch {
		case !ok:
			return "", codecErr(CodeCodecDecode, "yaml: map keys must be scalar strings at line %d", line)
		case plain:
			value, err = yamlCoreScalar(text, line)
		default:
			value = text
		}
	}
	if err != nil {
		return "", err
	}
	switch v := value.(type) {
	case string:
		return v, nil
	case int64:
		return strconv.FormatInt(v, 10), nil
	}
	return "", codecErr(CodeCodecDecode, "yaml: map keys must be strings or integers at line %d", line)
}

// ---- PHP serialize format ----

func phpSerialize(sb *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		sb.WriteString("N;")
	case bool:
		if x {
			sb.WriteString("b:1;")
		} else {
			sb.WriteString("b:0;")
		}
	case int:
		sb.WriteString("i:" + strconv.Itoa(x) + ";")
	case int32:
		sb.WriteString("i:" + strconv.FormatInt(int64(x), 10) + ";")
	case int64:
		sb.WriteString("i:" + strconv.FormatInt(x, 10) + ";")
	case float64:
		sb.WriteString("d:" + phpFloat(x) + ";")
	case string:
		sb.WriteString("s:" + strconv.Itoa(len(x)) + ":\"" + x + "\";")
	case []any:
		sb.WriteString("a:" + strconv.Itoa(len(x)) + ":{")
		for i, e := range x {
			sb.WriteString("i:" + strconv.Itoa(i) + ";")
			if err := phpSerialize(sb, e); err != nil {
				return err
			}
		}
		sb.WriteString("}")
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		sb.WriteString("a:" + strconv.Itoa(len(x)) + ":{")
		for _, k := range keys {
			if n, ok := phpIntKey(k); ok {
				sb.WriteString("i:" + strconv.FormatInt(n, 10) + ";")
			} else {
				sb.WriteString("s:" + strconv.Itoa(len(k)) + ":\"" + k + "\";")
			}
			if err := phpSerialize(sb, x[k]); err != nil {
				return err
			}
		}
		sb.WriteString("}")
	default:
		return codecErr(CodeCodecEncode, "cannot serialize %T", v)
	}
	return nil
}

// phpIntKey mirrors PHP's array-key normalization: canonical decimal integers become int keys.
func phpIntKey(k string) (int64, bool) {
	if k == "" || k == "-0" || (len(k) > 1 && k[0] == '0') || (len(k) > 2 && k[0] == '-' && k[1] == '0') {
		return 0, false
	}
	n, err := strconv.ParseInt(k, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// phpFloat formats like PHP's serialize_precision=-1: shortest round-trip,
// integral values without a fraction ("d:2;"), exponent form as "1.0E+25".
func phpFloat(f float64) string {
	if math.IsInf(f, 1) {
		return "INF"
	}
	if math.IsInf(f, -1) {
		return "-INF"
	}
	if math.IsNaN(f) {
		return "NAN"
	}
	s := strconv.FormatFloat(f, 'g', -1, 64)
	if i := strings.IndexByte(s, 'e'); i >= 0 {
		mant, exp := s[:i], s[i+1:]
		if !strings.Contains(mant, ".") {
			mant += ".0"
		}
		sign := exp[0]
		exp = strings.TrimLeft(exp[1:], "0")
		if exp == "" {
			exp = "0"
		}
		return mant + "E" + string(sign) + exp
	}
	return s
}

func phpUnserialize(b []byte) (any, error) {
	p := &phpParser{b: b}
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	if p.i != len(b) {
		return nil, codecErr(CodeCodecDecode, "serialize: trailing data at %d", p.i)
	}
	return v, nil
}

type phpParser struct {
	b []byte
	i int
}

func (p *phpParser) fail(msg string) error {
	return codecErr(CodeCodecDecode, "serialize: %s at %d", msg, p.i)
}

func (p *phpParser) expect(c byte) error {
	if p.i >= len(p.b) || p.b[p.i] != c {
		return p.fail("expected " + string(c))
	}
	p.i++
	return nil
}

func (p *phpParser) until(c byte) (string, error) {
	j := bytes.IndexByte(p.b[p.i:], c)
	if j < 0 {
		return "", p.fail("expected " + string(c))
	}
	s := string(p.b[p.i : p.i+j])
	p.i += j + 1
	return s, nil
}

func (p *phpParser) value() (any, error) {
	if p.i >= len(p.b) {
		return nil, p.fail("unexpected end")
	}
	t := p.b[p.i]
	p.i++
	switch t {
	case 'N':
		return nil, p.expect(';')
	case 'b', 'i', 'd':
		if err := p.expect(':'); err != nil {
			return nil, err
		}
		s, err := p.until(';')
		if err != nil {
			return nil, err
		}
		switch t {
		case 'b':
			return s == "1", nil
		case 'i':
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil {
				return nil, p.fail("bad int " + s)
			}
			return n, nil
		default:
			switch s {
			case "INF":
				return math.Inf(1), nil
			case "-INF":
				return math.Inf(-1), nil
			case "NAN":
				return math.NaN(), nil
			}
			f, err := strconv.ParseFloat(s, 64)
			if err != nil {
				return nil, p.fail("bad float " + s)
			}
			return f, nil
		}
	case 's':
		if err := p.expect(':'); err != nil {
			return nil, err
		}
		ls, err := p.until(':')
		if err != nil {
			return nil, err
		}
		n, err := strconv.Atoi(ls)
		if err != nil || n < 0 {
			return nil, p.fail("bad string length")
		}
		if err := p.expect('"'); err != nil {
			return nil, err
		}
		if p.i+n > len(p.b) {
			return nil, p.fail("string overruns input")
		}
		s := string(p.b[p.i : p.i+n])
		p.i += n
		if err := p.expect('"'); err != nil {
			return nil, err
		}
		return s, p.expect(';')
	case 'a':
		if err := p.expect(':'); err != nil {
			return nil, err
		}
		ls, err := p.until(':')
		if err != nil {
			return nil, err
		}
		n, err := strconv.Atoi(ls)
		if err != nil || n < 0 {
			return nil, p.fail("bad array length")
		}
		if err := p.expect('{'); err != nil {
			return nil, err
		}
		keys := make([]string, 0, n)
		vals := make([]any, 0, n)
		sequential := true
		for k := 0; k < n; k++ {
			kv, err := p.value()
			if err != nil {
				return nil, err
			}
			var key string
			switch x := kv.(type) {
			case int64:
				key = strconv.FormatInt(x, 10)
				if x != int64(k) {
					sequential = false
				}
			case string:
				key = x
				sequential = false
			default:
				return nil, p.fail("array key must be int or string")
			}
			v, err := p.value()
			if err != nil {
				return nil, err
			}
			keys = append(keys, key)
			vals = append(vals, v)
		}
		if err := p.expect('}'); err != nil {
			return nil, err
		}
		if sequential {
			return vals, nil
		}
		m := make(map[string]any, n)
		for k := range keys {
			m[keys[k]] = vals[k]
		}
		return m, nil
	case 'O', 'C', 'r', 'R':
		return nil, codecErr(CodeCodecUnsupported, "serialize: objects and references are not supported (%c)", t)
	}
	return nil, p.fail(fmt.Sprintf("unknown type %q", t))
}

// styledCols lists the positional columns of a step that need decoding (joins included).
func styledCols(a *plan.Assemble) []plan.OutCol {
	var out []plan.OutCol
	for _, c := range a.Columns {
		if len(c.Styles) > 0 {
			out = append(out, c)
		}
	}
	for _, ch := range a.Children {
		if ch.Kind == "join" {
			out = append(out, styledCols(ch.Assemble)...)
		}
	}
	return out
}
