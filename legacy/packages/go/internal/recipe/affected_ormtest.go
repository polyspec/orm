//go:build ormtest

package recipe

import (
	"strconv"

	"github.com/polyspec/orm/legacy/packages/go/orm"
)

// affectedFields is the `affected` of the last write on db, the value that the expect of a model write names (F15).
func affectedFields(db *orm.DB) map[string]any {
	n, ok := orm.LastAffected(db)
	if !ok {
		return map[string]any{}
	}
	return map[string]any{"value": map[string]any{"int": strconv.FormatInt(n, 10)}}
}
