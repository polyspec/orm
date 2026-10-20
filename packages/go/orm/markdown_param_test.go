package orm

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/testcase"
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
	Bind []bindCase `json:"bind"`
	// Control holds the begin control message of a transaction with and without its read_only option.
	Control []struct {
		Name     string          `json:"name"`
		ReadOnly bool            `json:"read_only"`
		JSON     json.RawMessage `json:"json"`
	} `json:"control"`
}

// bindCase is a bind case of tests/bind/vectors.json: a parameter value checked against
// the logical type of its slot, with the value it binds or the error code.
type bindCase struct {
	Name string `json:"name"`
	Slot struct {
		Type      string `json:"type"`
		Precision int    `json:"precision"`
		Scale     int    `json:"scale"`
		Length    int    `json:"length"`
		Transform string `json:"transform"`
		NotNull   bool   `json:"not_null"`
	} `json:"slot"`
	Value json.RawMessage `json:"value"`
	Bound json.RawMessage `json:"bound"`
	Code  string          `json:"code"`
}

// TestBindMessageVectors writes each message case of tests/bind/vectors.json as an
// IR executor message parameter (docs/spec/protocol.md §5 "Parameters").
func TestBindMessageVectors(t *testing.T) {
	// Requirements: PRT-67.
	testcase.Start(t, testcase.Compute)
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
	if len(v.Control) == 0 {
		t.Fatal("tests/bind/vectors.json has no control cases")
	}
	for _, c := range v.Control {
		t.Run("control/"+c.Name, func(t *testing.T) {
			got, err := json.Marshal(beginMessage(c.ReadOnly))
			if err != nil {
				t.Fatal(err)
			}
			var gotValue, wantValue any
			if err := json.Unmarshal(got, &gotValue); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(c.JSON, &wantValue); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(gotValue, wantValue) {
				t.Fatalf("begin of read_only %v = %s; want %s", c.ReadOnly, got, c.JSON)
			}
		})
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
