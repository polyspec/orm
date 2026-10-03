package orm

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
)

func TestStyledColumnStateFixture(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	data, err := os.ReadFile("../../../contracts/fixtures/styled_column_states.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			ID         string         `json:"id"`
			Style      string         `json:"style"`
			StoredText *string        `json:"stored_text"`
			Output     map[string]any `json:"output"`
			Input      map[string]any `json:"input"`
			WriteText  *string        `json:"write_text"`
			Error      string         `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		if c.ID == "unselected" || c.ID == "nonnull_sql_null" {
			continue
		}
		t.Run(c.ID, func(t *testing.T) {
			var raw any
			if c.StoredText != nil {
				raw = *c.StoredText
			}
			got, err := Decode(codecStages([]string{c.Style}), raw)
			if c.Error != "" {
				if err == nil || !strings.Contains(err.Error(), c.Error) {
					t.Fatalf("decode error = %v; want %s", err, c.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Kind() != c.Output["kind"] {
				t.Fatalf("kind = %s, want %v", got.Kind(), c.Output["kind"])
			}
			actualJSON, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			wantJSON, err := json.Marshal(c.Output)
			if err != nil {
				t.Fatal(err)
			}
			if string(actualJSON) != string(wantJSON) {
				t.Fatalf("output = %s; want %s", actualJSON, wantJSON)
			}
			encoded, err := Encode(codecStages([]string{c.Style}), got)
			if err != nil {
				t.Fatal(err)
			}
			if c.Style == "yaml" && c.Output["kind"] == "value" {
				if encoded == nil {
					t.Fatal("YAML value null encoded as SQL NULL")
				}
			} else if c.WriteText == nil {
				if encoded != nil {
					t.Fatalf("encoded = %v; want SQL NULL", encoded)
				}
			} else if encoded != *c.WriteText {
				t.Fatalf("encoded = %v; want %q", encoded, *c.WriteText)
			}
		})
	}
}

func TestUnknownStyleRejectsSQLNull(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	if _, err := Decode([]string{"unknown"}, nil); err == nil || !strings.Contains(err.Error(), CodeCodecUnsupported) {
		t.Fatalf("decode unknown style with SQL NULL: %v", err)
	}
	if _, err := Encode([]string{"unknown"}, SqlNull()); err == nil || !strings.Contains(err.Error(), CodeCodecUnsupported) {
		t.Fatalf("encode unknown style with SQL NULL: %v", err)
	}
}
