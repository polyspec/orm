package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
)

func TestExternalModuleCanImportClient(t *testing.T) {
	if orm.IsDeadlock(nil) {
		t.Fatal("nil error reported as a deadlock")
	}
}
