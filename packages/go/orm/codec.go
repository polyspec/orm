package orm

// Column-style codecs (docs/spec/codec.md): json/jsons, serialize, base64, gz, yaml.
// Styles are listed in write order; Decode applies them in reverse.

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"errors"
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
	goyaml "go.yaml.in/yaml/v3"
)

func codecErr(code, format string, a ...any) error {
	return &ir.Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}

// codecCause is the error of code with the fixed text msg of a rule and the library error that failed as its cause, whose
// text can quote the cell, so the text names no value (INT-163).
func codecCause(code, msg string, cause error) error {
	return &ir.Error{Code: code, Msg: msg, Cause: cause}
}

// checkCodecStyles refuses a style that no stage names and a value stage outside the first position, before any value or
// cell is read (docs/spec/codec.md COD-35).
func checkCodecStyles(styles []string) error {
	for i, style := range styles {
		switch style {
		case "gz", "base64":
		case "serialize", "yaml", "ordered_json":
			if i != 0 {
				return codecErr(CodeCodecUnsupported, "%s must be the first style", style)
			}
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
		return StyledValue{}, codecErr(CodeCodecDecode, "cell is not bytes")
	}
	// An empty cell is CODEC_DECODE, except under a last base64 stage and under no stage, whose encoders write an empty cell
	// for empty text (docs/spec/codec.md COD-14).
	if len(b) == 0 && len(styles) > 0 && styles[len(styles)-1] != "base64" {
		return StyledValue{}, codecErr(CodeCodecDecode, "styled cell is empty")
	}
	// The byte stages apply in reverse; a value stage is only the first style (style-first), so it applies last.
	value := ""
	if len(styles) > 0 {
		switch styles[0] {
		case "serialize", "yaml", "ordered_json":
			value, styles = styles[0], styles[1:]
		}
	}
	for i := len(styles) - 1; i >= 0; i-- {
		var err error
		if styles[i] == "gz" {
			b, err = gunzipCell(b)
		} else {
			b, err = base64Cell(b)
		}
		if err != nil {
			return StyledValue{}, err
		}
	}
	var v any
	var err error
	switch value {
	case "serialize":
		v, err = phpUnserialize(b)
	case "yaml":
		v, err = yamlDecode(b)
	case "ordered_json":
		v, err = orderedjson.ParseBytes(b)
		if err != nil {
			err = codecCause(CodeCodecDecode, "json: the cell is not JSON", err)
		}
	default:
		// With no value stage, the value is the text that the first gz or base64 stage received, or the cell itself.
		if !utf8.Valid(b) {
			return StyledValue{}, codecErr(CodeCodecDecode, "decoded text is not valid UTF-8")
		}
		return Value(string(b)), nil
	}
	if err != nil {
		return StyledValue{}, err
	}
	return Value(v), nil
}

// gunzipCell is the text of a zlib stream of COD-12.
func gunzipCell(cur []byte) ([]byte, error) {
	r, err := zlib.NewReader(bytes.NewReader(cur))
	if err != nil {
		return nil, codecCause(CodeCodecDecode, "gz: bad zlib stream", err)
	}
	out, err := io.ReadAll(r)
	closeErr := r.Close()
	if err != nil {
		return nil, codecCause(CodeCodecDecode, "gz: bad zlib stream", err)
	}
	if closeErr != nil {
		return nil, codecCause(CodeCodecDecode, "gz: bad zlib stream", closeErr)
	}
	return out, nil
}

// base64Cell decodes a stored cell only in the form the encoder writes: whitespace, line breaks, missing padding, or
// non-zero padding bits is CODEC_DECODE (docs/spec/codec.md). Go's decoder skips \r and \n, so they are rejected separately.
func base64Cell(cur []byte) ([]byte, error) {
	if bytes.ContainsAny(cur, "\r\n") {
		return nil, codecErr(CodeCodecDecode, "base64: bad input")
	}
	out, err := base64.StdEncoding.Strict().DecodeString(string(cur))
	if err != nil {
		return nil, codecCause(CodeCodecDecode, "base64: bad input", err)
	}
	return out, nil
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
	value := v.value
	if len(styles) == 0 {
		cur, err := firstStageText("an empty stage list", "", value)
		if err != nil {
			return nil, err
		}
		return string(cur), nil
	}
	var cur []byte
	var err error
	for i, st := range styles {
		switch st {
		case "serialize":
			if err := commonValue("serialize", value); err != nil {
				return nil, err
			}
			var sb strings.Builder
			if err := phpSerialize(&sb, value); err != nil {
				return nil, err
			}
			cur = []byte(sb.String())
		case "yaml":
			if cur, err = yamlEncode(value); err != nil {
				return nil, err
			}
		case "ordered_json":
			ordered, err := orderedJSONValue(value)
			if err != nil {
				return nil, err
			}
			raw, err := orderedJSONCompact(ordered)
			if err != nil {
				return nil, codecCause(CodeCodecEncode, "json: the value has no JSON text", err)
			}
			cur = []byte(raw)
		case "base64":
			if i == 0 {
				if cur, err = firstStageText("a first base64 stage", "base64: ", value); err != nil {
					return nil, err
				}
			}
			cur = []byte(base64.StdEncoding.EncodeToString(cur))
		default:
			// checkCodecStyles leaves gz as the only other style.
			if i == 0 {
				if cur, err = firstStageText("a first gz stage", "gz: ", value); err != nil {
					return nil, err
				}
			}
			if cur, err = gzipText(cur); err != nil {
				return nil, err
			}
			if i == len(styles)-1 {
				return cur, nil
			}
		}
	}
	return string(cur), nil
}

// gzipText is the zlib stream of COD-12 of cur.
func gzipText(cur []byte) ([]byte, error) {
	var buf bytes.Buffer
	w, err := zlib.NewWriterLevel(&buf, zlib.BestCompression)
	if err != nil {
		return nil, codecCause(CodeCodecEncode, "gz: the compression failed", err)
	}
	if _, err := w.Write(cur); err != nil {
		return nil, codecCause(CodeCodecEncode, "gz: the compression failed", err)
	}
	if err := w.Close(); err != nil {
		return nil, codecCause(CodeCodecEncode, "gz: the compression failed", err)
	}
	return buf.Bytes(), nil
}

// yamlEncode writes a value of the common value model as one YAML document and reads the text back (COD-29).
func yamlEncode(value any) ([]byte, error) {
	if err := commonValue("yaml", value); err != nil {
		return nil, err
	}
	var doc goyaml.Node
	err := doc.Encode(yamlFloats(value))
	var cur []byte
	if err == nil {
		yamlQuoteBreaks(&doc)
		cur, err = goyaml.Marshal(&doc)
	}
	if err != nil {
		return nil, codecCause(CodeCodecEncode, "yaml: the value has no YAML text", err)
	}
	if _, err := yamlDecode(cur); err != nil {
		return nil, codecCause(CodeCodecEncode, "yaml: the written text does not read back as the value", err)
	}
	return cur, nil
}

// firstStageText is the value that the first stage, gz or base64, encodes, and that an empty stage list writes as it is.
// Those receive bytes, so the value must be a string (text-kind), and a string that is UTF-8 (text-unicode), whose rule
// text starts with prefix.
func firstStageText(stage, prefix string, value any) ([]byte, error) {
	s, ok := value.(string)
	if !ok {
		return nil, codecErr(CodeCodecEncode, "%s takes a string value", stage)
	}
	if !utf8.ValidString(s) {
		return nil, codecErr(CodeCodecEncode, "%sthe text is not a sequence of Unicode scalar values", prefix)
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

// yamlQuoteBreaks double-quotes each string scalar, a key or a value, that holds U+0085, U+2028 or U+2029 (COD-29): yaml.v3
// escapes them there, and elsewhere counts them as line breaks, as YAML 1.1 does, and pads the text after one.
//
// It also writes the string << as a double-quoted string: yaml.v3 tags it !!merge, the merge key of YAML 1.1, which YAML 1.2
// does not have (COD-29).
func yamlQuoteBreaks(node *goyaml.Node) {
	if node.Kind == goyaml.ScalarNode && node.Tag == "!!merge" {
		node.Tag = "!!str"
		node.Style = goyaml.DoubleQuotedStyle
	}
	if node.Kind == goyaml.ScalarNode && node.Tag == "!!str" && strings.ContainsAny(node.Value, "\u0085\u2028\u2029") {
		node.Style = goyaml.DoubleQuotedStyle
	}
	for _, child := range node.Content {
		yamlQuoteBreaks(child)
	}
}

// yamlFloats is value with each float as a YAML scalar node whose text keeps a fraction or an exponent, so that it reads back
// as a float and not as an integer (COD-29): yaml.v3 writes the float 2.0 as 2, which the YAML 1.2 core schema reads as an int.
func yamlFloats(value any) any {
	switch x := value.(type) {
	case float64:
		text := strconv.FormatFloat(x, 'g', -1, 64)
		if !strings.ContainsAny(text, ".eEn") {
			text += ".0"
		}
		return &goyaml.Node{Kind: goyaml.ScalarNode, Tag: "!!float", Value: text}
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = yamlFloats(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, item := range x {
			out[k] = yamlFloats(item)
		}
		return out
	}
	return value
}

// yamlDecode reads one YAML 1.2 document. goccy/go-yaml reads U+0085 as content, as YAML 1.2
// rules (5.4), where yaml.v3 reads it as a line break; its AST keeps each scalar's source text
// and style, so the plain scalars resolve by the core schema below. The parser is told to keep a
// repeated key, which yamlMapping refuses in the order of the nodes (COD-70).
func yamlDecode(b []byte) (any, error) {
	b, err := yamlStream(b)
	if err != nil {
		return nil, err
	}
	file, err := yamlparser.ParseBytes(b, 0, yamlparser.AllowDuplicateMapKey())
	if err != nil {
		if yamlCollectionKey(err) {
			return nil, codecCause(CodeCodecDecode, "yaml: map keys must be scalar strings", err)
		}
		return nil, codecCause(CodeCodecDecode, "yaml: the stream does not parse", err)
	}
	// The parser gives the directives of a document (%YAML, %TAG) as a document of their own before it.
	docs := make([]*ast.DocumentNode, 0, len(file.Docs))
	for _, doc := range file.Docs {
		if _, directive := doc.Body.(*ast.DirectiveNode); !directive {
			docs = append(docs, doc)
		}
	}
	switch len(docs) {
	case 0:
		return nil, codecErr(CodeCodecDecode, "yaml: no document")
	case 1:
	default:
		return nil, codecErr(CodeCodecDecode, "yaml: multiple documents are not supported")
	}
	if doc := docs[0]; doc.Body == nil {
		// A stream without content has no document; `---` alone is a null document.
		if doc.Start == nil {
			return nil, codecErr(CodeCodecDecode, "yaml: no document")
		}
		return nil, nil
	}
	return yamlNode(docs[0].Body)
}

// yamlCollectionKey reports whether the parser refused the stream at a key that is a collection, which goccy/go-yaml does
// not read: the token it refuses is the ':' after the end of a flow sequence or map, or a block sequence entry right after
// an explicit key '?'.
func yamlCollectionKey(err error) bool {
	var syntax interface{ GetToken() *token.Token }
	if !errors.As(err, &syntax) {
		return false
	}
	tk := syntax.GetToken()
	if tk == nil || tk.Prev == nil {
		return false
	}
	switch tk.Type {
	case token.MappingValueType:
		return tk.Prev.Type == token.SequenceEndType || tk.Prev.Type == token.MappingEndType
	case token.SequenceEntryType:
		return tk.Prev.Type == token.MappingKeyType
	}
	return false
}

// yamlStream applies the stream rules of YAML 1.2 that the parser does not (COD-13): the stream is UTF-8, a byte order
// mark may start it (5.2) and appears nowhere else, and every character is printable (5.1). It returns the stream without
// its byte order mark.
func yamlStream(b []byte) ([]byte, error) {
	if !utf8.Valid(b) {
		return nil, codecErr(CodeCodecDecode, "yaml: the stream is not UTF-8")
	}
	b = bytes.TrimPrefix(b, []byte("\uFEFF"))
	for _, r := range string(b) {
		if !yamlPrintable(r) {
			return nil, codecErr(CodeCodecDecode, "yaml: the stream holds a character that is not printable")
		}
	}
	return b, nil
}

// yamlPrintable reports whether a character may appear in a YAML stream (YAML 1.2.2, 5.1, c-printable). A byte order mark
// is the encoding mark at the start of the stream (5.2) and never content.
func yamlPrintable(r rune) bool {
	switch {
	case r == '\t', r == '\n', r == '\r', r >= ' ' && r <= '~', r == 0x85:
		return true
	case r == 0xFEFF:
		return false
	}
	return r >= 0xA0 && r <= 0xD7FF || r >= 0xE000 && r <= 0xFFFD || r >= 0x10000 && r <= 0x10FFFF
}

// yamlNode is the value of a node of a document body. Each node kind of goccy/go-yaml is handled: the scalars, the
// collections and the anchor, alias and tag forms that a rule refuses; a document, a directive, a comment, a sequence entry
// or an explicit key that the parser gives as a value is a stream that does not parse, whose cause names the kind (COD-72).
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
		return nil, codecErr(CodeCodecDecode, "yaml: explicit tags are not supported")
	case *ast.AliasNode:
		return nil, codecErr(CodeCodecDecode, "yaml: aliases are not supported")
	case *ast.AnchorNode:
		return nil, codecErr(CodeCodecDecode, "yaml: anchors are not supported")
	case *ast.LiteralNode:
		return n.Value.Value, nil
	case *ast.NullNode, *ast.BoolNode, *ast.IntegerNode, *ast.FloatNode, *ast.InfinityNode, *ast.NanNode, *ast.StringNode,
		*ast.MergeKeyNode:
		text, plain := yamlScalar(n.GetToken())
		if plain {
			return yamlCoreScalar(text)
		}
		return text, nil
	}
	return nil, codecCause(CodeCodecDecode, "yaml: the stream does not parse", fmt.Errorf("a %s node in a document body", node.Type()))
}

func yamlMapping(values []*ast.MappingValueNode) (map[string]any, error) {
	out := make(map[string]any, len(values))
	for _, item := range values {
		key, err := yamlMapKey(item.Key)
		if err != nil {
			return nil, err
		}
		if _, exists := out[key]; exists {
			return nil, codecErr(CodeCodecDecode, "yaml: duplicate map key")
		}
		value, err := yamlNode(item.Value)
		if err != nil {
			return nil, err
		}
		out[key] = value
	}
	return out, nil
}

// yamlScalar returns the text of a scalar's token and whether it is plain, whose tag the reader resolves. The AST types
// goccy/go-yaml gives plain scalars follow its own resolution, so only the source text and the style are used.
func yamlScalar(t *token.Token) (string, bool) {
	switch t.Type {
	case token.SingleQuoteType, token.DoubleQuoteType:
		return t.Value, false
	}
	return t.Value, true
}

var (
	yamlCoreInt       = regexp.MustCompile(`^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$`)
	yamlCoreFloat     = regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$`)
	yamlCoreNonFinite = regexp.MustCompile(`^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$`)
)

// yamlCoreScalar resolves a plain scalar by the tags of the YAML 1.2 core schema (YAML 1.2.2,
// 10.3.2): null, bool, int and float by their regular expressions, and str otherwise. An
// integer outside int64 and a float that is not finite are outside the common value model.
func yamlCoreScalar(text string) (any, error) {
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
			return nil, codecCause(CodeCodecDecode, "yaml: integer is outside the i64 range", err)
		}
		return value, nil
	case yamlCoreNonFinite.MatchString(text):
		return nil, codecErr(CodeCodecDecode, "yaml: number is not finite")
	case yamlCoreFloat.MatchString(text):
		// The form is a float of the core schema, which ParseFloat reads, so its only failure is a float beyond the f64 range.
		value, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return nil, codecCause(CodeCodecDecode, "yaml: number is not finite", err)
		}
		return value, nil
	}
	return text, nil
}

func yamlMapKey(node ast.Node) (string, error) {
	// An explicit key (? key) is the key it holds; a collection there is refused below as any collection key is.
	if explicit, ok := node.(*ast.MappingKeyNode); ok {
		node = explicit.Value
	}
	var value any
	switch n := node.(type) {
	case *ast.SequenceNode, *ast.MappingNode, *ast.MappingValueNode:
		return "", codecErr(CodeCodecDecode, "yaml: map keys must be scalar strings")
	case *ast.LiteralNode:
		value = n.Value.Value
	case *ast.NullNode, *ast.BoolNode, *ast.IntegerNode, *ast.FloatNode, *ast.InfinityNode, *ast.NanNode, *ast.StringNode,
		*ast.MergeKeyNode:
		text, plain := yamlScalar(n.GetToken())
		value = text
		if plain && !yamlCoreInt.MatchString(text) && (yamlCoreFloat.MatchString(text) || yamlCoreNonFinite.MatchString(text)) {
			// A float key, finite or not, is a key that the core schema reads as a float.
			return "", codecErr(CodeCodecDecode, "yaml: map keys must be strings or integers")
		}
		if plain {
			var err error
			if value, err = yamlCoreScalar(text); err != nil {
				return "", err
			}
		}
	default:
		// yamlNode refuses a tag, an anchor and an alias by their rules, and a kind that is not a key as a stream that does
		// not parse.
		_, err := yamlNode(node)
		return "", err
	}
	switch v := value.(type) {
	case string:
		return v, nil
	case int64:
		return strconv.FormatInt(v, 10), nil
	}
	return "", codecErr(CodeCodecDecode, "yaml: map keys must be strings or integers")
}

// ---- PHP serialize format ----

// commonValue refuses, in the order of its nodes, a value that a first serialize or yaml stage, named by stage, does not
// write (COD-70): an ordered-json value, a string that is not UTF-8, a float that is not finite, an integer outside the i64
// range, and any other value outside the common value model of COD-16, such as bytes or a map whose keys are not strings
// (COD-63), which yaml.v3 would write in forms of its own. A map is read in the order of its sorted keys.
func commonValue(stage string, v any) error {
	switch x := v.(type) {
	case nil, bool, int, int32, int64:
	case uint64:
		if x > math.MaxInt64 {
			return codecErr(CodeCodecEncode, "%s: integer is outside the i64 range", stage)
		}
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return codecErr(CodeCodecEncode, "%s: number is not finite", stage)
		}
	case string:
		if !utf8.ValidString(x) {
			return codecErr(CodeCodecEncode, "%s: the text is not a sequence of Unicode scalar values", stage)
		}
	case *orderedjson.Value:
		return codecErr(CodeCodecEncode, "%s: an ordered-json value is written only by the ordered_json stage", stage)
	case []any:
		for _, item := range x {
			if err := commonValue(stage, item); err != nil {
				return err
			}
		}
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if err := commonValue(stage, k); err != nil {
				return err
			}
			if err := commonValue(stage, x[k]); err != nil {
				return err
			}
		}
	default:
		return codecErr(CodeCodecEncode, "%s: the value is not a codec value", stage)
	}
	return nil
}

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
	case uint64:
		sb.WriteString("i:" + strconv.FormatUint(x, 10) + ";")
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
		return codecErr(CodeCodecEncode, "serialize: the value is not a codec value")
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
// integral values without a fraction ("d:2;"), exponent form as "1.0E+25". commonValue has refused a float that is not
// finite.
func phpFloat(f float64) string {
	// PHP writes the shortest digits (serialize_precision -1) in the exponent form when the decimal exponent is below -4
	// or above 16, and in fixed notation otherwise (zend_gcvt with precision 17).
	s := strconv.FormatFloat(f, 'e', -1, 64)
	i := strings.IndexByte(s, 'e')
	mant, exp := s[:i], s[i+1:]
	e, err := strconv.Atoi(exp)
	if err != nil {
		panic(fmt.Sprintf("orm: FormatFloat wrote the exponent %q", exp))
	}
	if e >= -4 && e <= 16 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	if !strings.Contains(mant, ".") {
		mant += ".0"
	}
	sign := "+"
	if e < 0 {
		sign, e = "-", -e
	}
	return mant + "E" + sign + strconv.Itoa(e)
}

func phpUnserialize(b []byte) (any, error) {
	p := &phpParser{b: b}
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	if p.i != len(b) {
		return nil, p.fail("trailing data")
	}
	return v, nil
}

type phpParser struct {
	b []byte
	i int
}

// fail is the error of a serialize rule; its text names no position (COD-70).
func (p *phpParser) fail(msg string) error {
	return codecErr(CodeCodecDecode, "serialize: %s", msg)
}

func (p *phpParser) expect(c byte) error {
	if p.i >= len(p.b) || p.b[p.i] != c {
		return p.fail("expected " + string(c))
	}
	p.i++
	return nil
}

var (
	phpDigits = regexp.MustCompile(`^[0-9]+$`)
	phpInt    = regexp.MustCompile(`^[+-]?[0-9]+$`)
	// phpFloatForm is the d field of the PHP grammar: an optional sign, digits with an optional fraction or a fraction, and
	// an optional exponent.
	phpFloatForm = regexp.MustCompile(`^[+-]?(?:[0-9]+|[0-9]*\.[0-9]+|[0-9]+\.[0-9]*)(?:[eE][+-]?[0-9]+)?$`)
)

// length reads the length that a serialized string or array of kind what carries after its kind letter, the colon before
// it included: digits only. A length beyond int is past the end of any cell.
func (p *phpParser) length(what string) (int, error) {
	if err := p.expect(':'); err != nil {
		return 0, err
	}
	ls, err := p.until(':')
	if err != nil {
		return 0, err
	}
	if !phpDigits.MatchString(ls) {
		return 0, p.fail("bad " + what + " length")
	}
	// Digits only, so the one failure of Atoi is a length beyond int.
	n, err := strconv.Atoi(ls)
	if errors.Is(err, strconv.ErrRange) {
		n = math.MaxInt
	}
	return n, nil
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

// scalar is the value of a b, i or d field s.
func (p *phpParser) scalar(t byte, s string) (any, error) {
	switch t {
	case 'b':
		switch s {
		case "0":
			return false, nil
		case "1":
			return true, nil
		}
		return nil, p.fail("bad bool")
	case 'i':
		if !phpInt.MatchString(s) {
			return nil, p.fail("bad int")
		}
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return nil, codecCause(CodeCodecDecode, "serialize: integer is outside the i64 range", err)
		}
		return n, nil
	}
	// A float of the common value model is finite (COD-16), so INF, -INF, NAN and a float beyond the f64 range are not
	// values.
	switch s {
	case "NAN", "INF", "-INF":
		return nil, p.fail("non-finite float")
	}
	if !phpFloatForm.MatchString(s) {
		return nil, p.fail("bad float")
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil, codecCause(CodeCodecDecode, "serialize: non-finite float", err)
	}
	return f, nil
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
		return p.scalar(t, s)
	case 's':
		n, err := p.length("string")
		if err != nil {
			return nil, err
		}
		if err := p.expect('"'); err != nil {
			return nil, err
		}
		if n > len(p.b)-p.i {
			return nil, p.fail("string overruns input")
		}
		s := p.b[p.i : p.i+n]
		if !utf8.Valid(s) {
			return nil, p.fail("string is not valid UTF-8")
		}
		p.i += n
		if err := p.expect('"'); err != nil {
			return nil, err
		}
		return string(s), p.expect(';')
	case 'a':
		n, err := p.length("array")
		if err != nil {
			return nil, err
		}
		if err := p.expect('{'); err != nil {
			return nil, err
		}
		// Each entry takes bytes of the cell, so the cell bounds the space to reserve.
		size := min(n, len(p.b)-p.i)
		keys := make([]string, 0, size)
		vals := make([]any, 0, size)
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
		m := make(map[string]any, len(keys))
		for k := range keys {
			m[keys[k]] = vals[k]
		}
		return m, nil
	case 'O', 'C', 'r', 'R':
		return nil, codecErr(CodeCodecUnsupported, "serialize: objects and references are not supported")
	}
	return nil, p.fail("unknown type")
}
