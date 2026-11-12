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

	orderedjson "github.com/polyspec/ordered-json/packages/go"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/internal/message"
	goyaml "go.yaml.in/yaml/v3"
)

// maxNesting is the number of nested lists and maps that every value stage reads and writes; a list or a map at the next
// level is refused by the nesting rule of its stage (COD-70).
const maxNesting = 256

// errNesting is the refusal of a list or a map at level maxNesting+1 by the stage named by stage.
func errNesting(code, stage string) error {
	return codecErr(code, "%s: value nesting exceeds %d levels", stage, maxNesting)
}

func codecErr(code, format string, a ...any) error {
	return &ir.Error{Code: code, Msg: message.Sprintf(format, a...)}
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
			// The parser reads the cell in its order and refuses a list or a map at level 257 where it starts (json-depth-read).
			var parseErr orderedjson.Error
			if errors.As(err, &parseErr) && parseErr.Kind() == orderedjson.MaximumDepthExceededError {
				err = codecCause(CodeCodecDecode, fmt.Sprintf("json: value nesting exceeds %d levels", orderedjson.MaxDepth), err)
			} else {
				err = codecCause(CodeCodecDecode, "json: the cell is not JSON", err)
			}
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
			if err := commonValue("serialize", value, 0); err != nil {
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

// yamlEncode writes a value of the common value model as one YAML document with go.yaml.in/yaml/v3 and reads the text back
// with the reader of COD-74 (COD-29, yaml-read-back).
func yamlEncode(value any) ([]byte, error) {
	if err := commonValue("yaml", value, 0); err != nil {
		return nil, err
	}
	node, err := yamlWriteNode(value)
	if err != nil {
		return nil, codecCause(CodeCodecEncode, "yaml: the value has no YAML text", err)
	}
	cur, err := goyaml.Marshal(node)
	if err != nil {
		return nil, codecCause(CodeCodecEncode, "yaml: the value has no YAML text", err)
	}
	got, err := yamlDecode(cur)
	if err == nil && !yamlSameValue(value, got) {
		err = errors.New("the written text reads back as another value")
	}
	if err != nil {
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

// NormalizeStyled validates the input of the setter of the styled column named column and returns its decoded value model,
// so that an in-memory model matches a row read from storage. SQL NULL on a column that is not nullable is refused with the
// name of the column, and any other value fails with the first rule of COD-70 that it meets (COD-73).
func NormalizeStyled(column string, styles []string, nullable bool, v StyledValue) (StyledValue, error) {
	if v.kind == 1 && !nullable {
		return StyledValue{}, codecErr(CodeCodecEncode, "%s does not accept SQL NULL", column)
	}
	stored, err := Encode(styles, v)
	if err != nil {
		return StyledValue{}, err
	}
	return Decode(styles, stored)
}

// yamlWriteNode is the yaml.v3 node of a value that commonValue passed, built here rather than by Node.Encode, which reads
// its own text back with the parser of yaml.v3 and refuses some strings that it writes. Each scalar has the tag of its kind,
// so that yaml.v3 quotes a string that would read back as another kind, the string << included, which yaml.v3 would
// otherwise read as the merge key of YAML 1.1 (COD-29). A float keeps a fraction or an exponent, so that it reads back as a
// float and not as an integer: yaml.v3 writes the float 2.0 as 2. A string is double-quoted where yaml.v3 would write it
// in a form that YAML 1.2.2 reads as another string: one that holds U+0085, U+2028 or U+2029, which yaml.v3 counts as line
// breaks, as YAML 1.1 does, and one that starts with white space or a line break, which yaml.v3 writes as a block scalar
// with an indentation indicator counted from column 0, where YAML 1.2.2 counts it from the parent of the document node at
// -1 (COD-78). The keys of a map are written in their sorted order.
func yamlWriteNode(value any) (*goyaml.Node, error) {
	scalar := func(tag, text string) (*goyaml.Node, error) {
		return &goyaml.Node{Kind: goyaml.ScalarNode, Tag: tag, Value: text}, nil
	}
	switch x := value.(type) {
	case nil:
		return scalar("!!null", "null")
	case bool:
		return scalar("!!bool", strconv.FormatBool(x))
	case int:
		return scalar("!!int", strconv.Itoa(x))
	case int32:
		return scalar("!!int", strconv.FormatInt(int64(x), 10))
	case int64:
		return scalar("!!int", strconv.FormatInt(x, 10))
	case uint64:
		return scalar("!!int", strconv.FormatUint(x, 10))
	case float64:
		text := strconv.FormatFloat(x, 'g', -1, 64)
		if !strings.ContainsAny(text, ".eEn") {
			text += ".0"
		}
		return scalar("!!float", text)
	case string:
		node := &goyaml.Node{Kind: goyaml.ScalarNode, Tag: "!!str", Value: x}
		if strings.ContainsAny(x, "\u0085\u2028\u2029") || x != "" && strings.ContainsRune(" \t\n\r", rune(x[0])) {
			node.Style = goyaml.DoubleQuotedStyle
		}
		return node, nil
	case []any:
		node := &goyaml.Node{Kind: goyaml.SequenceNode, Tag: "!!seq"}
		for _, item := range x {
			child, err := yamlWriteNode(item)
			if err != nil {
				return nil, err
			}
			node.Content = append(node.Content, child)
		}
		return node, nil
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		node := &goyaml.Node{Kind: goyaml.MappingNode, Tag: "!!map"}
		for _, k := range keys {
			key, err := yamlWriteNode(k)
			if err != nil {
				return nil, err
			}
			child, err := yamlWriteNode(x[k])
			if err != nil {
				return nil, err
			}
			node.Content = append(node.Content, key, child)
		}
		return node, nil
	}
	// commonValue passes no other value; one that reaches here is refused, not written as something else.
	return nil, fmt.Errorf("the Go value %T has no YAML node", value)
}

// yamlStream applies the stream rules of YAML 1.2 before the reader reads the stream (COD-75): the stream is UTF-8, a byte order
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

// ---- PHP serialize format ----

// commonValue refuses, in the order of its nodes, a value that a first serialize or yaml stage, named by stage, does not
// write (COD-70): an ordered-json value, a string that is not UTF-8, a float that is not finite, an integer outside the i64
// range, and any other value outside the common value model of COD-16, such as bytes or a map whose keys are not strings
// (COD-63), which yaml.v3 would write in forms of its own, and a list or a map at level 257, where it starts, before the
// nodes inside it (serialize-depth-write, yaml-depth-write); depth is the number of lists and maps around v. A map is read
// in the order of its sorted keys.
func commonValue(stage string, v any, depth int) error {
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
		if depth+1 > maxNesting {
			return errNesting(CodeCodecEncode, stage)
		}
		for _, item := range x {
			if err := commonValue(stage, item, depth+1); err != nil {
				return err
			}
		}
	case map[string]any:
		if depth+1 > maxNesting {
			return errNesting(CodeCodecEncode, stage)
		}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if err := commonValue(stage, k, depth+1); err != nil {
				return err
			}
			if err := commonValue(stage, x[k], depth+1); err != nil {
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
		panic(message.Sprintf("orm: FormatFloat wrote the exponent %q", exp))
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
	v, err := p.value(0)
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

// value reads the field at p.i, inside depth arrays: an a field is one level, and one at level 257 is refused at its letter,
// before its length and the fields inside it (serialize-depth). A key is read before its value, and a key that repeats an
// earlier key of its array, an integer key and a string key of the same text included, is refused before its value
// (serialize-duplicate).
func (p *phpParser) value(depth int) (any, error) {
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
		if depth+1 > maxNesting {
			return nil, errNesting(CodeCodecDecode, "serialize")
		}
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
		seen := make(map[string]struct{}, size)
		for k := 0; k < n; k++ {
			kv, err := p.value(depth + 1)
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
			if _, repeated := seen[key]; repeated {
				return nil, p.fail("duplicate array key")
			}
			seen[key] = struct{}{}
			v, err := p.value(depth + 1)
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
