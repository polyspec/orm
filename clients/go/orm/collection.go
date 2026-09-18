package orm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/polyspec/orm/engine/plan"
)

// Key is a collection key. The integer 7 and the text "7" are different keys.
type Key struct {
	i     int64
	s     string
	isStr bool
}

// KeyOf converts a column value to a key.
func KeyOf(v any) Key {
	switch x := v.(type) {
	case Key:
		return x
	case int64:
		return Key{i: x}
	case int:
		return Key{i: int64(x)}
	case int32:
		return Key{i: int64(x)}
	case uint64:
		return Key{i: int64(x)}
	case uint32:
		return Key{i: int64(x)}
	case string:
		return Key{s: x, isStr: true}
	case []byte:
		return Key{s: string(x), isStr: true}
	case bool:
		if x {
			return Key{i: 1}
		}
		return Key{i: 0}
	}
	return Key{s: scalarKey(v), isStr: true}
}

// keyFromRow builds a key from ordered result columns; false when a
// component is null. Composite keys encode each component with its length.
func keyFromRow(row []any, refs []plan.KeyRef) (Key, bool) {
	values := make([]any, len(refs))
	for i, ref := range refs {
		values[i] = row[ref.Index]
		if values[i] == nil {
			return Key{}, false
		}
	}
	return keyFromValues(values), true
}

func keyFromValues(values []any) Key {
	if len(values) == 1 {
		return KeyOf(values[0])
	}
	var b strings.Builder
	for _, value := range values {
		part := scalarKey(value)
		b.WriteString(strconv.Itoa(len(part)))
		b.WriteByte(':')
		b.WriteString(part)
	}
	return Key{s: b.String(), isStr: true}
}

// String renders the key.
func (k Key) String() string {
	if k.isStr {
		return k.s
	}
	return strconv.FormatInt(k.i, 10)
}

// Value returns the key as int64 or string.
func (k Key) Value() any {
	if k.isStr {
		return k.s
	}
	return k.i
}

// SameScalar compares a row value with a parameter regardless of the numeric
// or boolean representation.
func SameScalar(a, b any) bool { return scalarKey(a) == scalarKey(b) }

func scalarKey(v any) string {
	switch x := v.(type) {
	case nil:
		return "\x00"
	case bool:
		if x {
			return "1"
		}
		return "0"
	case []byte:
		return string(x)
	case string:
		return x
	case time.Time:
		return x.Format("2006-01-02 15:04:05.000000")
	}
	return fmt.Sprint(v)
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
func (c *Collection[T]) Get(key any) T { return c.items[KeyOf(key)] }

// Has reports whether the key exists.
func (c *Collection[T]) Has(key any) bool {
	_, ok := c.items[KeyOf(key)]
	return ok
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
func (c *Collection[T]) FetchedValue(key any) any { return c.fetched[KeyOf(key)] }

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

// AsInt64 converts a database value to int64.
func AsInt64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int32:
		return int64(x)
	case int:
		return int64(x)
	case uint64:
		return int64(x)
	case float64:
		return int64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		if err != nil {
			f, _ := strconv.ParseFloat(strings.TrimSpace(x), 64)
			return int64(f)
		}
		return n
	}
	return 0
}

// AsFloat64 converts a database value to float64.
func AsFloat64(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int64:
		return float64(x)
	case int32:
		return float64(x)
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f
	}
	return 0
}

// AsString converts a database value to string.
func AsString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	case nil:
		return ""
	case time.Time:
		return x.Format("2006-01-02 15:04:05.000000")
	}
	return fmt.Sprint(v)
}

// AsBytes converts a database value to an owned byte slice.
func AsBytes(v any) []byte {
	switch x := v.(type) {
	case []byte:
		return append([]byte(nil), x...)
	case string:
		return []byte(x)
	case nil:
		return nil
	}
	return []byte(fmt.Sprint(v))
}

// AsBool converts a database value to bool.
func AsBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	case string:
		return x == "1" || x == "true" || x == "t"
	}
	return false
}

// AsTime converts a database value to time.Time.
func AsTime(v any) time.Time {
	switch x := v.(type) {
	case time.Time:
		return x
	case string:
		for _, layout := range []string{"2006-01-02 15:04:05.999999", "2006-01-02 15:04:05", "2006-01-02 15:04:05.999999-07:00", "2006-01-02 15:04:05-07:00", time.RFC3339Nano, "2006-01-02", "15:04:05.999999"} {
			if t, err := time.Parse(layout, x); err == nil {
				return t
			}
		}
	}
	return time.Time{}
}
