package orm

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/polyspec/orm/engine/plan"
)

// Key is a collection key. The integer 7 and the text "7" are different keys.
type Key struct {
	tag  byte
	data string
	i    int64
	bits uint64
	time time.Time
}

// KeyOf converts a column value to a key.
func KeyOf(v any) (Key, error) {
	switch x := v.(type) {
	case Key:
		if x.tag != 0 {
			return x, nil
		}
	case int64:
		return integerKey(x), nil
	case int:
		return integerKey(int64(x)), nil
	case int32:
		return integerKey(int64(x)), nil
	case int16:
		return integerKey(int64(x)), nil
	case int8:
		return integerKey(int64(x)), nil
	case uint64:
		if x <= math.MaxInt64 {
			return integerKey(int64(x)), nil
		}
	case uint32:
		return integerKey(int64(x)), nil
	case uint16:
		return integerKey(int64(x)), nil
	case uint8:
		return integerKey(int64(x)), nil
	case uint:
		if uint64(x) <= math.MaxInt64 {
			return integerKey(int64(x)), nil
		}
	case string:
		return Key{tag: 's', data: x}, nil
	case []byte:
		if x == nil {
			break
		}
		return Key{tag: 'b', data: string(x)}, nil
	case bool:
		if x {
			return Key{tag: 't', data: "1"}, nil
		}
		return Key{tag: 't', data: "0"}, nil
	case float64:
		if !math.IsNaN(x) && !math.IsInf(x, 0) {
			if x == 0 {
				x = 0
			}
			bits := math.Float64bits(x)
			return Key{tag: 'f', data: strconv.FormatUint(bits, 16), bits: bits}, nil
		}
	case float32:
		if !math.IsNaN(float64(x)) && !math.IsInf(float64(x), 0) {
			if x == 0 {
				x = 0
			}
			bits := math.Float64bits(float64(x))
			return Key{tag: 'f', data: strconv.FormatUint(bits, 16), bits: bits}, nil
		}
	case time.Time:
		value := x.UTC()
		return Key{tag: 'd', data: value.Format(time.RFC3339Nano), time: value}, nil
	}
	return Key{}, codecErr(CodeCodecDecode, "unsupported key value %T", v)
}

func integerKey(value int64) Key {
	return Key{tag: 'i', data: strconv.FormatInt(value, 10), i: value}
}

// keyFromRow builds a key from ordered result columns; false when a
// component is null. Composite keys encode each component with its length.
func keyFromRow(row []any, refs []plan.KeyRef) (Key, bool, error) {
	if len(refs) == 0 {
		return Key{}, false, codecErr(CodeInternal, "row identity has no components")
	}
	values := make([]any, len(refs))
	for i, ref := range refs {
		if ref.Index < 0 || ref.Index >= len(row) {
			return Key{}, false, codecErr(CodeInternal, "row identity index %d is out of bounds", ref.Index)
		}
		values[i] = row[ref.Index]
		if values[i] == nil {
			return Key{}, false, nil
		}
	}
	key, err := keyFromValues(values)
	return key, err == nil, err
}

func keyFromValues(values []any) (Key, error) {
	if len(values) == 0 {
		return Key{}, codecErr(CodeInternal, "composite key has no components")
	}
	if len(values) == 1 {
		return KeyOf(values[0])
	}
	var b strings.Builder
	for _, value := range values {
		part, err := KeyOf(value)
		if err != nil {
			return Key{}, err
		}
		b.WriteByte(part.tag)
		b.WriteString(strconv.Itoa(len(part.data)))
		b.WriteByte(':')
		b.WriteString(part.data)
	}
	return Key{tag: 'c', data: b.String()}, nil
}

// String renders the key.
func (k Key) String() string {
	return k.data
}

// Value returns the key's scalar value or encoded composite identity.
func (k Key) Value() (any, error) {
	switch k.tag {
	case 'i':
		return k.i, nil
	case 't':
		return k.data == "1", nil
	case 'b':
		return []byte(k.data), nil
	case 'f':
		return math.Float64frombits(k.bits), nil
	case 'd':
		return k.time, nil
	case 's', 'c':
		return k.data, nil
	}
	return nil, codecErr(CodeCodecDecode, "invalid collection key")
}

// SameScalar compares supported scalar values without dropping their types.
func SameScalar(a, b any) (bool, error) {
	var left, right Key
	if a != nil {
		var err error
		left, err = KeyOf(a)
		if err != nil {
			return false, err
		}
	}
	if b != nil {
		var err error
		right, err = KeyOf(b)
		if err != nil {
			return false, err
		}
	}
	return a == nil && b == nil || a != nil && b != nil && left == right, nil
}

// Collection is an ordered set of models keyed by primary key, key column, or
// key callback. A later row with the same key replaces the earlier one.
type Collection[T Model] struct {
	keys    []Key
	items   map[Key]T
	fetched map[Key]any
	conn    *DB
}

// NewCollection returns an empty collection.
func NewCollection[T Model]() *Collection[T] {
	return &Collection[T]{items: map[Key]T{}}
}

func (c *Collection[T]) put(k Key, v T) {
	if _, ok := c.items[k]; !ok {
		c.keys = append(c.keys, k)
	}
	c.items[k] = v
}

// Len returns the number of models.
func (c *Collection[T]) Len() int { return len(c.keys) }

// Get returns the model with the key, or the zero value.
func (c *Collection[T]) Get(key any) (T, error) {
	k, err := KeyOf(key)
	if err != nil {
		var zero T
		return zero, err
	}
	return c.items[k], nil
}

// Has reports whether the key exists.
func (c *Collection[T]) Has(key any) (bool, error) {
	k, err := KeyOf(key)
	if err != nil {
		return false, err
	}
	_, ok := c.items[k]
	return ok, nil
}

// First returns the first model, or the zero value.
func (c *Collection[T]) First() T {
	var zero T
	if len(c.keys) == 0 {
		return zero
	}
	return c.items[c.keys[0]]
}

// Keys returns the keys in order.
func (c *Collection[T]) Keys() []Key { return append([]Key(nil), c.keys...) }

// All iterates keys and models in order.
func (c *Collection[T]) All() func(yield func(Key, T) bool) {
	return func(yield func(Key, T) bool) {
		for _, k := range c.keys {
			if !yield(k, c.items[k]) {
				return
			}
		}
	}
}

// Slice returns the models in order.
func (c *Collection[T]) Slice() []T {
	out := make([]T, 0, len(c.keys))
	for _, k := range c.keys {
		out = append(out, c.items[k])
	}
	return out
}

// FetchedValue returns the fetchValue callback result of the key.
func (c *Collection[T]) FetchedValue(key any) (any, error) {
	k, err := KeyOf(key)
	if err != nil {
		return nil, err
	}
	return c.fetched[k], nil
}

// FetchedValues returns the fetchValue callback results in order.
func (c *Collection[T]) FetchedValues() []any {
	out := make([]any, 0, len(c.keys))
	for _, k := range c.keys {
		out = append(out, c.fetched[k])
	}
	return out
}

// Connect sets the connection of every model in the collection.
func (c *Collection[T]) Connect(db *DB) *Collection[T] {
	c.conn = db
	for _, k := range c.keys {
		c.items[k].Orm_().Connect(db)
	}
	return c
}

// Delete deletes every model of the collection in one transaction.
// Delete(true) deletes loaded relation rows first.
func (c *Collection[T]) Delete(recursive ...bool) error {
	if len(c.keys) == 0 {
		return nil
	}
	first := c.items[c.keys[0]].Orm_()
	return inTransaction(first.conn, func() error {
		for _, k := range c.keys {
			if err := c.items[k].Orm_().delete(recursive); err != nil {
				return err
			}
		}
		return nil
	})
}

// ToArray converts the collection to key-ordered maps.
func (c *Collection[T]) ToArray() []map[string]any {
	out := make([]map[string]any, 0, len(c.keys))
	for _, k := range c.keys {
		out = append(out, c.items[k].Orm_().ToArray())
	}
	return out
}

// MarshalJSON writes the models as a JSON array in order.
func (c *Collection[T]) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('[')
	for i, k := range c.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		b, err := json.Marshal(c.items[k].Orm_())
		if err != nil {
			return nil, err
		}
		buf.Write(b)
	}
	buf.WriteByte(']')
	return buf.Bytes(), nil
}

// Page is one page of a collection.
type Page[T Model] struct {
	Items      *Collection[T]
	TotalCount int64
	TotalPages int64
	Page       int
	PerPage    int
}

// ErrNullColumn reports SQL NULL in a non-null generated model field.
var ErrNullColumn = codecErr(CodeCodecDecode, "non-null column received SQL NULL")

// AsInt64 converts a database value to int64 without discarding a fraction or overflow.
func AsInt64(v any) (int64, error) {
	switch x := v.(type) {
	case int64:
		return x, nil
	case int32:
		return int64(x), nil
	case int:
		return int64(x), nil
	case uint64:
		if x <= math.MaxInt64 {
			return int64(x), nil
		}
	case float64:
		if !math.IsNaN(x) && !math.IsInf(x, 0) && math.Trunc(x) == x && x >= -0x1p63 && x < 0x1p63 {
			return int64(x), nil
		}
	case bool:
		if x {
			return 1, nil
		}
		return 0, nil
	case string:
		if n, err := strconv.ParseInt(x, 10, 64); err == nil {
			return n, nil
		}
	case []byte:
		if n, err := strconv.ParseInt(string(x), 10, 64); err == nil {
			return n, nil
		}
	}
	return 0, codecErr(CodeCodecDecode, "cannot convert %T value %v to int64", v, v)
}

// AsInt32 converts a database value to int32 without overflow.
func AsInt32(v any) (int32, error) {
	n, err := AsInt64(v)
	if err != nil {
		return 0, err
	}
	if n < math.MinInt32 || n > math.MaxInt32 {
		return 0, codecErr(CodeCodecDecode, "integer %d overflows int32", n)
	}
	return int32(n), nil
}

// AsInt16은 database 값을 넘침 없이 int16으로 바꾼다.
func AsInt16(v any) (int16, error) {
	n, err := AsInt64(v)
	if err != nil {
		return 0, err
	}
	if n < math.MinInt16 || n > math.MaxInt16 {
		return 0, codecErr(CodeCodecDecode, "integer %d overflows int16", n)
	}
	return int16(n), nil
}

// AsTimeText는 time(p) 값을 소수 자릿수가 정확히 p인 HH:MM:SS text로 바꾼다.
// 시각은 00:00:00 이상 24:00:00 미만이며, p보다 긴 소수는 값을 잃으므로
// CODEC_DECODE다.
func AsTimeText(v any, precision int) (string, error) {
	var s string
	switch x := v.(type) {
	case string:
		s = x
	case []byte:
		s = string(x)
	case time.Time:
		s = x.Format("15:04:05.999999999")
	default:
		return "", codecErr(CodeCodecDecode, "cannot convert %T to time", v)
	}
	clock, fraction, hasFraction := strings.Cut(s, ".")
	if len(clock) != 8 || clock[2] != ':' || clock[5] != ':' || hasFraction && fraction == "" {
		return "", codecErr(CodeCodecDecode, "time %q is not HH:MM:SS with an optional fraction", s)
	}
	for i, c := range clock {
		if i != 2 && i != 5 && (c < '0' || c > '9') {
			return "", codecErr(CodeCodecDecode, "time %q is not HH:MM:SS with an optional fraction", s)
		}
	}
	if clock[0:2] > "23" || clock[3:5] > "59" || clock[6:8] > "59" {
		return "", codecErr(CodeCodecDecode, "time %q is out of range", s)
	}
	for _, c := range fraction {
		if c < '0' || c > '9' {
			return "", codecErr(CodeCodecDecode, "time %q has a non-digit fraction", s)
		}
	}
	trimmed := strings.TrimRight(fraction, "0")
	if len(trimmed) > precision {
		return "", codecErr(CodeCodecDecode, "time %q has more than %d fraction digits", s, precision)
	}
	if precision == 0 {
		return clock, nil
	}
	return clock + "." + trimmed + strings.Repeat("0", precision-len(trimmed)), nil
}

// AsFloat64 converts a database value to float64.
func AsFloat64(v any) (float64, error) {
	var f float64
	switch x := v.(type) {
	case float64:
		f = x
	case float32:
		f = float64(x)
	case int64:
		f = float64(x)
	case int32:
		f = float64(x)
	case int:
		f = float64(x)
	case uint64:
		f = float64(x)
	case string:
		var err error
		f, err = strconv.ParseFloat(x, 64)
		if err != nil {
			return 0, codecErr(CodeCodecDecode, "cannot convert %q to float64: %v", x, err)
		}
	case []byte:
		var err error
		f, err = strconv.ParseFloat(string(x), 64)
		if err != nil {
			return 0, codecErr(CodeCodecDecode, "cannot convert %q to float64: %v", x, err)
		}
	default:
		return 0, codecErr(CodeCodecDecode, "cannot convert %T to float64", v)
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, codecErr(CodeCodecDecode, "non-finite float64 value")
	}
	return f, nil
}

// AsString converts a database value to string.
func AsString(v any) (string, error) {
	var s string
	switch x := v.(type) {
	case string:
		s = x
	case []byte:
		if x == nil {
			return "", codecErr(CodeCodecDecode, "cannot convert SQL NULL to string")
		}
		s = string(x)
	default:
		return "", codecErr(CodeCodecDecode, "cannot convert %T to string", v)
	}
	if !utf8.ValidString(s) {
		return "", codecErr(CodeCodecDecode, "text is not valid UTF-8")
	}
	return s, nil
}

// AsBytes converts a database value to an owned byte slice.
func AsBytes(v any) ([]byte, error) {
	switch x := v.(type) {
	case []byte:
		if x == nil {
			return nil, codecErr(CodeCodecDecode, "cannot convert SQL NULL to bytes")
		}
		out := make([]byte, len(x))
		copy(out, x)
		return out, nil
	case string:
		return []byte(x), nil
	}
	return nil, codecErr(CodeCodecDecode, "cannot convert %T to bytes", v)
}

// AsBool converts a database value to bool.
func AsBool(v any) (bool, error) {
	switch x := v.(type) {
	case bool:
		return x, nil
	case int64:
		if x == 0 || x == 1 {
			return x == 1, nil
		}
	case int32:
		if x == 0 || x == 1 {
			return x == 1, nil
		}
	case string:
		switch x {
		case "1", "true", "t":
			return true, nil
		case "0", "false", "f":
			return false, nil
		}
	case []byte:
		return AsBool(string(x))
	}
	return false, codecErr(CodeCodecDecode, "cannot convert %T value %v to bool", v, v)
}

// AsTime converts a database value to time.Time.
func AsTime(v any) (time.Time, error) {
	switch x := v.(type) {
	case time.Time:
		return x, nil
	case string:
		for _, layout := range []string{"2006-01-02 15:04:05.999999", "2006-01-02 15:04:05", "2006-01-02 15:04:05.999999-07:00", "2006-01-02 15:04:05-07:00", time.RFC3339Nano, "2006-01-02", "15:04:05.999999"} {
			if t, err := time.Parse(layout, x); err == nil {
				return t, nil
			}
		}
	case []byte:
		return AsTime(string(x))
	}
	return time.Time{}, codecErr(CodeCodecDecode, "cannot convert %T value %v to time", v, v)
}
