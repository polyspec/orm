package orm

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/testcase"
)

// vectorValue reads a value of a bind case as the host value a Go program passes: a JSON
// integer is an int64, another number a float64, {"int": text} an integer that JSON numbers
// cannot carry, {"f64": "NaN"|"Infinity"|"-Infinity"} a non-finite float and {"bytes":
// base64} a []byte.
func vectorValue(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	switch x := v.(type) {
	case json.Number:
		if !strings.ContainsAny(x.String(), ".eE") {
			n, err := x.Int64()
			if err != nil {
				t.Fatal(err)
			}
			return n
		}
		f, err := x.Float64()
		if err != nil {
			t.Fatal(err)
		}
		return f
	case map[string]any:
		switch {
		case x["native"] != nil:
			// A native value of the tagged kind: the host time value a Go program passes for it.
			switch x["native"] {
			case "date":
				return time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)
			case "time":
				return time.Date(1, 1, 1, 10, 0, 0, 0, time.UTC)
			case "datetime":
				return time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
			}
			t.Fatalf("native kind %v is not a time kind", x["native"])
		case x["int"] != nil:
			n, ok := new(big.Int).SetString(x["int"].(string), 10)
			if !ok || !n.IsInt64() {
				t.Fatalf("int %v is not an int64", x["int"])
			}
			return n.Int64()
		case x["f64"] != nil:
			switch x["f64"] {
			case "NaN":
				return math.NaN()
			case "Infinity":
				return math.Inf(1)
			case "-Infinity":
				return math.Inf(-1)
			}
		case x["bytes"] != nil:
			b, err := base64.StdEncoding.DecodeString(x["bytes"].(string))
			if err != nil {
				t.Fatal(err)
			}
			return b
		}
		t.Fatalf("value %s has no host form", raw)
	}
	return v
}

// TestBindVectors checks each bind case of tests/bind/vectors.json against the logical
// type of its slot (docs/spec/protocol.md §5 "Parameters").
func TestBindVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	raw, err := os.ReadFile("../../../tests/bind/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v bindVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Zone != "+00:00" || len(v.Bind) == 0 {
		t.Fatalf("zone %q, %d bind cases; this runner checks in UTC", v.Zone, len(v.Bind))
	}
	d := &DB{location: time.UTC}
	for _, c := range v.Bind {
		t.Run(c.Name, func(t *testing.T) {
			value := vectorValue(t, c.Value)
			slot := paramSlot{Type: c.Slot.Type, Precision: c.Slot.Precision, Scale: c.Slot.Scale, Length: c.Slot.Length}
			var err error
			if c.Slot.Transform != "" {
				value, err = transformParam(c.Slot.Transform, value)
			} else {
				slot.NotNull, slot.Column = c.Slot.NotNull, "column"
				if err = checkAssign(0, value, slot); err == nil {
					err = d.checkParam(0, value, slot)
				}
			}
			if c.Code != "" {
				var e *ir.Error
				if !errors.As(err, &e) || e.Code != c.Code {
					t.Fatalf("checkParam(%s) = %v; want %s", c.Value, err, c.Code)
				}
				return
			}
			if err != nil {
				t.Fatalf("checkParam(%s) = %v; want it bound", c.Value, err)
			}
			if bound := vectorValue(t, c.Bound); !reflect.DeepEqual(value, bound) && (value != nil || bound != nil) {
				t.Fatalf("checkParam(%s) bound %v; want %v", c.Value, value, bound)
			}
		})
	}
}
