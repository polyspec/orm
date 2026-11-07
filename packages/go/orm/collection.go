package orm

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/polyspec/orm/packages/go/engine/plan"
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
	if v == nil {
		return Key{}, codecErr(CodeCodecDecode, "collection row identity contains SQL NULL")
	}
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

// keyCells is the row whose key cells hold the boolean of a bool column: MySQL and SQLite return it as an integer, and a
// key keeps the declared type of its component (INT-11, PRT-35).
func keyCells(row []any, asm *plan.Assemble) ([]any, error) {
	cells := row
	copied := false
	for _, ref := range asm.Key {
		for i := range asm.Columns {
			col := &asm.Columns[i]
			if col.Index != ref.Index || col.Type != "bool" || ref.Index < 0 || ref.Index >= len(row) || row[ref.Index] == nil {
				continue
			}
			value, err := AsBool(row[ref.Index])
			if err != nil {
				return nil, err
			}
			if !copied {
				cells = append([]any(nil), row...)
				copied = true
			}
			cells[ref.Index] = value
		}
	}
	return cells, nil
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
		if part.tag == 'b' {
			encoded := make([]byte, hex.EncodedLen(len(part.data)))
			hex.Encode(encoded, []byte(part.data))
			part.data = string(encoded)
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
	// err is the first conversion error that CollectOf met; the callers that take the collection report it.
	err error
}

// failure returns the conversion error that CollectOf met, if any.
func (c *Collection[T]) failure() error { return c.err }

// NewCollection returns an empty collection.
func NewCollection[T Model]() *Collection[T] {
	return &Collection[T]{items: map[Key]T{}}
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

// cellRefusal is the CODEC_DECODE of a cell that its column type does not hold (COD-1).
func cellRefusal(columnType string) error {
	return codecErr(CodeCodecDecode, "%s", cellMessage(columnType))
}

// cellMessage is the message of a cell that its column type does not hold, one per column type in every client
// (COD-1): it names neither the host type nor the value.
func cellMessage(columnType string) string {
	switch columnType {
	case "i16", "i32", "i64":
		return columnType + " cell is not an exact integer in its range"
	case "f64":
		return "f64 cell is not a finite number"
	case "bool":
		return "bool cell is not boolean"
	case "decimal":
		return "decimal cell is not a decimal of its precision and scale"
	case "date", "datetime", "time":
		return columnType + " cell is not a " + columnType
	case "bytes":
		return "bytes cell is not bytes"
	}
	return columnType + " cell is not text"
}

// integerCell reads an integer cell in [low, high]: an integer, a float with no fraction, the exact digits of an
// integer that a text protocol sends as bytes, and, when text is true, a stored text of those exact digits. A boolean
// is no integer cell, as in every client (COD-1).
func integerCell(v any, low, high int64, text bool) (int64, bool) {
	var n int64
	switch x := v.(type) {
	case int64:
		n = x
	case int32:
		n = int64(x)
	case int:
		n = int64(x)
	case uint64:
		if x > math.MaxInt64 {
			return 0, false
		}
		n = int64(x)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || math.Trunc(x) != x || x < -0x1p63 || x >= 0x1p63 {
			return 0, false
		}
		n = int64(x)
	case []byte:
		parsed, ok := integerText(string(x))
		if !ok {
			return 0, false
		}
		n = parsed
	case string:
		parsed, ok := integerText(x)
		if !text || !ok {
			return 0, false
		}
		n = parsed
	default:
		return 0, false
	}
	return n, n >= low && n <= high
}

// integerText reads the exact digits of an integer: no sign but a minus and no leading zero.
func integerText(text string) (int64, bool) {
	if !exactIntegerPattern.MatchString(text) {
		return 0, false
	}
	n, err := strconv.ParseInt(text, 10, 64)
	return n, err == nil
}

// declaredInteger checks the cell of a declared integer column of type columnType: a stored text is refused, as
// every client refuses it (COD-1).
func declaredInteger(columnType string, v any) error {
	r := integerRanges[columnType]
	if _, ok := integerCell(v, r[0], r[1], false); !ok {
		return cellRefusal(columnType)
	}
	return nil
}

// AsInt64 converts an i64 cell, or the exact digits of one, to int64 without discarding a fraction or overflow.
func AsInt64(v any) (int64, error) {
	if n, ok := integerCell(v, math.MinInt64, math.MaxInt64, true); ok {
		return n, nil
	}
	return 0, cellRefusal("i64")
}

// AsInt32 converts an i32 cell, or the exact digits of one, to int32 without overflow.
func AsInt32(v any) (int32, error) {
	if n, ok := integerCell(v, math.MinInt32, math.MaxInt32, true); ok {
		return int32(n), nil
	}
	return 0, cellRefusal("i32")
}

// AsInt16 converts an i16 cell, or the exact digits of one, to int16 without overflow.
func AsInt16(v any) (int16, error) {
	if n, ok := integerCell(v, math.MinInt16, math.MaxInt16, true); ok {
		return int16(n), nil
	}
	return 0, cellRefusal("i16")
}

// AsTimeText converts a time(p) cell to HH:MM:SS text with exactly p fractional digits.
// The time runs from 00:00:00 up to but not including 24:00:00, and a fraction longer than p loses value, so
// it is CODEC_DECODE.
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
		return "", cellRefusal("time")
	}
	m := timeText.FindStringSubmatch(s)
	if m == nil || m[1] > "23" || m[2] > "59" || m[3] > "59" {
		return "", cellRefusal("time")
	}
	f, ok := fractionDigits(m[4], precision)
	if !ok {
		return "", cellRefusal("time")
	}
	return m[1] + ":" + m[2] + ":" + m[3] + f, nil
}

var (
	// The value forms of a stored date, time and datetime text, as every client reads them (dbspec "Runtime model").
	dateText     = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
	timeText     = regexp.MustCompile(`^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$`)
	dateTimeText = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$`)
	// decimalNumberText is the decimal text of a number that an f64 cell may hold.
	decimalNumberText = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$`)
)

// fractionDigits is the fraction of a time cut to p digits, with its point; false when a cut digit is not zero.
func fractionDigits(digits string, precision int) (string, bool) {
	all := digits
	if len(all) < precision {
		all += strings.Repeat("0", precision-len(all))
	}
	if strings.Trim(all[precision:], "0") != "" {
		return "", false
	}
	if precision == 0 {
		return "", true
	}
	return "." + all[:precision], true
}

// AsFloat64 converts an f64 cell to float64: a number, or the decimal text of one. A boolean, a non-finite number
// and any other text are no f64 cell (COD-1).
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
	case string, []byte:
		text := cellString(x)
		if !decimalNumberText.MatchString(text) {
			return 0, cellRefusal("f64")
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return 0, cellRefusal("f64")
		}
		f = parsed
	default:
		return 0, cellRefusal("f64")
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, cellRefusal("f64")
	}
	return f, nil
}

// cellString is the text of a string or bytes cell.
func cellString(v any) string {
	switch x := v.(type) {
	case []byte:
		return string(x)
	case string:
		return x
	}
	return ""
}

// AsString converts a text cell to string: a string, or bytes that are valid UTF-8 (COD-69).
func AsString(v any) (string, error) {
	return textCell("text", v)
}

// textCell reads a cell of the text column type columnType (varchar, text or uuid): a string, or bytes that are valid
// UTF-8; any other cell is refused with the message of its type (COD-1, COD-69).
func textCell(columnType string, v any) (string, error) {
	var s string
	switch x := v.(type) {
	case string:
		s = x
	case []byte:
		if x == nil {
			return "", ErrNullColumn
		}
		s = string(x)
	default:
		return "", cellRefusal(columnType)
	}
	if !utf8.ValidString(s) {
		return "", codecErr(CodeCodecDecode, "text is not valid UTF-8")
	}
	return s, nil
}

// AsBytes converts a bytes cell to an owned byte slice; a stored text is its UTF-8 bytes, as in every client.
func AsBytes(v any) ([]byte, error) {
	switch x := v.(type) {
	case []byte:
		if x == nil {
			return nil, ErrNullColumn
		}
		out := make([]byte, len(x))
		copy(out, x)
		return out, nil
	case string:
		return []byte(x), nil
	}
	return nil, cellRefusal("bytes")
}

// AsBool converts a bool cell to bool: a boolean, the integer 0 or 1, or the text 0, 1, f, t, false or true.
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
	return false, cellRefusal("bool")
}

// SetTimeText sets a date or datetime column from its text form and returns the parsed time, which the typed field
// keeps. A text that is not a time is recorded as the statement's error, which the statement returns, and the column
// is not set (T189).
func (c *Core) SetTimeText(column, text string) (time.Time, bool) {
	var (
		t   time.Time
		err error
	)
	// A date takes YYYY-MM-DD and a datetime(p) its form with at most p fraction digits, as every client writes them;
	// a text the column does not hold is the CODEC_ENCODE of a write, named by its column (COD-1).
	field := c.columnField(column)
	switch {
	case field != nil && field.Type == "date":
		t, err = AsDate(text)
	case field != nil && field.Type == "datetime":
		t, err = AsDateTime(text, field.Precision)
	case field != nil && field.Type == "time":
		// A time keeps its text with exactly p fraction digits, as the setter of a generated time column does.
		value, err := c.TimeText(column, text, field.Precision)
		if err != nil {
			c.failErr(err)
			return time.Time{}, false
		}
		c.Set(column, value)
		return time.Time{}, true
	default:
		err = cellRefusal("datetime")
	}
	if err != nil {
		if field == nil || c.ent == nil {
			c.failErr(codecErr(CodeInternal, "column %s is not a date or datetime column of the model", column))
			return time.Time{}, false
		}
		c.failErr(codecErr(CodeCodecEncode, "%s.%s: %s value is not a %s", c.ent.Name, column, field.Type, field.Type))
		return time.Time{}, false
	}
	c.Set(column, text)
	return t, true
}

// TimeText checks the text of a time(p) column that a setter takes and returns it with exactly p fraction digits. A text
// that is no time is the CODEC_ENCODE of a write, named by its column (COD-1).
func (c *Core) TimeText(column, text string, precision int) (string, error) {
	value, err := AsTimeText(text, precision)
	if err != nil {
		return "", codecErr(CodeCodecEncode, "%s.%s: time value is not a time", c.ent.Name, column)
	}
	return value, nil
}

// AsTime converts a date or datetime value to time.Time in any of the layouts that a setter takes.
func AsTime(v any) (time.Time, error) {
	switch x := v.(type) {
	case time.Time:
		return x, nil
	case string:
		for _, layout := range []string{"2006-01-02 15:04:05.999999", "2006-01-02 15:04:05", "2006-01-02T15:04:05.999999", "2006-01-02T15:04:05", "2006-01-02 15:04:05.999999-07:00", "2006-01-02 15:04:05-07:00", time.RFC3339Nano, "2006-01-02", "15:04:05.999999"} {
			if t, err := time.Parse(layout, x); err == nil {
				return t, nil
			}
		}
	case []byte:
		return AsTime(string(x))
	}
	return time.Time{}, codecErr(CodeCodecDecode, "cannot convert %T value %v to time", v, v)
}

// AsDate converts a date cell to time.Time: a time that the driver read, or the text YYYY-MM-DD of a real day; any other
// cell is refused (COD-1).
func AsDate(v any) (time.Time, error) {
	switch x := v.(type) {
	case time.Time:
		return x, nil
	case string, []byte:
		text := cellString(x)
		if dateText.MatchString(text) {
			if t, err := time.Parse("2006-01-02", text); err == nil {
				return t, nil
			}
		}
	}
	return time.Time{}, cellRefusal("date")
}

// AsDateTime converts a datetime(p) cell to time.Time: a time that the driver read, or the text YYYY-MM-DD HH:MM:SS (or
// with T) of a real instant with an optional fraction and offset. A fraction digit beyond p that is not zero loses
// value, so the cell is refused, as is any other cell (COD-1).
func AsDateTime(v any, precision int) (time.Time, error) {
	switch x := v.(type) {
	case time.Time:
		if x.Nanosecond()%int(math.Pow10(9-precision)) == 0 {
			return x, nil
		}
	case string, []byte:
		if t, ok := dateTimeCell(cellString(x), precision); ok {
			return t, nil
		}
	}
	return time.Time{}, cellRefusal("datetime")
}

// dateTimeCell parses a datetime text in the form that dateTimeText states.
func dateTimeCell(text string, precision int) (time.Time, bool) {
	m := dateTimeText.FindStringSubmatch(text)
	if m == nil {
		return time.Time{}, false
	}
	if _, ok := fractionDigits(m[7], precision); !ok {
		return time.Time{}, false
	}
	wall := m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5] + ":" + m[6]
	if m[7] != "" {
		wall += "." + m[7]
	}
	t, err := time.Parse("2006-01-02 15:04:05.999999999", wall)
	if err != nil {
		return time.Time{}, false
	}
	if m[8] == "" || m[8] == "Z" {
		return t, true
	}
	// The offset is two digits of hours and, optionally, two of minutes, as dateTimeText matched them.
	digits := strings.ReplaceAll(m[8][1:], ":", "")
	offset := int(digits[0]-'0')*36000 + int(digits[1]-'0')*3600
	if len(digits) == 4 {
		offset += int(digits[2]-'0')*600 + int(digits[3]-'0')*60
	}
	if m[8][0] == '-' {
		offset = -offset
	}
	return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.FixedZone("", offset)), true
}
