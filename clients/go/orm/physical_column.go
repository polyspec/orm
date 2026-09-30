package orm

import "github.com/polyspec/orm/engine/schema"

type PhysicalColumn = schema.PhysicalColumn

func PhysicalColumnFromValue(value map[string]any) (*PhysicalColumn, error) {
	return schema.PhysicalColumnFromValue(value)
}
