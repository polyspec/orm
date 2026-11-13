//go:build ormtest

package recipe

import "github.com/polyspec/orm/legacy/packages/go/orm"

// failNextRollback arms the rollback fault of db through the test entry point (PRT-43).
func failNextRollback(db *orm.DB) error {
	orm.FailNextRollback(db)
	return nil
}

// failNextStatement arms the statement fault of db with code and message through the test entry point (PRT-48).
func failNextStatement(db *orm.DB, code, message string) error {
	orm.FailNextStatement(db, code, message)
	return nil
}
