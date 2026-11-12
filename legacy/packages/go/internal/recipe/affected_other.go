//go:build !ormtest

package recipe

import "github.com/polyspec/orm/packages/go/orm"

// affectedFields holds nothing without the test entry point of the ormtest build (F15, PRT-58).
func affectedFields(*orm.DB) map[string]any {
	return map[string]any{}
}
