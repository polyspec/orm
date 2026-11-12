//go:build !ormtest

package recipe

import (
	"errors"

	"github.com/polyspec/orm/packages/go/orm"
)

// failNextRollback needs the test entry point, which only a build with the ormtest tag has (PRT-43).
func failNextRollback(*orm.DB) error {
	return errors.New("fault.next_rollback needs the ormtest build tag")
}

// failNextStatement needs the test entry point, which only a build with the ormtest tag has (PRT-48).
func failNextStatement(*orm.DB, string, string) error {
	return errors.New("fault.next_statement needs the ormtest build tag")
}
