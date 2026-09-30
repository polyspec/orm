package orm

import "github.com/polyspec/orm/engine/schema"

type PhysicalIndex = schema.PhysicalIndex

func PhysicalIndexFromValue(value map[string]any) (*PhysicalIndex, error) {
	return schema.PhysicalIndexFromValue(value)
}
