// Package recipe runs the cases of a recipe (docs/spec/feature-coverage.md FCV-2 to FCV-4) in Go: the entry of each suite
// unit, TestRecipe<Recipe><Database>, starts its case with packages/go/testcase and calls Run with the recipe and the
// database, and Run runs each case as a subtest whose
// steps call the public API of the orm package that each op names. It has no command line and no output of its own.
package recipe

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/packages/go"
	"github.com/polyspec/orm/packages/go/orm"
)

// None is the database part of a recipe without a database (FCV-3).
const None = "none"

type file struct {
	Cases []recipeCase `json:"cases"`
}

type recipeCase struct {
	ID    string            `json:"id"`
	Steps []json.RawMessage `json:"steps"`
}

type step struct {
	Op     string                     `json:"op"`
	Styles []string                   `json:"styles"`
	Raw    json.RawMessage            `json:"raw"`
	Value  json.RawMessage            `json:"value"`
	Key    *string                    `json:"key"`
	As     string                     `json:"as"`
	Expect map[string]json.RawMessage `json:"expect"`
}

// result is what a step produced: the decoded value of a decode, the cell of an encode, or the error of either.
type result struct {
	styled  orm.StyledValue // a codec.decode
	decoded bool
	cell    any // the cell or text of an encode, a host decode or a blind index
	err     error
}

// Run runs every case of the recipe at path, relative to the test's package directory, on database.
func Run(t *testing.T, path, database string) {
	t.Helper()
	if database != None {
		t.Fatalf("recipe %s: database %s has no case database in this helper", path, database)
	}
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f file
	if err := json.Unmarshal(src, &f); err != nil {
		t.Fatalf("recipe %s: %v", path, err)
	}
	for _, c := range f.Cases {
		t.Run(c.ID, func(t *testing.T) {
			bound := map[string]result{}
			for index, raw := range c.Steps {
				var s step
				if err := json.Unmarshal(raw, &s); err != nil {
					t.Fatalf("recipe %s case %s step %d on %s: %v", path, c.ID, index, database, err)
				}
				if err := run(s, bound, database); err != nil {
					t.Fatalf("recipe %s case %s step %d (%s) on %s: %v", path, c.ID, index, s.Op, database, err)
				}
			}
		})
	}
}

// run maps the op of s to its call and checks the result against the expect of database.
func run(s step, bound map[string]result, database string) error {
	var r result
	switch s.Op {
	case "codec.decode":
		raw, err := argument(s.Raw, bound)
		if err != nil {
			return err
		}
		r.styled, r.err = orm.Decode(s.Styles, raw)
		r.decoded = true
	case "codec.encode":
		value, err := styledArgument(s.Value, s.Styles, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.Encode(s.Styles, value)
	case "codec.host_encode":
		value, err := argument(s.Value, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.HostEncode(value, s.Styles, key(s))
	case "codec.host_decode":
		raw, err := argument(s.Raw, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.HostDecode(raw, s.Styles, key(s))
	case "codec.blind_index":
		value, err := argument(s.Value, bound)
		if err != nil {
			return err
		}
		r.cell, r.err = orm.BlindIndex(value, key(s))
	default:
		return fmt.Errorf("OP_UNKNOWN %s", s.Op)
	}
	if s.As != "" {
		bound[s.As] = r
	}
	expect, ok := s.Expect[database]
	if !ok {
		if r.err != nil {
			return fmt.Errorf("unexpected error %w", r.err)
		}
		return nil
	}
	return check(expect, r, s.Styles)
}

func key(s step) string {
	if s.Key == nil {
		return ""
	}
	return *s.Key
}

// check compares r with the outcome {value} or {error} of an expect.
func check(raw json.RawMessage, r result, styles []string) error {
	var outcome struct {
		Value json.RawMessage `json:"value"`
		Error string          `json:"error"`
	}
	if err := json.Unmarshal(raw, &outcome); err != nil {
		return err
	}
	if outcome.Error != "" {
		if got := orm.ErrorCode(r.err); got != outcome.Error {
			return fmt.Errorf("error %q (%w), want %s", got, r.err, outcome.Error)
		}
		return nil
	}
	if r.err != nil {
		return fmt.Errorf("unexpected error %w", r.err)
	}
	want, err := wrapper(outcome.Value)
	if err != nil {
		return err
	}
	if !r.decoded {
		return compareCell(want, r.cell)
	}
	value, present := r.styled.Data()
	if !present {
		if want.kind != "null" {
			return fmt.Errorf("SQL NULL, want %s", want)
		}
		return nil
	}
	got, err := fromGo(value)
	if err != nil {
		return err
	}
	if !equal(got, want, slices.Contains(styles, "ordered_json")) {
		return fmt.Errorf("decoded %s, want %s", got, want)
	}
	return nil
}

// compareCell compares the cell of an encode, a host decode or a blind index with a wrapper: bytes by bytes, a text cell
// by its UTF-8 bytes (FCV-4), and SQL NULL with null.
func compareCell(want node, cell any) error {
	var got []byte
	switch c := cell.(type) {
	case nil:
		if want.kind != "null" {
			return fmt.Errorf("no cell, want %s", want)
		}
		return nil
	case string:
		got = []byte(c)
	case []byte:
		got = c
	default:
		return fmt.Errorf("cell of type %T", cell)
	}
	var expected []byte
	switch want.kind {
	case "bytes_hex":
		b, err := hex.DecodeString(want.text)
		if err != nil {
			return err
		}
		expected = b
	case "text":
		expected = []byte(want.text)
	default:
		return fmt.Errorf("a cell compares with bytes_hex or text, not %s", want.kind)
	}
	if !bytes.Equal(got, expected) {
		return fmt.Errorf("cell %x, want %x", got, expected)
	}
	return nil
}

// node is a recipe wrapper as a tree: its kind (int, float, text, bool, nil, null, bytes_hex, array, object, and the time
// forms), its text, and its items or members in order.
type node struct {
	kind    string
	text    string
	items   []node
	members []member
}

type member struct {
	key   string
	value node
}

func (n node) String() string {
	switch n.kind {
	case "array":
		parts := make([]string, len(n.items))
		for i, item := range n.items {
			parts[i] = item.String()
		}
		return "[" + strings.Join(parts, ",") + "]"
	case "object":
		parts := make([]string, len(n.members))
		for i, m := range n.members {
			parts[i] = strconv.Quote(m.key) + ":" + m.value.String()
		}
		return "{" + strings.Join(parts, ",") + "}"
	case "nil":
		return "nil"
	}
	return n.kind + "(" + n.text + ")"
}

func wrapper(raw json.RawMessage) (node, error) {
	var w map[string]json.RawMessage
	if err := json.Unmarshal(raw, &w); err != nil || len(w) != 1 {
		return node{}, fmt.Errorf("a value is a wrapper with one key: %s", raw)
	}
	for kind, body := range w {
		switch kind {
		case "array":
			var items []json.RawMessage
			if err := json.Unmarshal(body, &items); err != nil {
				return node{}, err
			}
			n := node{kind: kind}
			for _, item := range items {
				child, err := wrapper(item)
				if err != nil {
					return node{}, err
				}
				n.items = append(n.items, child)
			}
			return n, nil
		case "object":
			var pairs [][2]json.RawMessage
			if err := json.Unmarshal(body, &pairs); err != nil {
				return node{}, err
			}
			n := node{kind: kind}
			for _, pair := range pairs {
				var k string
				if err := json.Unmarshal(pair[0], &k); err != nil {
					return node{}, err
				}
				child, err := wrapper(pair[1])
				if err != nil {
					return node{}, err
				}
				n.members = append(n.members, member{k, child})
			}
			return n, nil
		case "bool":
			var b bool
			if err := json.Unmarshal(body, &b); err != nil {
				return node{}, err
			}
			return node{kind: kind, text: strconv.FormatBool(b)}, nil
		case "nil":
			return node{kind: kind}, nil
		default:
			var text string
			if err := json.Unmarshal(body, &text); err != nil {
				return node{}, err
			}
			return node{kind: kind, text: text}, nil
		}
	}
	panic("unreachable")
}

// argument is the Go value of an argument: a ref to a bound result, or a wrapper.
func argument(raw json.RawMessage, bound map[string]result) (any, error) {
	if ref, ok, err := reference(raw, bound); ok || err != nil {
		return ref, err
	}
	n, err := wrapper(raw)
	if err != nil {
		return nil, err
	}
	return toGo(n)
}

func reference(raw json.RawMessage, bound map[string]result) (any, bool, error) {
	var ref struct {
		Ref *string `json:"ref"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		return nil, false, err
	}
	if ref.Ref == nil {
		return nil, false, nil
	}
	r, ok := bound[*ref.Ref]
	if !ok {
		return nil, true, fmt.Errorf("ref %s names no bound result", *ref.Ref)
	}
	if r.err != nil {
		return nil, true, fmt.Errorf("ref %s names a failed step: %w", *ref.Ref, r.err)
	}
	if r.decoded {
		return r.styled, true, nil
	}
	return r.cell, true, nil
}

// styledArgument is the styled value an encode takes: SQL NULL for null, an ordered-json value for an ordered_json stage,
// so that its member order and number text are those of the recipe, and the common value model otherwise.
func styledArgument(raw json.RawMessage, styles []string, bound map[string]result) (orm.StyledValue, error) {
	if ref, ok, err := reference(raw, bound); ok || err != nil {
		if err != nil {
			return orm.StyledValue{}, err
		}
		if styled, isStyled := ref.(orm.StyledValue); isStyled {
			return styled, nil
		}
		return orm.Value(ref), nil
	}
	n, err := wrapper(raw)
	if err != nil {
		return orm.StyledValue{}, err
	}
	if n.kind == "null" {
		return orm.SqlNull(), nil
	}
	if slices.Contains(styles, "ordered_json") {
		text, err := jsonText(n)
		if err != nil {
			return orm.StyledValue{}, err
		}
		v, err := orderedjson.Parse(text)
		if err != nil {
			return orm.StyledValue{}, err
		}
		return orm.Value(v), nil
	}
	v, err := toGo(n)
	if err != nil {
		return orm.StyledValue{}, err
	}
	return orm.Value(v), nil
}

// jsonText writes n as JSON text with its members in order and its numbers as their recipe text.
func jsonText(n node) (string, error) {
	switch n.kind {
	case "nil":
		return "null", nil
	case "bool", "int", "float":
		return n.text, nil
	case "text":
		b, err := json.Marshal(n.text)
		return string(b), err
	case "array":
		parts := make([]string, len(n.items))
		for i, item := range n.items {
			text, err := jsonText(item)
			if err != nil {
				return "", err
			}
			parts[i] = text
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case "object":
		parts := make([]string, len(n.members))
		for i, m := range n.members {
			k, err := json.Marshal(m.key)
			if err != nil {
				return "", err
			}
			text, err := jsonText(m.value)
			if err != nil {
				return "", err
			}
			parts[i] = string(k) + ":" + text
		}
		return "{" + strings.Join(parts, ",") + "}", nil
	}
	return "", fmt.Errorf("the wrapper %s has no JSON text", n.kind)
}

// toGo is the Go value of a wrapper in the common value model of COD-16.
func toGo(n node) (any, error) {
	switch n.kind {
	case "nil", "null":
		return nil, nil
	case "bool":
		return n.text == "true", nil
	case "int":
		if i, err := strconv.ParseInt(n.text, 10, 64); err == nil {
			return i, nil
		}
		return strconv.ParseUint(n.text, 10, 64)
	case "float":
		return strconv.ParseFloat(n.text, 64)
	case "text":
		return n.text, nil
	case "bytes_hex":
		return hex.DecodeString(n.text)
	case "array":
		out := make([]any, len(n.items))
		for i, item := range n.items {
			v, err := toGo(item)
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	case "object":
		out := make(map[string]any, len(n.members))
		for _, m := range n.members {
			v, err := toGo(m.value)
			if err != nil {
				return nil, err
			}
			out[m.key] = v
		}
		return out, nil
	}
	return nil, fmt.Errorf("a %s wrapper is not a codec value", n.kind)
}

// fromGo is the tree of a decoded Go value; an ordered-json value keeps its member order and number text.
func fromGo(v any) (node, error) {
	switch x := v.(type) {
	case nil:
		return node{kind: "nil"}, nil
	case bool:
		return node{kind: "bool", text: strconv.FormatBool(x)}, nil
	case int64:
		return node{kind: "int", text: strconv.FormatInt(x, 10)}, nil
	case int:
		return node{kind: "int", text: strconv.Itoa(x)}, nil
	case uint64:
		return node{kind: "int", text: strconv.FormatUint(x, 10)}, nil
	case float64:
		return node{kind: "float", text: strconv.FormatFloat(x, 'g', -1, 64)}, nil
	case string:
		return node{kind: "text", text: x}, nil
	case []byte:
		return node{kind: "bytes_hex", text: hex.EncodeToString(x)}, nil
	case []any:
		n := node{kind: "array"}
		for _, item := range x {
			child, err := fromGo(item)
			if err != nil {
				return node{}, err
			}
			n.items = append(n.items, child)
		}
		return n, nil
	case map[string]any:
		n := node{kind: "object"}
		for k, item := range x {
			child, err := fromGo(item)
			if err != nil {
				return node{}, err
			}
			n.members = append(n.members, member{k, child})
		}
		return n, nil
	case *orderedjson.Value:
		return fromOrdered(x)
	}
	return node{}, fmt.Errorf("decoded value of type %T", v)
}

func fromOrdered(v *orderedjson.Value) (node, error) {
	switch v.Kind() {
	case orderedjson.NullKind:
		return node{kind: "nil"}, nil
	case orderedjson.BooleanKind:
		b, err := v.BooleanValue()
		return node{kind: "bool", text: strconv.FormatBool(b)}, err
	case orderedjson.StringKind:
		s, err := v.StringValue()
		return node{kind: "text", text: s}, err
	case orderedjson.NumberKind:
		text, err := v.NumberLiteral()
		if err != nil {
			return node{}, err
		}
		if strings.ContainsAny(text, ".eE") {
			return node{kind: "float", text: text}, nil
		}
		return node{kind: "int", text: text}, nil
	case orderedjson.ArrayKind:
		items, err := v.Items()
		if err != nil {
			return node{}, err
		}
		n := node{kind: "array"}
		for _, item := range items {
			child, err := fromOrdered(item)
			if err != nil {
				return node{}, err
			}
			n.items = append(n.items, child)
		}
		return n, nil
	case orderedjson.ObjectKind:
		members, err := v.Members()
		if err != nil {
			return node{}, err
		}
		n := node{kind: "object"}
		for _, k := range members.Keys() {
			name, err := k.StringValue()
			if err != nil {
				return node{}, err
			}
			child, err := fromOrdered(members.Get(name))
			if err != nil {
				return node{}, err
			}
			n.members = append(n.members, member{name, child})
		}
		return n, nil
	}
	return node{}, fmt.Errorf("ordered-json kind %s", v.Kind())
}

// equal compares a decoded tree with a wrapper: an ordered-json value by its number text and member order (COD-16), every
// other value by number value and with its object as a set of pairs, since no other style defines a member order (FCV-4).
func equal(got, want node, ordered bool) bool {
	if got.kind != want.kind {
		return false
	}
	switch got.kind {
	case "float":
		if ordered {
			return got.text == want.text
		}
		return sameFloat(got.text, want.text)
	case "int":
		if ordered {
			return got.text == want.text
		}
		a, okA := new(big.Int).SetString(got.text, 10)
		b, okB := new(big.Int).SetString(want.text, 10)
		return okA && okB && a.Cmp(b) == 0
	case "array":
		if len(got.items) != len(want.items) {
			return false
		}
		for i := range got.items {
			if !equal(got.items[i], want.items[i], ordered) {
				return false
			}
		}
		return true
	case "object":
		if len(got.members) != len(want.members) {
			return false
		}
		if ordered {
			for i := range got.members {
				if got.members[i].key != want.members[i].key || !equal(got.members[i].value, want.members[i].value, ordered) {
					return false
				}
			}
			return true
		}
		for _, w := range want.members {
			found := false
			for _, g := range got.members {
				if g.key == w.key && equal(g.value, w.value, ordered) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
		return true
	}
	return got.text == want.text
}

// sameFloat reports whether two number texts name the same binary64 value (FCV-4).
func sameFloat(a, b string) bool {
	x, errA := strconv.ParseFloat(a, 64)
	y, errB := strconv.ParseFloat(b, 64)
	return errA == nil && errB == nil && (x == y || math.IsNaN(x) && math.IsNaN(y))
}
