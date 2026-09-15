package orm

import (
	"fmt"
	"math"
	"sort"
	"strconv"

	orderedjson "github.com/polyspec/ordered-json/go"
)

// orderedJSONValue converts the portable ORM value model to ordered-json.
// JSON columns accept the explicit ordered-json value or the documented
// scalar/list/map model; driver byte slices are never interpreted as JSON.
func orderedJSONValue(value any) (*orderedjson.Value, error) {
	switch v := value.(type) {
	case *orderedjson.Value:
		if v == nil {
			return orderedjson.Null(), nil
		}
		return v, nil
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
		return nil, fmt.Errorf("%s: unsupported Go value %T", CodeCodecEncode, value)
	}
}

func orderedJSONFloat(value float64) (*orderedjson.Value, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, codecErr(CodeCodecEncode, "json: non-finite number")
	}
	return orderedjson.Number(strconv.FormatFloat(value, 'g', -1, 64))
}
