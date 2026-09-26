package orm

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/schema"
)

type groupValue struct {
	name  string
	value any
}

func validateGroupColumns(columns []plan.OutCol) error {
	seen := make(map[string]bool, len(columns))
	for _, column := range columns {
		if column.Hidden {
			continue
		}
		if seen[column.Name] {
			return configErr("group result repeats column %s", column.Name)
		}
		seen[column.Name] = true
	}
	if !seen["row_count"] {
		return codecErr(CodeInternal, "group result has no row_count")
	}
	return nil
}

// GroupRow contains one selected grouping result and its checked row count.
type GroupRow struct {
	values []groupValue
	count  int64
}

func newGroupRow(values []groupValue) (GroupRow, error) {
	seen := make(map[string]bool, len(values))
	var count int64
	countFound := false
	for _, item := range values {
		if seen[item.name] {
			return GroupRow{}, configErr("group result repeats column %s", item.name)
		}
		seen[item.name] = true
		if item.name == "row_count" {
			if _, ok := item.value.(bool); ok {
				return GroupRow{}, codecErr(CodeCodecDecode, "group result row_count is boolean")
			}
			var err error
			count, err = AsInt64(item.value)
			if err != nil {
				return GroupRow{}, fmt.Errorf("group result row_count: %w", err)
			}
			if count < 0 {
				return GroupRow{}, codecErr(CodeInternal, "group result has a negative row_count")
			}
			countFound = true
		}
	}
	if !countFound {
		return GroupRow{}, codecErr(CodeInternal, "group result has no row_count")
	}
	return GroupRow{values: append([]groupValue(nil), values...), count: count}, nil
}

func (r GroupRow) Count() int64 { return r.count }

// Value returns a selected group value; a missing name differs from SQL NULL.
func (r GroupRow) Value(name string) (any, bool) {
	for _, item := range r.values {
		if item.name == name {
			return item.value, true
		}
	}
	return nil, false
}

func (r GroupRow) ToArray() map[string]any {
	out := make(map[string]any, len(r.values))
	for _, item := range r.values {
		out[item.name] = item.value
	}
	return out
}

func (r GroupRow) MarshalJSON() ([]byte, error) { return json.Marshal(r.ToArray()) }

// GroupRows contains grouped values without constructing partial models.
type GroupRows struct{ rows []GroupRow }

func (r *GroupRows) Len() int { return len(r.rows) }

func (r *GroupRows) ToArray() []map[string]any {
	out := make([]map[string]any, 0, len(r.rows))
	for _, row := range r.rows {
		out = append(out, row.ToArray())
	}
	return out
}

func (r *GroupRows) MarshalJSON() ([]byte, error) { return json.Marshal(r.ToArray()) }

// All visits grouped rows in result order.
func (r *GroupRows) All() func(yield func(GroupRow) bool) {
	return func(yield func(GroupRow) bool) {
		for _, row := range r.rows {
			if !yield(row) {
				return
			}
		}
	}
}

func groupColumnValue(c *Core, db *DB, column plan.OutCol, declared *schema.Col, raw any) (any, error) {
	if raw == nil {
		if declared != nil && !declared.Nullable {
			return nil, codecErr(CodeCodecDecode, "group column %s is SQL NULL", column.Name)
		}
		return nil, nil
	}
	if declared != nil && len(declared.Styles) > 0 {
		return AsStyledValue(raw, declared.Nullable)
	}
	if column.Name == "row_count" {
		if _, ok := raw.(bool); ok {
			return nil, codecErr(CodeCodecDecode, "group result row_count is boolean")
		}
	}
	if column.Column == "" && column.Name != "row_count" {
		return raw, nil
	}
	switch column.Type {
	case "i64":
		return AsInt64(raw)
	case "i32":
		return AsInt32(raw)
	case "bool":
		return AsBool(raw)
	case "f64":
		return AsFloat64(raw)
	case "decimal":
		if declared == nil {
			return nil, codecErr(CodeInternal, "decimal group column %s has no declaration", column.Name)
		}
		return c.DecodeDecimal(raw, declared.Precision, declared.Scale)
	case "datetime", "date":
		value := db.localTime(raw)
		if t, ok := value.(time.Time); ok {
			return t, nil
		}
		return AsTime(value)
	case "string", "text", "enum", "inet", "time", "json":
		return AsString(raw)
	case "bytes":
		return AsBytes(raw)
	case "point":
		return AsPoint(raw)
	default:
		return nil, codecErr(CodeInternal, "group column %s has unsupported type %s", column.Name, column.Type)
	}
}
