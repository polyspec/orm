package orm

import "github.com/polyspec/orm/engine/schema"

type PhysicalCheck = schema.PhysicalCheck

func PhysicalCheckFromValue(value map[string]any) (*PhysicalCheck, error) {
	return schema.PhysicalCheckFromValue(value)
}
