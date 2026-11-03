//go:build ormtest

package recipe

import "github.com/polyspec/orm/packages/go/orm"

// failNextRollback arms the rollback fault of db through the test entry point (PRT-43).
func failNextRollback(db *orm.DB) error {
	orm.FailNextRollback(db)
	return nil
}
