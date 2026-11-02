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
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/packages/go"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/orm"
)

// None is the database part of a recipe without a database (FCV-3).
const None = "none"

type file struct {
	Schema string       `json:"schema"`
	Cases  []recipeCase `json:"cases"`
}

type recipeCase struct {
	ID    string            `json:"id"`
	Steps []json.RawMessage `json:"steps"`
}

type step struct {
	Op      string                     `json:"op"`
	Styles  []string                   `json:"styles"`
	Raw     json.RawMessage            `json:"raw"`
	Value   json.RawMessage            `json:"value"`
	Key     *string                    `json:"key"`
	As      string                     `json:"as"`
	Request json.RawMessage            `json:"request"`
	Chain   string                     `json:"chain"`
	Answer  json.RawMessage            `json:"answer"`
	Answers map[string]json.RawMessage `json:"answers"`
	// Documents and Document name the .dbs files of the dbspec ops, relative to the recipe file; Text is the lines of a document text.
	Documents []string `json:"documents"`
	Document  string   `json:"document"`
	Text      []string `json:"text"`
	// Set holds the other documents of an inline dbspec op, CRLF and Mixed its line endings, Owned and External the texts of
	// dbspec.parse_set, and Path the file of dbspec.read_file and dbspec.read_bytes.
	Set      map[string][]string        `json:"set"`
	CRLF     bool                       `json:"crlf"`
	Mixed    bool                       `json:"mixed"`
	Owned    []string                   `json:"owned"`
	Parsing  map[string]string          `json:"parsing"`
	External []string                   `json:"external"`
	Path     string                     `json:"path"`
	Expect   map[string]json.RawMessage `json:"expect"`
}

// IRAnswer runs the chain of one ir.answer step on a listener that answers with the answer, or with answers keyed by the op of
// a control message or the kind of a request, and returns the result of the chain or its error. It is supplied by the test
// that owns the chain registry and the listener, since a chain cannot be reached from this package.
type IRAnswer func(t *testing.T, chain string, answer json.RawMessage, answers map[string]json.RawMessage) (any, error)

// Option configures Run.
type Option func(*options)

type options struct {
	irAnswer IRAnswer
	// dir is the directory of the recipe file, which the dbspec ops resolve their documents against.
	dir string
}

// WithIRAnswer supplies the function that runs the chain of each ir.answer step of a recipe without a database.
func WithIRAnswer(fn IRAnswer) Option {
	return func(o *options) { o.irAnswer = fn }
}

// result is what a step produced: the decoded value of a decode, the cell of an encode, or the error of either.
type result struct {
	styled  orm.StyledValue // a codec.decode
	decoded bool
	cell    any // the cell or text of an encode, a host decode or a blind index
	err     error
}

// Run runs every case of the recipe at path, relative to the test's package directory, on database. The options configure
// the ops that need a function from the test, such as WithIRAnswer.
func Run(t *testing.T, path, database string, opts ...Option) {
	t.Helper()
	if database != None {
		runDatabase(t, path, database)
		return
	}
	o := options{dir: filepath.Dir(path)}
	for _, opt := range opts {
		opt(&o)
	}
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f file
	if err := json.Unmarshal(src, &f); err != nil {
		t.Fatalf("recipe %s: %v", path, err)
	}
	// A recipe with an ir.validate step names the schema manifest of its requests, relative to the recipe file (tests/ir/validate.json).
	var model *runtimemodel.Model
	if f.Schema != "" {
		model, err = runtimemodel.LoadFiles(filepath.Join(filepath.Dir(path), f.Schema))
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range f.Cases {
		t.Run(c.ID, func(t *testing.T) {
			bound := map[string]result{}
			for index, raw := range c.Steps {
				var s step
				if err := json.Unmarshal(raw, &s); err != nil {
					t.Fatalf("recipe %s case %s step %d on %s: %v", path, c.ID, index, database, err)
				}
				if err := run(t, s, bound, database, model, o); err != nil {
					t.Fatalf("recipe %s case %s step %d (%s) on %s: %v", path, c.ID, index, s.Op, database, err)
				}
			}
		})
	}
}

// run maps the op of s to its call and checks the result against the expect of database.
func run(t *testing.T, s step, bound map[string]result, database string, model *runtimemodel.Model, o options) error {
	if strings.HasPrefix(s.Op, "dbspec.") {
		return checkDBSpec(s, o.dir, database)
	}
	if s.Op == "ir.validate" {
		return checkValidate(s.Expect[database], validate(model, s.Request))
	}
	if s.Op == "ir.answer" {
		return checkAnswer(t, s, database, o.irAnswer)
	}
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

// holdsBytes is whether the value is bytes or a list or a map that holds bytes at any depth.
func holdsBytes(n node) bool {
	if n.kind == "bytes_hex" {
		return true
	}
	for _, item := range n.items {
		if holdsBytes(item) {
			return true
		}
	}
	for _, m := range n.members {
		if holdsBytes(m.value) {
			return true
		}
	}
	return false
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
// orderedValue is the ordered-json value of a recipe value, with the member order and the number text of the recipe.
func orderedValue(n node) (orm.StyledValue, error) {
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
	// An ordered_json wrapper is the ordered-json value of its value, whatever the stages (FCV-4).
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) == nil && len(probe) == 1 && probe["ordered_json"] != nil {
		inner, err := wrapper(probe["ordered_json"])
		if err != nil {
			return orm.StyledValue{}, err
		}
		return orderedValue(inner)
	}
	n, err := wrapper(raw)
	if err != nil {
		return orm.StyledValue{}, err
	}
	if n.kind == "null" {
		return orm.SqlNull(), nil
	}
	// Bytes have no JSON text, so a value that holds bytes reaches an ordered_json stage as the value it is (COD-63).
	if slices.Contains(styles, "ordered_json") && !holdsBytes(n) {
		return orderedValue(n)
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
	case "f64":
		switch n.text {
		case "NaN":
			return math.NaN(), nil
		case "Infinity":
			return math.Inf(1), nil
		case "-Infinity":
			return math.Inf(-1), nil
		}
		return nil, fmt.Errorf("an f64 wrapper is NaN, Infinity or -Infinity, not %q", n.text)
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

// validate passes a request of an ir.validate step to the validator of the protocol, with the manifest_hash of the schema
// added (the request holds none), as the native vector test did. Its literal numbers are kept as their JSON text.
func validate(m *runtimemodel.Model, raw json.RawMessage) error {
	if m == nil {
		return fmt.Errorf("ir.validate needs the schema key of the recipe")
	}
	var request map[string]json.RawMessage
	if err := json.Unmarshal(raw, &request); err != nil {
		return err
	}
	if _, ok := request["manifest_hash"]; ok {
		return fmt.Errorf("request already holds manifest_hash")
	}
	hash, err := json.Marshal(m.ManifestHash)
	if err != nil {
		return err
	}
	request["manifest_hash"] = hash
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	_, err = ir.Decode(m, body)
	return err
}

// checkValidate compares the error of validate with the outcome of an expect: {value: bool true} for an accepted request,
// {error: CODE} for a request that fails with CODE (the error text starts with CODE and a colon).
func checkValidate(raw json.RawMessage, err error) error {
	var outcome struct {
		Value json.RawMessage `json:"value"`
		Error string          `json:"error"`
	}
	if e := json.Unmarshal(raw, &outcome); e != nil {
		return e
	}
	if outcome.Error != "" {
		if err == nil || !strings.HasPrefix(err.Error(), outcome.Error+":") {
			return fmt.Errorf("got %w, want %s", err, outcome.Error)
		}
		return nil
	}
	if string(outcome.Value) != `{"bool":true}` {
		return fmt.Errorf("ir.validate expects {bool true} or an error, got %s", outcome.Value)
	}
	if err != nil {
		return fmt.Errorf("unexpected error %w", err)
	}
	return nil
}

// checkAnswer runs the chain of an ir.answer step with fn and compares its result with the value of the expect of database.
// The result is normalized as a JSON value, an orm error becomes {"error": CODE}, and any other error fails the step.
func checkAnswer(t *testing.T, s step, database string, fn IRAnswer) error {
	if fn == nil {
		return fmt.Errorf("ir.answer needs the WithIRAnswer option of the test")
	}
	raw, ok := s.Expect[database]
	if !ok {
		return fmt.Errorf("ir.answer has no expect for %s", database)
	}
	var outcome struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &outcome); err != nil {
		return err
	}
	if outcome.Value == nil {
		return fmt.Errorf("ir.answer expect for %s has no value", database)
	}
	var want any
	if err := json.Unmarshal(outcome.Value, &want); err != nil {
		return err
	}
	got, err := fn(t, s.Chain, s.Answer, s.Answers)
	if err != nil {
		code := orm.ErrorCode(err)
		if code == "" {
			return fmt.Errorf("chain %s failed without an orm code: %w", s.Chain, err)
		}
		got = map[string]any{"error": code}
	}
	body, err := json.Marshal(got)
	if err != nil {
		return fmt.Errorf("chain %s result %#v: %w", s.Chain, got, err)
	}
	var actual any
	if err := json.Unmarshal(body, &actual); err != nil {
		return err
	}
	if !reflect.DeepEqual(actual, want) {
		return fmt.Errorf("chain %s: got %s, want %s", s.Chain, body, outcome.Value)
	}
	return nil
}
