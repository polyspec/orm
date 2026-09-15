package orm

// Column-style codecs (docs/codec.md): json/jsons, serialize, base64, gz, curlfile, yaml.
// Styles are listed in write order; Decode applies them in reverse.

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"

	orderedjson "github.com/polyspec/ordered-json/go"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	goyaml "go.yaml.in/yaml/v3"
)

func codecErr(code, format string, a ...any) error {
	return &ir.Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}

// Decode turns a stored cell (string/[]byte/nil) into the declared value model.
// JSON and JSONS return *orderedjson.Value so object order and node kinds remain explicit.
func Decode(styles []string, raw any) (any, error) {
	var b []byte
	switch x := raw.(type) {
	case nil:
		return nil, nil
	case string:
		b = []byte(x)
	case []byte:
		b = x
	default:
		return nil, codecErr(CodeCodecDecode, "cell is %T, not bytes", raw)
	}
	if len(b) == 0 {
		return nil, nil
	}
	var v any = b
	for i := len(styles) - 1; i >= 0; i-- {
		if styles[i] == "curlfile" {
			if _, ok := v.([]byte); ok {
				return nil, codecErr(CodeCodecUnsupported, "curlfile must precede serialize on write")
			}
			var err error
			v, err = restoreUploadFiles(v)
			if err != nil {
				return nil, err
			}
			continue
		}
		cur, ok := v.([]byte)
		if !ok {
			return nil, codecErr(CodeCodecDecode, "style %s after a decoded value", styles[i])
		}
		var err error
		switch styles[i] {
		case "gz":
			r, e := zlib.NewReader(bytes.NewReader(cur))
			if e != nil {
				return nil, codecErr(CodeCodecDecode, "gz: %v", e)
			}
			v, err = io.ReadAll(r)
			r.Close()
			if err != nil {
				return nil, codecErr(CodeCodecDecode, "gz: %v", err)
			}
		case "base64":
			v, err = base64.StdEncoding.DecodeString(strings.TrimSpace(string(cur)))
			if err != nil {
				return nil, codecErr(CodeCodecDecode, "base64: %v", err)
			}
		case "serialize":
			v, err = phpUnserialize(cur)
			if err != nil {
				return nil, err
			}
		case "yaml":
			v, err = yamlDecode(cur)
			if err != nil {
				return nil, err
			}
		case "json", "jsons":
			v, err = orderedjson.ParseBytes(cur)
			if err != nil {
				return nil, codecErr(CodeCodecDecode, "json: %v", err)
			}
		default:
			return nil, codecErr(CodeCodecUnsupported, "style %s", styles[i])
		}
	}
	if raw, ok := v.([]byte); ok { // e.g. styles = [] — never happens for styled columns
		return string(raw), nil
	}
	return v, nil
}

// Encode turns a value into the stored representation (string, or []byte for gz).
func Encode(styles []string, v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	var cur []byte
	value := v
	for i, st := range styles {
		switch st {
		case "curlfile":
			if i != 0 {
				return nil, codecErr(CodeCodecUnsupported, "curlfile must be the first style")
			}
			var err error
			value, err = prepareUploadFiles(value)
			if err != nil {
				return nil, err
			}
		case "serialize":
			if i != 0 && !(i == 1 && styles[0] == "curlfile") {
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
		case "json", "jsons":
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
			cur = []byte(base64.StdEncoding.EncodeToString(cur))
		case "gz":
			var buf bytes.Buffer
			w, _ := zlib.NewWriterLevel(&buf, zlib.BestCompression)
			w.Write(cur)
			w.Close()
			return buf.Bytes(), nil
		default:
			return nil, codecErr(CodeCodecUnsupported, "style %s", st)
		}
	}
	return string(cur), nil
}

func yamlDecode(b []byte) (any, error) {
	dec := goyaml.NewDecoder(bytes.NewReader(b))
	var doc goyaml.Node
	if err := dec.Decode(&doc); err != nil {
		return nil, codecErr(CodeCodecDecode, "yaml: %v", err)
	}
	var extra goyaml.Node
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, codecErr(CodeCodecDecode, "yaml: multiple documents are not supported")
		}
		return nil, codecErr(CodeCodecDecode, "yaml: %v", err)
	}
	return yamlNode(&doc)
}

func yamlNode(node *goyaml.Node) (any, error) {
	switch node.Kind {
	case goyaml.DocumentNode:
		if len(node.Content) != 1 {
			return nil, codecErr(CodeCodecDecode, "yaml: document must contain one value")
		}
		return yamlNode(node.Content[0])
	case goyaml.SequenceNode:
		out := make([]any, len(node.Content))
		for i, item := range node.Content {
			var err error
			out[i], err = yamlNode(item)
			if err != nil {
				return nil, err
			}
		}
		return out, nil
	case goyaml.MappingNode:
		out := make(map[string]any, len(node.Content)/2)
		for i := 0; i < len(node.Content); i += 2 {
			key, err := yamlMapKey(node.Content[i])
			if err != nil {
				return nil, err
			}
			if _, exists := out[key]; exists {
				return nil, codecErr(CodeCodecDecode, "yaml: duplicate map key %q at line %d", key, node.Content[i].Line)
			}
			value, err := yamlNode(node.Content[i+1])
			if err != nil {
				return nil, err
			}
			out[key] = value
		}
		return out, nil
	case goyaml.ScalarNode:
		switch node.Tag {
		case "!!null":
			return nil, nil
		case "!!bool":
			return strings.EqualFold(node.Value, "true"), nil
		case "!!int":
			var value int64
			if err := node.Decode(&value); err != nil {
				return nil, codecErr(CodeCodecDecode, "yaml: integer at line %d: %v", node.Line, err)
			}
			return value, nil
		case "!!float":
			var value float64
			if err := node.Decode(&value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
				return nil, codecErr(CodeCodecDecode, "yaml: non-finite or invalid float at line %d", node.Line)
			}
			return value, nil
		case "!!str":
			return node.Value, nil
		default:
			return nil, codecErr(CodeCodecDecode, "yaml: tag %q at line %d", node.Tag, node.Line)
		}
	case goyaml.AliasNode:
		return nil, codecErr(CodeCodecDecode, "yaml: aliases are not supported at line %d", node.Line)
	default:
		return nil, codecErr(CodeCodecDecode, "yaml: node kind %d is not supported", node.Kind)
	}
}

func yamlMapKey(node *goyaml.Node) (string, error) {
	if node.Kind != goyaml.ScalarNode {
		return "", codecErr(CodeCodecDecode, "yaml: map keys must be scalar strings at line %d", node.Line)
	}
	switch node.Tag {
	case "!!str":
		return node.Value, nil
	case "!!int":
		var value int64
		if err := node.Decode(&value); err != nil {
			return "", codecErr(CodeCodecDecode, "yaml: map key integer at line %d: %v", node.Line, err)
		}
		return strconv.FormatInt(value, 10), nil
	default:
		return "", codecErr(CodeCodecDecode, "yaml: map keys must be strings or integers at line %d", node.Line)
	}
}

func prepareUploadFiles(v any) (any, error) {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i := range x {
			var err error
			out[i], err = prepareUploadFiles(x[i])
			if err != nil {
				return nil, err
			}
		}
		return out, nil
	case map[string]any:
		if kind, ok := x["$type"]; ok && kind == "upload_file" {
			path, pathOK := x["path"].(string)
			mime, mimeOK := x["mime"].(string)
			name, nameOK := x["name"].(string)
			if len(x) != 4 || !pathOK || !mimeOK || !nameOK || path == "" || name == "" {
				return nil, codecErr(CodeCodecEncode, "curlfile: upload_file requires non-empty path and name plus string mime")
			}
			return map[string]any{"is_curl_file": true, "path": path, "mime": mime, "name": name}, nil
		}
		out := make(map[string]any, len(x))
		for key, value := range x {
			var err error
			out[key], err = prepareUploadFiles(value)
			if err != nil {
				return nil, err
			}
		}
		return out, nil
	default:
		return v, nil
	}
}

func restoreUploadFiles(v any) (any, error) {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i := range x {
			var err error
			out[i], err = restoreUploadFiles(x[i])
			if err != nil {
				return nil, err
			}
		}
		return out, nil
	case map[string]any:
		if marker, ok := x["is_curl_file"]; ok && marker == true {
			path, pathOK := x["path"].(string)
			mime, mimeOK := x["mime"].(string)
			name, nameOK := x["name"].(string)
			if len(x) != 4 || !pathOK || !mimeOK || !nameOK || path == "" || name == "" {
				return nil, codecErr(CodeCodecDecode, "curlfile: invalid stored upload file")
			}
			return map[string]any{"$type": "upload_file", "path": path, "mime": mime, "name": name}, nil
		}
		out := make(map[string]any, len(x))
		for key, value := range x {
			var err error
			out[key], err = restoreUploadFiles(value)
			if err != nil {
				return nil, err
			}
		}
		return out, nil
	default:
		return v, nil
	}
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
