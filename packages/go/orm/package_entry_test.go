package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
)

// Requirements: INT-138.
func TestExternalModuleCanImportClient(t *testing.T) {
	if orm.IsDeadlock(nil) {
		t.Fatal("nil error reported as a deadlock")
	}
}
