package orm

import "github.com/polyspec/orm/engine/schema"

type PhysicalForeignKey = schema.PhysicalForeignKey

func PhysicalForeignKeyFromValue(value map[string]any) (*PhysicalForeignKey, error) {
	return schema.PhysicalForeignKeyFromValue(value)
}
