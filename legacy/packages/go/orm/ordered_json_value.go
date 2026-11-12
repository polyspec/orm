package orm

import (
	"encoding/json"
	"encoding/json/jsontext"
	"errors"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	orderedjson "github.com/polyspec/ordered-json/packages/go"
)

// orderedJSONValue converts the portable ORM value model to ordered-json.
// JSON columns accept the explicit ordered-json value or the documented
// scalar/list/map model; driver byte slices are never interpreted as JSON.
// A value that the stage refuses is the error of its rule of COD-70, met in the order of the nodes; a struct field
// is refused by the rule of its value, which names no field (COD-71).
func orderedJSONValue(value any) (*orderedjson.Value, error) {
	return orderedJSONReflect(reflect.ValueOf(value), 0)
}

var jsonTextValueType = reflect.TypeOf(jsontext.Value(nil))
var jsonRawMessageType = reflect.TypeOf(json.RawMessage(nil))

// errJSONDepth is the refusal of a value nested deeper than the levels that the ordered-json parser reads (json-depth).
func errJSONDepth() error {
	return codecErr(CodeCodecEncode, "json: value nesting exceeds %d levels", orderedjson.MaxDepth)
}

// errJSONText is the refusal of a value whose text the ordered-json library does not write (json-text), with its failure.
func errJSONText(err error) error {
	return codecCause(CodeCodecEncode, "json: the value has no JSON text", err)
}

// orderedDepth is the nesting of an ordered-json value, read from its compact text, whose repeated member names its member
// map would collapse: 0 for a scalar, and one more than its deepest item or member for an array or an object.
func orderedDepth(value *orderedjson.Value) (int, error) {
	text, err := value.Compact()
	if err != nil {
		return 0, errJSONText(err)
	}
	depth, deepest := 0, 0
	inString, escaped := false, false
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case inString && escaped:
			escaped = false
		case inString && c == '\\':
			escaped = true
		case inString && c == '"':
			inString = false
		case inString:
		case c == '"':
			inString = true
		case c == '[' || c == '{':
			depth++
			deepest = max(deepest, depth)
		case c == ']' || c == '}':
			depth--
		}
	}
	return deepest, nil
}

// orderedParsed is a JSON text that a Go value gives as ordered-json, at depth levels inside the value. The parser reads the
// levels left below the limit, so a text nested past it is json-depth, as every other value nested past it is, and any other
// failure of the parser is json-text (COD-70).
func orderedParsed(body []byte, depth int) (*orderedjson.Value, error) {
	if depth >= orderedjson.MaxDepth {
		return nil, errJSONDepth()
	}
	parsed, err := orderedjson.ParseWithMaxDepth(string(body), orderedjson.MaxDepth-depth)
	if err != nil {
		var parseErr orderedjson.Error
		if errors.As(err, &parseErr) && parseErr.Kind() == orderedjson.MaximumDepthExceededError {
			return nil, errJSONDepth()
		}
		return nil, errJSONText(err)
	}
	return orderedChecked(parsed, depth)
}

// orderedChecked is an ordered-json value at depth levels inside the value, refused when its nesting passes the limit.
func orderedChecked(value *orderedjson.Value, depth int) (*orderedjson.Value, error) {
	nesting, err := orderedDepth(value)
	if err != nil {
		return nil, err
	}
	if depth+nesting > orderedjson.MaxDepth {
		return nil, errJSONDepth()
	}
	return value, nil
}

// orderedText is the ordered-json string of a Go string (text-unicode).
func orderedText(text string) (*orderedjson.Value, error) {
	if !utf8.ValidString(text) {
		return nil, codecErr(CodeCodecEncode, "json: the text is not a sequence of Unicode scalar values")
	}
	value, err := orderedjson.String(text)
	if err != nil {
		return nil, errJSONText(err)
	}
	return value, nil
}

// orderedNumber is the ordered-json number of a literal that strconv wrote.
func orderedNumber(literal string) (*orderedjson.Value, error) {
	value, err := orderedjson.Number(literal)
	if err != nil {
		return nil, errJSONText(err)
	}
	return value, nil
}

// orderedArray is the ordered-json array of items.
func orderedArray(items []*orderedjson.Value) (*orderedjson.Value, error) {
	value, err := orderedjson.Array(items)
	if err != nil {
		return nil, errJSONText(err)
	}
	return value, nil
}

// orderedObject is the ordered-json object of members.
func orderedObject(members *orderedjson.OrderedMap) (*orderedjson.Value, error) {
	value, err := orderedjson.Object(members)
	if err != nil {
		return nil, errJSONText(err)
	}
	return value, nil
}

// orderedMember sets the member name of members to value.
func orderedMember(members *orderedjson.OrderedMap, name string, value *orderedjson.Value) error {
	key, err := orderedText(name)
	if err != nil {
		return err
	}
	if err := members.Set(key, value); err != nil {
		return errJSONText(err)
	}
	return nil
}

// orderedJSONReflect converts a Go value at depth levels inside the value: a container there is at level depth+1.
func orderedJSONReflect(reflectValue reflect.Value, depth int) (*orderedjson.Value, error) {
	if !reflectValue.IsValid() {
		return orderedjson.Null(), nil
	}
	// A JSON text value and a raw message are their bytes, which are one JSON text.
	if reflectValue.Type() == jsonTextValueType || reflectValue.Type() == jsonRawMessageType {
		if reflectValue.IsNil() {
			return orderedjson.Null(), nil
		}
		return orderedParsed(reflectValue.Bytes(), depth)
	}
	// A nil pointer or interface encodes as null without invoking a marshaler;
	// encoding/json keeps the same contract and a value-receiver marshaler such
	// as time.Time.MarshalJSON panics on a nil pointer.
	if (reflectValue.Kind() == reflect.Interface || reflectValue.Kind() == reflect.Pointer) && reflectValue.IsNil() {
		return orderedjson.Null(), nil
	}
	// An ordered-json value is taken as it is before the json.Marshaler check: its MarshalJSON
	// re-serialises the parsed member map, which collapses a repeated member name (DIA-26).
	if reflectValue.CanInterface() {
		if value, ok := reflectValue.Interface().(*orderedjson.Value); ok {
			return orderedChecked(value, depth)
		}
		if marshaler, ok := reflectValue.Interface().(json.Marshaler); ok {
			body, err := marshaler.MarshalJSON()
			if err != nil {
				return nil, errJSONText(err)
			}
			return orderedParsed(body, depth)
		}
	}
	if reflectValue.Kind() == reflect.Interface || reflectValue.Kind() == reflect.Pointer {
		return orderedJSONReflect(reflectValue.Elem(), depth)
	}
	return orderedJSONKind(reflectValue, depth)
}

func orderedJSONKind(reflectValue reflect.Value, depth int) (*orderedjson.Value, error) {
	switch reflectValue.Kind() {
	case reflect.Bool:
		return orderedjson.Boolean(reflectValue.Bool()), nil
	case reflect.String:
		return orderedText(reflectValue.String())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return orderedNumber(strconv.FormatInt(reflectValue.Int(), 10))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return orderedNumber(strconv.FormatUint(reflectValue.Uint(), 10))
	case reflect.Float32, reflect.Float64:
		return orderedJSONFloat(reflectValue.Float())
	case reflect.Slice:
		// Bytes are no JSON value (COD-63).
		if reflectValue.Type().Elem().Kind() == reflect.Uint8 {
			return nil, errJSONValue()
		}
		if reflectValue.IsNil() {
			return orderedjson.Null(), nil
		}
		return orderedJSONItems(reflectValue, depth)
	case reflect.Array:
		return orderedJSONItems(reflectValue, depth)
	case reflect.Map:
		if reflectValue.IsNil() {
			return orderedjson.Null(), nil
		}
		return orderedJSONMap(reflectValue, depth)
	case reflect.Struct:
		return orderedJSONStruct(reflectValue, depth)
	}
	// A function, a channel, a complex number and an unsafe pointer have no JSON form.
	return nil, errJSONValue()
}

// errJSONValue is the refusal of a value outside the JSON value model (json-value).
func errJSONValue() error {
	return codecErr(CodeCodecEncode, "json: the value is not a JSON value")
}

func orderedJSONItems(value reflect.Value, depth int) (*orderedjson.Value, error) {
	if depth+1 > orderedjson.MaxDepth {
		return nil, errJSONDepth()
	}
	items := make([]*orderedjson.Value, value.Len())
	for i := range items {
		converted, err := orderedJSONReflect(value.Index(i), depth+1)
		if err != nil {
			return nil, err
		}
		items[i] = converted
	}
	return orderedArray(items)
}

// orderedJSONMap is the object of a map, its members in the order of their sorted keys; every key is a string (json-key).
func orderedJSONMap(value reflect.Value, depth int) (*orderedjson.Value, error) {
	keys := value.MapKeys()
	names := make([]string, len(keys))
	for i, key := range keys {
		if key.Kind() == reflect.Interface {
			key = key.Elem()
		}
		if key.Kind() != reflect.String {
			return nil, codecErr(CodeCodecEncode, "json: member keys must be strings")
		}
		names[i] = key.String()
	}
	if depth+1 > orderedjson.MaxDepth {
		return nil, errJSONDepth()
	}
	order := make([]int, len(keys))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(i, j int) bool { return names[order[i]] < names[order[j]] })
	var members orderedjson.OrderedMap
	for _, i := range order {
		if !utf8.ValidString(names[i]) {
			return nil, codecErr(CodeCodecEncode, "json: the text is not a sequence of Unicode scalar values")
		}
		converted, err := orderedJSONReflect(value.MapIndex(keys[i]), depth+1)
		if err != nil {
			return nil, err
		}
		if err := orderedMember(&members, names[i], converted); err != nil {
			return nil, err
		}
	}
	return orderedObject(&members)
}

func orderedJSONStruct(value reflect.Value, depth int) (*orderedjson.Value, error) {
	if depth+1 > orderedjson.MaxDepth {
		return nil, errJSONDepth()
	}
	typeOfValue := value.Type()
	var members orderedjson.OrderedMap
	for i := 0; i < value.NumField(); i++ {
		field := typeOfValue.Field(i)
		if field.PkgPath != "" {
			continue
		}
		if field.Anonymous && field.Type.Kind() == reflect.Struct {
			tag, hasTag := field.Tag.Lookup("json")
			if !hasTag || strings.Split(tag, ",")[0] == "" {
				// The members of an embedded struct are members of this object, at its level.
				converted, err := orderedJSONStruct(value.Field(i), depth)
				if err != nil {
					return nil, err
				}
				embedded, err := converted.Members()
				if err != nil {
					return nil, errJSONText(err)
				}
				for _, key := range embedded.Keys() {
					name, err := key.StringValue()
					if err != nil {
						return nil, errJSONText(err)
					}
					if err := members.Set(key, embedded.Get(name)); err != nil {
						return nil, errJSONText(err)
					}
				}
				continue
			}
		}
		name, omitEmpty, skip := orderedJSONFieldName(field)
		if skip || (omitEmpty && orderedJSONEmpty(value.Field(i))) {
			continue
		}
		converted, err := orderedJSONReflect(value.Field(i), depth+1)
		if err != nil {
			return nil, err
		}
		if err := orderedMember(&members, name, converted); err != nil {
			return nil, err
		}
	}
	return orderedObject(&members)
}

func orderedJSONFieldName(field reflect.StructField) (string, bool, bool) {
	tag, ok := field.Tag.Lookup("json")
	if !ok {
		return field.Name, false, false
	}
	parts := strings.Split(tag, ",")
	if parts[0] == "-" {
		return "", false, true
	}
	name := field.Name
	if parts[0] != "" {
		name = parts[0]
	}
	omitEmpty := false
	for _, option := range parts[1:] {
		omitEmpty = omitEmpty || option == "omitempty"
	}
	return name, omitEmpty, false
}

func orderedJSONEmpty(value reflect.Value) bool {
	if !value.IsValid() {
		return true
	}
	switch value.Kind() {
	case reflect.Array, reflect.Map, reflect.Slice, reflect.String:
		return value.Len() == 0
	case reflect.Bool:
		return !value.Bool()
	case reflect.Interface, reflect.Pointer:
		return value.IsNil()
	}
	return false
}

func orderedJSONFloat(value float64) (*orderedjson.Value, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, codecErr(CodeCodecEncode, "json: non-finite number")
	}
	return orderedNumber(strconv.FormatFloat(value, 'g', -1, 64))
}

// compactJSONText removes the insignificant whitespace of a JSON text and keeps
// every other byte in place, so member order and repeated member names survive
// (DIA-26). Whitespace inside a string literal is significant and is kept.
func compactJSONText(text string) string {
	var out strings.Builder
	out.Grow(len(text))
	inString := false
	escaped := false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if inString {
			out.WriteByte(c)
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		case '"':
			inString = true
		}
		out.WriteByte(c)
	}
	return out.String()
}

// orderedJSONCompact is the stored text of an ordered-json value. A parsed
// value keeps its source text, which holds the repeated member names that its
// map form would collapse, so the text is compacted from the source; a value
// with no source text is compacted from its tree.
func orderedJSONCompact(value *orderedjson.Value) (string, error) {
	if raw := value.Raw(); raw != "" {
		return compactJSONText(raw), nil
	}
	return value.Compact()
}
