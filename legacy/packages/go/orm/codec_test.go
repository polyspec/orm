package orm

// The Go input types of the ordered_json stage (COD-17), which no recipe value names; the codec cases that every client
// shares are the codec recipe, tests/codec/codec.json (recipe_codec_test.go).

import (
	"encoding/json"
	"encoding/json/jsontext"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

func TestOrderedJSONCodecTakesGoJSONInputs(t *testing.T) {
	// The test of COD-17, COD-23 (docs/spec).
	testcase.Start(t, testcase.Compute)
	if encoded, err := Encode([]string{"ordered_json"}, Value(jsontext.Value(`{"object":{},"array":[]}`))); err != nil || encoded != `{"object":{},"array":[]}` {
		t.Fatalf("jsontext.Value must be parsed as ordered JSON: %v (%v)", encoded, err)
	}
	if _, err := Encode([]string{"ordered_json"}, Value([]byte(`{"value":1}`))); err == nil || !strings.HasPrefix(err.Error(), "CODEC_ENCODE") {
		t.Fatalf("json []byte input must be rejected as a non-portable value: %v", err)
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

// TestOrderedJSONCodecRefusesJSONTextPastTheNestingLimit holds json-depth of COD-70 for the Go values whose bytes are one JSON
// text: a jsontext.Value, a json.RawMessage and a json.Marshaler, alone or inside a list, are refused as a value nested deeper
// than 256 levels is, and a text at the limit is taken.
func TestOrderedJSONCodecRefusesJSONTextPastTheNestingLimit(t *testing.T) {
	// The test of COD-70 (docs/spec).
	testcase.Start(t, testcase.Compute)
	nested := func(levels int) []byte { return []byte(strings.Repeat("[", levels) + strings.Repeat("]", levels)) }
	const refused = "CODEC_ENCODE: json: value nesting exceeds 256 levels"
	for _, tc := range []struct {
		name  string
		value any
		want  string
	}{
		{"text at the limit", jsontext.Value(nested(256)), ""},
		{"text past the limit", jsontext.Value(nested(257)), refused},
		{"raw message past the limit", json.RawMessage(nested(257)), refused},
		{"marshaler past the limit", customJSONValue{body: nested(257)}, refused},
		{"text at the limit inside a list", []any{jsontext.Value(nested(255))}, ""},
		{"text past the limit inside a list", []any{jsontext.Value(nested(256))}, refused},
		{"raw message past the limit inside a list", []any{json.RawMessage(nested(256))}, refused},
	} {
		_, err := Encode([]string{"ordered_json"}, Value(tc.value))
		switch {
		case tc.want == "" && err != nil:
			t.Errorf("%s: %v", tc.name, err)
		case tc.want != "" && (err == nil || err.Error() != tc.want):
			t.Errorf("%s: error %v, want %s", tc.name, err, tc.want)
		}
	}
}

func TestOrderedJSONCodecUsesCustomJSONMarshaler(t *testing.T) {
	// The test of COD-22 (docs/spec).
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
