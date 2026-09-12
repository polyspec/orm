package orm

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/polyspec/orm/engine/ir"
)

const keysetCursorVersion = 1

// KeysetCursor is the portable cursor payload. Values use explicit JSON
// types so integer precision is preserved across Go, PHP, Rust, and TypeScript.
type KeysetCursor struct {
	Version int           `json:"version"`
	Order   []ir.Order    `json:"order"`
	Values  []cursorValue `json:"values"`
}

type cursorValue struct {
	Type  string `json:"type"`
	Value any    `json:"value"`
}

// EncodeKeysetCursor returns an opaque base64url cursor for one ordered row.
func EncodeKeysetCursor(order []ir.Order, values []any) (string, error) {
	if len(order) == 0 || len(order) != len(values) {
		return "", &ir.Error{Code: "CURSOR_INVALID", Msg: fmt.Sprintf("cursor has %d values for %d order columns", len(values), len(order))}
	}
	out := KeysetCursor{Version: keysetCursorVersion, Order: slices.Clone(order), Values: make([]cursorValue, len(values))}
	for i, value := range values {
		encoded, err := encodeCursorValue(value)
		if err != nil {
			return "", fmt.Errorf("cursor value %d: %w", i, err)
		}
		out.Values[i] = encoded
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", &ir.Error{Code: "CURSOR_INVALID", Msg: "cursor encoding failed"}
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// DecodeKeysetCursor validates and decodes an opaque cursor. The order must
// be compared with the query's normalized order by the caller.
func DecodeKeysetCursor(encoded string) (KeysetCursor, error) {
	if encoded == "" {
		return KeysetCursor{}, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return KeysetCursor{}, &ir.Error{Code: "CURSOR_INVALID", Msg: "cursor is not valid base64url"}
	}
	var cursor KeysetCursor
	if err := json.Unmarshal(b, &cursor); err != nil || cursor.Version != keysetCursorVersion {
		return KeysetCursor{}, &ir.Error{Code: "CURSOR_INVALID", Msg: "cursor version or JSON is invalid"}
	}
	if len(cursor.Order) == 0 || len(cursor.Order) != len(cursor.Values) {
		return KeysetCursor{}, &ir.Error{Code: "CURSOR_INVALID", Msg: "cursor order and values have different lengths"}
	}
	return cursor, nil
}

func encodeCursorValue(value any) (cursorValue, error) {
	switch v := value.(type) {
	case nil:
		return cursorValue{}, &ir.Error{Code: "CURSOR_INVALID", Msg: "null order values are not supported"}
	case bool:
		return cursorValue{Type: "bool", Value: v}, nil
	case int:
		return cursorValue{Type: "i64", Value: fmt.Sprintf("%d", v)}, nil
	case int8:
		return cursorValue{Type: "i64", Value: fmt.Sprintf("%d", v)}, nil
	case int16:
		return cursorValue{Type: "i64", Value: fmt.Sprintf("%d", v)}, nil
	case int32:
		return cursorValue{Type: "i64", Value: fmt.Sprintf("%d", v)}, nil
	case int64:
		return cursorValue{Type: "i64", Value: fmt.Sprintf("%d", v)}, nil
	case uint, uint8, uint16, uint32, uint64:
		return cursorValue{}, &ir.Error{Code: "CURSOR_INVALID", Msg: "unsigned order values are not supported; use signed integer columns"}
	case float32:
		if !isFinite(float64(v)) {
			return cursorValue{}, &ir.Error{Code: "CURSOR_INVALID", Msg: "non-finite order value"}
		}
		return cursorValue{Type: "f64", Value: float64(v)}, nil
	case float64:
		if !isFinite(v) {
			return cursorValue{}, &ir.Error{Code: "CURSOR_INVALID", Msg: "non-finite order value"}
		}
		return cursorValue{Type: "f64", Value: v}, nil
	case string:
		return cursorValue{Type: "string", Value: v}, nil
	case time.Time:
		return cursorValue{Type: "datetime", Value: v.UTC().Format("2006-01-02 15:04:05.000000")}, nil
	default:
		return cursorValue{}, &ir.Error{Code: "CURSOR_INVALID", Msg: fmt.Sprintf("unsupported order value type %T", value)}
	}
}

func isFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func cursorParams(cursor KeysetCursor) ([]any, error) {
	params := make([]any, len(cursor.Values))
	for i, value := range cursor.Values {
		switch value.Type {
		case "bool":
			v, ok := value.Value.(bool)
			if !ok {
				return nil, &ir.Error{Code: "CURSOR_INVALID", Msg: "bool cursor value is invalid"}
			}
			params[i] = v
		case "i64":
			s, ok := value.Value.(string)
			if !ok {
				return nil, &ir.Error{Code: "CURSOR_INVALID", Msg: "i64 cursor value is invalid"}
			}
			var v int64
			if _, err := fmt.Sscan(s, &v); err != nil {
				return nil, &ir.Error{Code: "CURSOR_INVALID", Msg: "i64 cursor value is invalid"}
			}
			params[i] = v
		case "f64", "string":
			if _, ok := value.Value.(string); value.Type == "string" {
				if !ok {
					return nil, &ir.Error{Code: "CURSOR_INVALID", Msg: "string cursor value is invalid"}
				}
			}
			params[i] = value.Value
		case "datetime":
			s, ok := value.Value.(string)
			if !ok {
				return nil, &ir.Error{Code: "CURSOR_INVALID", Msg: "datetime cursor value is invalid"}
			}
			v, err := time.Parse("2006-01-02 15:04:05.000000", s)
			if err != nil {
				return nil, &ir.Error{Code: "CURSOR_INVALID", Msg: "datetime cursor value is invalid"}
			}
			params[i] = v
		default:
			return nil, &ir.Error{Code: "CURSOR_INVALID", Msg: "unsupported cursor value type " + value.Type}
		}
	}
	return params, nil
}

// KeysetPage is a page traversed with an ordered cursor.
type KeysetPage[T any] struct {
	Items          *Collection[T]
	NextCursor     string
	PreviousCursor string
}

// ReverseRows restores the caller's requested order after a before query.
func ReverseRows(rows *Rows) {
	for i, j := 0, len(rows.Data)-1; i < j; i, j = i+1, j-1 {
		rows.Data[i], rows.Data[j] = rows.Data[j], rows.Data[i]
	}
}

// KeysetPageFromRows creates cursors from the raw, assembled root rows.
func KeysetPageFromRows[T any](rows *Rows, items *Collection[T], order []ir.Order) (*KeysetPage[T], error) {
	page := &KeysetPage[T]{Items: items}
	if len(rows.Data) == 0 {
		return page, nil
	}
	values := func(row []any) ([]any, error) {
		out := make([]any, len(order))
		for i, o := range order {
			found := false
			for _, col := range rows.Assemble.Columns {
				if col.Column == o.Column {
					out[i] = row[col.Index]
					found = true
					break
				}
			}
			if !found {
				return nil, &ir.Error{Code: "CURSOR_INVALID", Msg: "keyset order column is not projected: " + o.Column}
			}
		}
		return out, nil
	}
	first, err := values(rows.Data[0])
	if err != nil {
		return nil, err
	}
	last, err := values(rows.Data[len(rows.Data)-1])
	if err != nil {
		return nil, err
	}
	if page.PreviousCursor, err = EncodeKeysetCursor(order, first); err != nil {
		return nil, err
	}
	if page.NextCursor, err = EncodeKeysetCursor(order, last); err != nil {
		return nil, err
	}
	return page, nil
}
