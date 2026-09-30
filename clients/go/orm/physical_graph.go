package orm

import "github.com/polyspec/orm/engine/schema"

type PhysicalGraph = schema.PhysicalGraph
type PhysicalGraphError = schema.PhysicalGraphError

func PhysicalGraphFromValue(value map[string]any) (*PhysicalGraph, error) {
	return schema.PhysicalGraphFromValue(value)
}
