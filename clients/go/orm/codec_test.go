package orm

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/json/jsontext"
	"os"
	"strconv"
	"strings"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/go"
)

type codecVector struct {
	Name          string   `json:"name"`
	Styles        []string `json:"styles"`
	Value         any      `json:"value"`
	EncodedB64    *string  `json:"encoded_b64"`
	Deterministic bool     `json:"deterministic"`
}

func canon(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestCodecVectors: every PHP-produced vector decodes to the same value, and
// deterministic styles re-encode to the same bytes. Go's encodings are written
// to tests/codec/out/go.json for the PHP cross-check.
func TestCodecVectors(t *testing.T) {
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
		want := canon(t, jsonNumbers(reNumber(v.Value)))
		var raw any
		if v.EncodedB64 != nil {
			b, err := base64.StdEncoding.DecodeString(*v.EncodedB64)
			if err != nil {
				t.Fatal(err)
			}
			raw = string(b)
		}
		got, err := Decode(v.Styles, raw)
		if err != nil {
			t.Errorf("%s: decode: %v", v.Name, err)
			continue
		}
		if g := canon(t, got); g != want {
			t.Errorf("%s: decoded %s want %s", v.Name, g, want)
		}
		enc, err := Encode(v.Styles, got)
		if err != nil {
			t.Errorf("%s: encode: %v", v.Name, err)
			continue
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
			t.Errorf("%s: encoded %v want %v", v.Name, deref(encB64), deref(v.EncodedB64))
		}
		// round trip through our own decoder
		back, err := Decode(v.Styles, enc)
		if err != nil || canon(t, back) != want {
			t.Errorf("%s: round trip %s (%v)", v.Name, canon(t, back), err)
		}
	}
	os.MkdirAll("../../../tests/codec/out", 0o755)
	b, _ := json.MarshalIndent(out, "", "  ")
	if err := os.WriteFile("../../../tests/codec/out/go.json", b, 0o644); err != nil {
		t.Fatal(err)
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
	if encoded, err := Encode([]string{"json"}, jsontext.Value(`{"object":{},"array":[]}`)); err != nil || encoded != `{"object":{},"array":[]}` {
		t.Fatalf("jsontext.Value must be parsed as ordered JSON: %v (%v)", encoded, err)
	}
	if _, err := Encode([]string{"json"}, []byte(`{"value":1}`)); err == nil || !strings.HasPrefix(err.Error(), "CODEC_ENCODE") {
		t.Fatalf("json []byte input must be rejected as a non-portable value: %v", err)
	}
	for _, c := range []struct {
		styles    []string
		raw, code string
	}{
		{[]string{"json"}, "{bad", "CODEC_DECODE"},
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
	if s, _ := Encode([]string{"serialize"}, map[string]any{"07": 1, "-3": 2, "10": 3, "x": 4.0, "y": 1e25}); s != `a:5:{i:-3;i:2;s:2:"07";i:1;i:10;i:3;s:1:"x";d:4;s:1:"y";d:1.0E+25;}` {
		t.Errorf("php keys/floats: %s", s)
	}
	if got, err := Decode([]string{"yaml"}, "1: value\n"); err != nil || canon(t, got) != `{"1":"value"}` {
		t.Errorf("yaml integer key: %v (%v)", got, err)
	}
	for name, operation := range map[string]func() error{
		"invalid public upload file": func() error {
			_, err := Encode([]string{"curlfile", "serialize"}, map[string]any{"$type": "upload_file", "path": "", "mime": "text/plain", "name": "a.txt"})
			return err
		},
		"invalid stored upload file": func() error {
			_, err := Decode([]string{"curlfile", "serialize"}, `a:4:{s:12:"is_curl_file";b:1;s:4:"mime";s:10:"text/plain";s:4:"name";s:5:"a.txt";s:4:"path";s:0:"";}`)
			return err
		},
		"invalid curlfile order": func() error {
			_, err := Encode([]string{"serialize", "curlfile"}, map[string]any{})
			return err
		},
		"invalid yaml order": func() error {
			_, err := Encode([]string{"serialize", "yaml"}, map[string]any{})
			return err
		},
	} {
		if err := operation(); err == nil {
			t.Errorf("%s: expected codec error", name)
		}
	}
}

func TestOrderedJSONCodecPreservesKindsAndObjectOrder(t *testing.T) {
	const source = `{"z":{},"a":[],"nested":{"second":2,"first":1}}`
	decoded, err := Decode([]string{"json"}, source)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := decoded.(*orderedjson.Value)
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
	encoded, err := Encode([]string{"json"}, value)
	if err != nil {
		t.Fatal(err)
	}
	if encoded != source {
		t.Fatalf("encoded JSON = %q, want %q", encoded, source)
	}
}

func TestOrderedJSONCodecConvertsTaggedGoStructs(t *testing.T) {
	type value struct {
		ID      string         `json:"id"`
		Empty   string         `json:"empty,omitempty"`
		Items   []int          `json:"items"`
		Raw     jsontext.Value `json:"raw"`
		Ignored string         `json:"-"`
	}
	encoded, err := Encode([]string{"json"}, value{
		ID:      "module.example",
		Items:   []int{1, 2},
		Raw:     jsontext.Value(`{"enabled":true}`),
		Ignored: "must not be stored",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"module.example","items":[1,2],"raw":{"enabled":true}}`
	if encoded != want {
		t.Fatalf("encoded struct = %q, want %q", encoded, want)
	}
}

func TestOrderedJSONCodecParsesJSONRawMessage(t *testing.T) {
	type value struct {
		Config json.RawMessage `json:"config"`
	}
	encoded, err := Encode([]string{"json"}, value{Config: json.RawMessage(`{"enabled":true,"items":[]}`)})
	if err != nil {
		t.Fatal(err)
	}
	if encoded != `{"config":{"enabled":true,"items":[]}}` {
		t.Fatalf("encoded raw message = %q", encoded)
	}
}
