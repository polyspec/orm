package orm

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
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
	d, _ := jsonDecode(b)
	return d
}

func TestCodecErrors(t *testing.T) {
	for _, c := range []struct{ styles []string; raw, code string }{
		{[]string{"json"}, "{bad", "CODEC_DECODE"},
		{[]string{"serialize"}, "O:8:\"stdClass\":0:{}", "CODEC_UNSUPPORTED"},
		{[]string{"serialize"}, "a:1:{i:0;", "CODEC_DECODE"},
		{[]string{"serialize", "gz"}, "not zlib", "CODEC_DECODE"},
		{[]string{"serialize", "base64"}, "@@@", "CODEC_DECODE"},
	} {
		_, err := Decode(c.styles, c.raw)
		if err == nil || err.Error()[:len(c.code)] != c.code {
			t.Errorf("%v %q: %v", c.styles, c.raw, err)
		}
	}
	if s, _ := Encode([]string{"serialize"}, map[string]any{"07": 1, "-3": 2, "10": 3, "x": 4.0, "y": 1e25}); s != `a:5:{i:-3;i:2;s:2:"07";i:1;i:10;i:3;s:1:"x";d:4;s:1:"y";d:1.0E+25;}` {
		t.Errorf("php keys/floats: %s", s)
	}
}
