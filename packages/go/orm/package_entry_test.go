package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-138.
func TestExternalModuleCanImportClient(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	if orm.IsDeadlock(nil) {
		t.Fatal("nil error reported as a deadlock")
	}
}
