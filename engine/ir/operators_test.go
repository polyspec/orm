package ir

import (
	"testing"

	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
)

func TestStringAndTextSupportOrderedCursorPredicates(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, typ := range []string{"varchar", "text"} {
		column := &runtimemodel.Field{Type: typ}
		for _, op := range []string{"gt", "gte", "lt", "lte"} {
			if !OpAllowed(column, op) {
				t.Fatalf("%s column does not allow %s", typ, op)
			}
		}
	}
}

// uuid column은 equality와 목록 비교만 받는다. PostgreSQL uuid에는 LIKE가 없다.
func TestUUIDAllowsEqualityOnly(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	column := &runtimemodel.Field{Type: "uuid"}
	for op, want := range map[string]bool{"eq": true, "in": true, "is_null": true, "contains": false, "gt": false} {
		if got := OpAllowed(column, op); got != want {
			t.Errorf("uuid %s = %v, want %v", op, got, want)
		}
	}
}
