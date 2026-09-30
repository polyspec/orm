package orm

import "github.com/polyspec/orm/engine/schema"

type PhysicalIdentity = schema.PhysicalIdentity

func NewPhysicalIdentity(catalog, namespace *string, table string, column *string) (PhysicalIdentity, error) {
	return schema.NewPhysicalIdentity(catalog, namespace, table, column)
}
