package orm

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	orderedjson "github.com/polyspec/ordered-json/packages/go"

	"github.com/polyspec/orm/packages/go/testcase"
)

type codecVector struct {
	Name          string   `json:"name"`
	Styles        []string `json:"styles"`
	Value         any      `json:"value"`
	EncodedB64    *string  `json:"encoded_b64"`
	Deterministic bool     `json:"deterministic"`
	// EncodeError is the code that encoding Value must fail with; such a vector has no stored cell.
	EncodeError string `json:"encode_error"`
}

func canon(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func canonStyled(t *testing.T, v StyledValue) string {
	t.Helper()
	data, present := v.Data()
	if !present {
		return "null"
	}
	return canon(t, data)
}

// decodeVector is one case of tests/codec/decode-vectors.json: the stages in write order, the hex of the text or bytes,
// the stored cell, the decoded value, or the error code.
type decodeVector struct {
	Name      string   `json:"name"`
	Styles    []string `json:"styles"`
	Stored    *string  `json:"stored"`
	StoredHex *string  `json:"stored_hex"`
	Value     any      `json:"value"`
	Error     string   `json:"error"`
}

// TestCodecDecodeVectors reads the shared decode vectors. A stored cell is decoded only in the form the encoder writes,
// and surrounding whitespace or other forms are CODEC_DECODE. A host stage list without aes is read with HostDecode and no key,
// and the rest are read with Decode.
func TestCodecDecodeVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	src, err := os.ReadFile("../../../tests/codec/decode-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Vectors []decodeVector }
	if err := json.Unmarshal(src, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Vectors) == 0 {
		t.Fatal("decode-vectors.json has no vectors")
	}
	for _, v := range f.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var raw any
			var err error
			switch {
			case v.Stored != nil:
				raw = *v.Stored
			case v.StoredHex != nil:
				b, err := hex.DecodeString(*v.StoredHex)
				if err != nil {
					t.Fatalf("stored_hex: %v", err)
				}
				raw = b
			default:
				t.Fatal("no stored cell")
			}
			var got any
			codec, host := splitHost(v.Styles)
			if len(codec) == 0 {
				got, err = HostDecode(raw, host, "")
			} else {
				var styled StyledValue
				styled, err = Decode(v.Styles, raw)
				got, _ = styled.Data()
			}
			switch {
			case v.Error != "":
				if err == nil || ErrorCode(err) != v.Error {
					t.Errorf("got %#v, %v; want %s", got, err, v.Error)
				}
			case err != nil:
				t.Error(err)
			case v.Value == nil || canon(t, got) != canon(t, v.Value):
				t.Errorf("got %s, want %s", canon(t, got), canon(t, v.Value))
			}
		})
	}
}

// TestCodecVectors: every PHP-produced vector decodes to the same value, and
// deterministic styles re-encode to the same bytes. When ORM_CODEC_OUT names a
// directory (make codec-check), Go's encodings are written to go.json there for
// the PHP cross-check, through a temporary file and a rename.
func TestCodecVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	src, err := os.ReadFile("../../../tests/codec/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Vectors []codecVector }
	if err := json.Unmarshal(src, &f); err != nil {
		t.Fatal(err)
	}
	out := map[string]*string{}
	for _, v := range f.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			if v.EncodeError != "" {
				// A list of host stages only (ip) encodes with the host encode and no key.
				var enc any
				var err error
				if codec, host := splitHost(v.Styles); len(codec) == 0 {
					enc, err = HostEncode(v.Value, host, "")
				} else {
					enc, err = Encode(codecStages(v.Styles), Value(jsonNumbers(reNumber(v.Value))))
				}
				if err == nil || ErrorCode(err) != v.EncodeError {
					t.Errorf("encode gave %#v, %v; want %s", enc, err, v.EncodeError)
				}
				return
			}
			want := canon(t, jsonNumbers(reNumber(v.Value)))
			var raw any
			if v.EncodedB64 != nil {
				b, err := base64.StdEncoding.DecodeString(*v.EncodedB64)
				if err != nil {
					t.Fatal(err)
				}
				raw = string(b)
			}
			styles := codecStages(v.Styles)
			got, err := Decode(styles, raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			value, present := got.Data()
			if !present {
				value = nil
			}
			if g := canon(t, value); g != want {
				t.Errorf("decoded %s want %s", g, want)
			}
			enc, err := Encode(styles, got)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			var encB64 *string
			switch e := enc.(type) {
			case string:
				s := base64.StdEncoding.EncodeToString([]byte(e))
				encB64 = &s
			case []byte:
				s := base64.StdEncoding.EncodeToString(e)
				encB64 = &s
			}
			out[v.Name] = encB64
			if v.Deterministic && ((encB64 == nil) != (v.EncodedB64 == nil) || (encB64 != nil && *encB64 != *v.EncodedB64)) {
				t.Errorf("encoded %v want %v", deref(encB64), deref(v.EncodedB64))
			}
			// round trip through our own decoder
			back, err := Decode(styles, enc)
			backValue, _ := back.Data()
			if err != nil || canon(t, backValue) != want {
				t.Errorf("round trip %s (%v)", canon(t, backValue), err)
			}
		})
	}
	if dir := os.Getenv("ORM_CODEC_OUT"); dir != "" {
		b, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, "go.json")
		temporary := fmt.Sprintf("%s.tmp-%d", path, os.Getpid())
		if err := os.WriteFile(temporary, b, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(temporary, path); err != nil {
			t.Fatal(err)
		}
	}
}

// aesVector is one case of tests/codec/aes-vectors.json: a key, a plain text,
// and the AES v2 envelope (hex) that the key gives the text with a fixed nonce.
type aesVector struct {
	Name        string `json:"name"`
	Op          string `json:"op"`
	Key         string `json:"key"`
	Plain       string `json:"plain"`
	NonceHex    string `json:"nonce_hex"`
	EnvelopeHex string `json:"envelope_hex"`
	Error       string `json:"error"`
}

// aesErrorCode returns the code of the error that the vector's op raises
// ("" when it raises none): an error vector names an encode, a decode or a
// blind_index with an empty or wrong key.
func aesErrorCode(v aesVector) string {
	styles := []string{"aes", "hex"}
	switch v.Op {
	case "encode":
		_, err := HostEncode(v.Plain, styles, v.Key)
		return ErrorCode(err)
	case "decode":
		_, err := HostDecode(v.EnvelopeHex, styles, v.Key)
		return ErrorCode(err)
	default:
		_, err := BlindIndex(v.Plain, v.Key)
		return ErrorCode(err)
	}
}

// TestCodecAESVectors: for every vector of tests/codec/aes-vectors.json, a
// subtest named by its name, the aes hex host stages round-trip the plain text
// with the key, and the fixed envelope decodes to the plain text.
func TestCodecAESVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	src, err := os.ReadFile("../../../tests/codec/aes-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Vectors []aesVector }
	if err := json.Unmarshal(src, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Vectors) == 0 {
		t.Fatal("aes-vectors.json has no vectors")
	}
	styles := []string{"aes", "hex"}
	for _, v := range f.Vectors {
		if v.Name == "" || strings.ContainsAny(v.Name, "/ \t\n") {
			t.Errorf("vector name %q is empty or holds a slash or white space", v.Name)
			continue
		}
		t.Run(v.Name, func(t *testing.T) {
			if v.Error != "" {
				if got := aesErrorCode(v); got != v.Error {
					t.Errorf("%s with key %q: got %q, want %s", v.Op, v.Key, got, v.Error)
				}
				return
			}
			encoded, err := HostEncode(v.Plain, styles, v.Key)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			if got, err := HostDecode(encoded, styles, v.Key); err != nil || got != v.Plain {
				t.Errorf("round trip: %#v (%v), want %q", got, err, v.Plain)
			}
			if got, err := HostDecode(v.EnvelopeHex, styles, v.Key); err != nil || got != v.Plain {
				t.Errorf("fixed envelope: %#v (%v), want %q", got, err, v.Plain)
			}
		})
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

// reNumber re-decodes the vector's value with UseNumber so integers compare as int64.
func reNumber(v any) any {
	b, _ := json.Marshal(v)
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var d any
	_ = dec.Decode(&d)
	return d
}

func jsonNumbers(v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := strconv.ParseInt(string(x), 10, 64); err == nil {
			return i
		}
		f, _ := strconv.ParseFloat(string(x), 64)
		return f
	case []any:
		for i := range x {
			x[i] = jsonNumbers(x[i])
		}
	case map[string]any:
		for k := range x {
			x[k] = jsonNumbers(x[k])
		}
	}
	return v
}

func TestCodecErrors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	if encoded, err := Encode([]string{"ordered_json"}, Value(jsontext.Value(`{"object":{},"array":[]}`))); err != nil || encoded != `{"object":{},"array":[]}` {
		t.Fatalf("jsontext.Value must be parsed as ordered JSON: %v (%v)", encoded, err)
	}
	if _, err := Encode([]string{"ordered_json"}, Value([]byte(`{"value":1}`))); err == nil || !strings.HasPrefix(err.Error(), "CODEC_ENCODE") {
		t.Fatalf("json []byte input must be rejected as a non-portable value: %v", err)
	}
	for _, c := range []struct {
		styles    []string
		raw, code string
	}{
		{[]string{"ordered_json"}, "{bad", "CODEC_DECODE"},
		{[]string{"serialize"}, "O:8:\"stdClass\":0:{}", "CODEC_UNSUPPORTED"},
		{[]string{"serialize"}, "a:1:{i:0;", "CODEC_DECODE"},
		{[]string{"serialize", "gz"}, "not zlib", "CODEC_DECODE"},
		{[]string{"serialize", "base64"}, "@@@", "CODEC_DECODE"},
		{[]string{"yaml"}, "a: 1\na: 2\n", "CODEC_DECODE"},
		{[]string{"yaml"}, "---\na: 1\n---\na: 2\n", "CODEC_DECODE"},
		{[]string{"yaml"}, "a: &x [1]\nb: *x\n", "CODEC_DECODE"},
		{[]string{"yaml"}, "a: !custom value\n", "CODEC_DECODE"},
		{[]string{"yaml"}, "value: .inf\n", "CODEC_DECODE"},
		{[]string{"yaml"}, "true: value\n", "CODEC_DECODE"},
	} {
		_, err := Decode(c.styles, c.raw)
		if err == nil || err.Error()[:len(c.code)] != c.code {
			t.Errorf("%v %q: %v", c.styles, c.raw, err)
		}
	}
	if s, _ := Encode([]string{"serialize"}, Value(map[string]any{"07": 1, "-3": 2, "10": 3, "x": 4.0, "y": 1e25})); s != `a:5:{i:-3;i:2;s:2:"07";i:1;i:10;i:3;s:1:"x";d:4;s:1:"y";d:1.0E+25;}` {
		t.Errorf("php keys/floats: %s", s)
	}
	if got, err := Decode([]string{"yaml"}, "1: value\n"); err != nil || canonStyled(t, got) != `{"1":"value"}` {
		t.Errorf("yaml integer key: %v (%v)", got, err)
	}
	for name, operation := range map[string]func() error{
		"invalid yaml order": func() error {
			_, err := Encode([]string{"serialize", "yaml"}, Value(map[string]any{}))
			return err
		},
	} {
		if err := operation(); err == nil {
			t.Errorf("%s: expected codec error", name)
		}
	}
}

func TestOrderedJSONCodecPreservesKindsAndObjectOrder(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	const source = `{"z":{},"a":[],"nested":{"second":2,"first":1}}`
	decoded, err := Decode([]string{"ordered_json"}, source)
	if err != nil {
		t.Fatal(err)
	}
	decodedValue, _ := decoded.Data()
	value, ok := decodedValue.(*orderedjson.Value)
	if !ok {
		t.Fatalf("decoded JSON type = %T, want *orderedjson.Value", decoded)
	}
	if value.Kind() != orderedjson.ObjectKind {
		t.Fatalf("root kind = %q, want object", value.Kind())
	}
	members, err := value.Members()
	if err != nil {
		t.Fatal(err)
	}
	keys := members.Keys()
	if len(keys) != 3 {
		t.Fatalf("member count = %d, want 3", len(keys))
	}
	for i, want := range []string{"z", "a", "nested"} {
		got, err := keys[i].StringValue()
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("member key %d = %q, want %q", i, got, want)
		}
	}
	if value.Get("z").Kind() != orderedjson.ObjectKind || value.Get("a").Kind() != orderedjson.ArrayKind {
		t.Fatal("empty object and array kinds were not preserved")
	}
	encoded, err := Encode([]string{"ordered_json"}, Value(value))
	if err != nil {
		t.Fatal(err)
	}
	if encoded != source {
		t.Fatalf("encoded JSON = %q, want %q", encoded, source)
	}
}

func TestOrderedJSONCodecConvertsTaggedGoStructs(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	type value struct {
		ID      string         `json:"id"`
		Empty   string         `json:"empty,omitempty"`
		Items   []int          `json:"items"`
		Raw     jsontext.Value `json:"raw"`
		Ignored string         `json:"-"`
	}
	encoded, err := Encode([]string{"ordered_json"}, Value(value{
		ID:      "module.example",
		Items:   []int{1, 2},
		Raw:     jsontext.Value(`{"enabled":true}`),
		Ignored: "must not be stored",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"module.example","items":[1,2],"raw":{"enabled":true}}`
	if encoded != want {
		t.Fatalf("encoded struct = %q, want %q", encoded, want)
	}
}

func TestOrderedJSONCodecParsesJSONRawMessage(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	type value struct {
		Config json.RawMessage `json:"config"`
	}
	encoded, err := Encode([]string{"ordered_json"}, Value(value{Config: json.RawMessage(`{"enabled":true,"items":[]}`)}))
	if err != nil {
		t.Fatal(err)
	}
	if encoded != `{"config":{"enabled":true,"items":[]}}` {
		t.Fatalf("encoded raw message = %q", encoded)
	}
}

func TestOrderedJSONCodecUsesCustomJSONMarshaler(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	type value struct {
		Body customJSONValue `json:"body"`
	}
	encoded, err := Encode([]string{"ordered_json"}, Value(value{Body: customJSONValue{body: []byte(`{"number":900719925474099312345678901234567890}`)}}))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"body":{"number":900719925474099312345678901234567890}}`
	if encoded != want {
		t.Fatalf("encoded custom JSON value = %q, want %q", encoded, want)
	}
}

func TestOrderedJSONCodecEncodesNilMarshalerPointersAsNull(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	type value struct {
		Body    string     `json:"body"`
		Revoked *time.Time `json:"revokedAt"`
	}
	encoded, err := Encode([]string{"ordered_json"}, Value(value{Body: "kept"}))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"body":"kept","revokedAt":null}`
	if encoded != want {
		t.Fatalf("encoded nil marshaler pointer = %q, want %q", encoded, want)
	}
}

func TestOrderedJSONCodecFlattensAnonymousStruct(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	type Details struct {
		ID string `json:"id"`
	}
	type value struct {
		Details
		Name string `json:"name"`
	}
	encoded, err := Encode([]string{"ordered_json"}, Value(value{Details: Details{ID: "1"}, Name: "test"}))
	if err != nil {
		t.Fatal(err)
	}
	if encoded != `{"id":"1","name":"test"}` {
		t.Fatalf("encoded anonymous struct = %q", encoded)
	}
}

type customJSONValue struct{ body []byte }

func (v customJSONValue) MarshalJSON() ([]byte, error) { return v.body, nil }

// codecStages maps the stage names that the shared vectors of tests/codec and contracts/fixtures use
// to dbspec codec stage names. The shared vectors still use json and jsons,
// and in dbspec both are ordered_json.
func codecStages(styles []string) []string {
	out := make([]string, len(styles))
	for i, style := range styles {
		switch style {
		case "json", "jsons":
			out[i] = "ordered_json"
		default:
			out[i] = style
		}
	}
	return out
}
