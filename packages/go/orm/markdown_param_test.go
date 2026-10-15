package orm

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
)

// bindVectors is tests/bind/vectors.json: the shared cases of the bind paths that
// the six implementations run (tests/bind/README.md).
type bindVectors struct {
	Zone    string `json:"zone"`
	Message []struct {
		Name      string `json:"name"`
		Type      string `json:"type"`
		Precision int    `json:"precision"`
		Value     string `json:"value"`
		JSON      string `json:"json"`
		Code      string `json:"code"`
	} `json:"message"`
}

// TestBindMessageVectors writes each message case of tests/bind/vectors.json as an
// IR executor message parameter (docs/protocol.md §5 "Parameters").
func TestBindMessageVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../tests/bind/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v bindVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Zone != "+00:00" {
		t.Fatalf("zone %q; this runner writes in UTC", v.Zone)
	}
	d := &DB{location: time.UTC}
	for _, c := range v.Message {
		t.Run(c.Name, func(t *testing.T) {
			got, err := d.markdownParam(0, c.Value, []ir.ParamUse{{Type: c.Type}})
			if c.Code != "" {
				var e *ir.Error
				if !errors.As(err, &e) || e.Code != c.Code {
					t.Fatalf("markdownParam(%q) = %s, %v; want %s", c.Value, got, err, c.Code)
				}
				return
			}
			want, _ := json.Marshal(c.JSON)
			if err != nil || string(got) != string(want) {
				t.Fatalf("markdownParam(%q) = %s, %v; want %s", c.Value, got, err, want)
			}
		})
	}
}
