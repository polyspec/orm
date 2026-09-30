package orm

import "github.com/polyspec/orm/engine/schema"

type PhysicalKey = schema.PhysicalKey

func PhysicalKeyFromValue(value map[string]any) (*PhysicalKey, error) {
	return schema.PhysicalKeyFromValue(value)
}
