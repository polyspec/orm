package orm

// The Go input types of the ordered_json stage (COD-17), which no recipe value names; the codec cases that every client
// shares are the codec recipe, tests/codec/codec.json (recipe_codec_test.go).

import (
	"encoding/json"
	"encoding/json/jsontext"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
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

// codecStages maps the stage names that the shared fixture contracts/fixtures/styled_column_states.json uses
// to dbspec codec stage names. The fixture still uses json and jsons, and in dbspec both are ordered_json.
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
