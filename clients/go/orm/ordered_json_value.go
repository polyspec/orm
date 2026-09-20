package orm

import (
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"

	orderedjson "github.com/polyspec/ordered-json/go"
)

// orderedJSONValue converts the portable ORM value model to ordered-json.
// JSON columns accept the explicit ordered-json value or the documented
// scalar/list/map model; driver byte slices are never interpreted as JSON.
func orderedJSONValue(value any) (*orderedjson.Value, error) {
	return orderedJSONReflect(reflect.ValueOf(value))
}

var jsonTextValueType = reflect.TypeOf(jsontext.Value(nil))
var jsonRawMessageType = reflect.TypeOf(json.RawMessage(nil))

func orderedJSONReflect(reflectValue reflect.Value) (*orderedjson.Value, error) {
	if !reflectValue.IsValid() {
		return orderedjson.Null(), nil
	}
	if reflectValue.Type() == jsonTextValueType {
		if reflectValue.IsNil() {
			return orderedjson.Null(), nil
		}
		parsed, err := orderedjson.ParseBytes(reflectValue.Bytes())
		if err != nil {
			return nil, codecErr(CodeCodecEncode, "json: raw value: %v", err)
		}
		return parsed, nil
	}
	if reflectValue.Type() == jsonRawMessageType {
		if reflectValue.IsNil() {
			return orderedjson.Null(), nil
		}
		parsed, err := orderedjson.ParseBytes(reflectValue.Bytes())
		if err != nil {
			return nil, codecErr(CodeCodecEncode, "json: raw message: %v", err)
		}
		return parsed, nil
	}
	// A nil pointer or interface encodes as null without invoking a marshaler;
	// encoding/json keeps the same contract and a value-receiver marshaler such
	// as time.Time.MarshalJSON panics on a nil pointer.
	if (reflectValue.Kind() == reflect.Interface || reflectValue.Kind() == reflect.Pointer) && reflectValue.IsNil() {
		return orderedjson.Null(), nil
	}
	if reflectValue.CanInterface() {
		if marshaler, ok := reflectValue.Interface().(json.Marshaler); ok {
			body, err := marshaler.MarshalJSON()
			if err != nil {
				return nil, codecErr(CodeCodecEncode, "json: custom marshaler: %v", err)
			}
			parsed, err := orderedjson.ParseBytes(body)
			if err != nil {
				return nil, codecErr(CodeCodecEncode, "json: custom marshaler returned invalid JSON: %v", err)
			}
			return parsed, nil
		}
	}
	if reflectValue.CanInterface() {
		if value, ok := reflectValue.Interface().(*orderedjson.Value); ok {
			if value == nil {
				return orderedjson.Null(), nil
			}
			return value, nil
		}
	}
	if reflectValue.Kind() == reflect.Interface || reflectValue.Kind() == reflect.Pointer {
		return orderedJSONReflect(reflectValue.Elem())
	}
	return orderedJSONKind(reflectValue)
}

func orderedJSONKind(reflectValue reflect.Value) (*orderedjson.Value, error) {
	switch reflectValue.Kind() {
	case reflect.Bool:
		return orderedjson.Boolean(reflectValue.Bool()), nil
	case reflect.String:
		return orderedjson.String(reflectValue.String())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return orderedjson.Number(strconv.FormatInt(reflectValue.Int(), 10))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return orderedjson.Number(strconv.FormatUint(reflectValue.Uint(), 10))
	case reflect.Float32, reflect.Float64:
		return orderedJSONFloat(reflectValue.Float())
	}
	value := reflectValue.Interface()
	switch v := value.(type) {
	case nil:
		return orderedjson.Null(), nil
	case bool:
		return orderedjson.Boolean(v), nil
	case string:
		return orderedjson.String(v)
	case int:
		return orderedjson.Number(strconv.FormatInt(int64(v), 10))
	case int8:
		return orderedjson.Number(strconv.FormatInt(int64(v), 10))
	case int16:
		return orderedjson.Number(strconv.FormatInt(int64(v), 10))
	case int32:
		return orderedjson.Number(strconv.FormatInt(int64(v), 10))
	case int64:
		return orderedjson.Number(strconv.FormatInt(v, 10))
	case uint:
		return orderedjson.Number(strconv.FormatUint(uint64(v), 10))
	case uint8:
		return orderedjson.Number(strconv.FormatUint(uint64(v), 10))
	case uint16:
		return orderedjson.Number(strconv.FormatUint(uint64(v), 10))
	case uint32:
		return orderedjson.Number(strconv.FormatUint(uint64(v), 10))
	case uint64:
		return orderedjson.Number(strconv.FormatUint(v, 10))
	case float32:
		return orderedJSONFloat(float64(v))
	case float64:
		return orderedJSONFloat(v)
	case []byte:
		return nil, codecErr(CodeCodecEncode, "json: []byte is not a common JSON value")
	case []any:
		items := make([]*orderedjson.Value, len(v))
		for i, item := range v {
			converted, err := orderedJSONValue(item)
			if err != nil {
				return nil, err
			}
			items[i] = converted
		}
		return orderedjson.Array(items)
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var members orderedjson.OrderedMap
		for _, key := range keys {
			converted, err := orderedJSONValue(v[key])
			if err != nil {
				return nil, err
			}
			name, err := orderedjson.String(key)
			if err != nil {
				return nil, err
			}
			if err := members.Set(name, converted); err != nil {
				return nil, err
			}
		}
		return orderedjson.Object(&members)
	default:
		return orderedJSONReflectByKind(reflectValue)
	}
}

func orderedJSONReflectByKind(value reflect.Value) (*orderedjson.Value, error) {
	switch value.Kind() {
	case reflect.Array, reflect.Slice:
		if value.Kind() == reflect.Slice && value.IsNil() {
			return orderedjson.Null(), nil
		}
		items := make([]*orderedjson.Value, value.Len())
		for i := range items {
			converted, err := orderedJSONReflect(value.Index(i))
			if err != nil {
				return nil, err
			}
			items[i] = converted
		}
		return orderedjson.Array(items)
	case reflect.Map:
		if value.IsNil() {
			return orderedjson.Null(), nil
		}
		if value.Type().Key().Kind() != reflect.String {
			return nil, fmt.Errorf("%s: JSON map keys must be strings, got %s", CodeCodecEncode, value.Type().Key())
		}
		keys := value.MapKeys()
		sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
		var members orderedjson.OrderedMap
		for _, key := range keys {
			converted, err := orderedJSONReflect(value.MapIndex(key))
			if err != nil {
				return nil, err
			}
			name, err := orderedjson.String(key.String())
			if err != nil {
				return nil, err
			}
			if err := members.Set(name, converted); err != nil {
				return nil, err
			}
		}
		return orderedjson.Object(&members)
	case reflect.Struct:
		return orderedJSONStruct(value)
	default:
		return nil, fmt.Errorf("%s: unsupported Go value %s", CodeCodecEncode, value.Type())
	}
}

func orderedJSONStruct(value reflect.Value) (*orderedjson.Value, error) {
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
				converted, err := orderedJSONReflect(value.Field(i))
				if err != nil {
					return nil, fmt.Errorf("%s embedded field %s: %w", CodeCodecEncode, field.Name, err)
				}
				embedded, err := converted.Members()
				if err != nil {
					return nil, fmt.Errorf("%s embedded field %s: %w", CodeCodecEncode, field.Name, err)
				}
				for _, key := range embedded.Keys() {
					name, err := key.StringValue()
					if err != nil {
						return nil, err
					}
					if err := members.Set(key, embedded.Get(name)); err != nil {
						return nil, err
					}
				}
				continue
			}
		}
		name, omitEmpty, skip := orderedJSONFieldName(field)
		if skip || (omitEmpty && orderedJSONEmpty(value.Field(i))) {
			continue
		}
		converted, err := orderedJSONReflect(value.Field(i))
		if err != nil {
			return nil, fmt.Errorf("%s field %s: %w", CodeCodecEncode, field.Name, err)
		}
		key, err := orderedjson.String(name)
		if err != nil {
			return nil, err
		}
		if err := members.Set(key, converted); err != nil {
			return nil, err
		}
	}
	return orderedjson.Object(&members)
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
	return orderedjson.Number(strconv.FormatFloat(value, 'g', -1, 64))
}
