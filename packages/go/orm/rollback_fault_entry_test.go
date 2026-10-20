package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRollbackFaultEntry checks that FailNextRollback is present only in builds with the ormtest build tag:
// without the tag the package excludes this file, and with the tag it
// compiles.
// Requirements: PRT-43, PRT-53, PRT-58.
func TestRollbackFaultEntry(t *testing.T) {
	testcase.Start(t, testcase.Process)
	checkOrmtestFile(t, "fault_ormtest.go")
}
