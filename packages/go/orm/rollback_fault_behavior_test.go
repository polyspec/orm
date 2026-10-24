//go:build ormtest

package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-72, DIA-180.
func TestTransactionFailureRollbackFault(t *testing.T) {
	testcase.Start(t, testcase.Database)
	rollbackFault(t, "sqlite")
}
