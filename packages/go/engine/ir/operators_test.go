package ir

import (
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
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

// A uuid column accepts only equality and list comparison. PostgreSQL uuid has no LIKE.
func TestUUIDAllowsEqualityOnly(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	column := &runtimemodel.Field{Type: "uuid"}
	for op, want := range map[string]bool{"eq": true, "in": true, "is_null": true, "contains": false, "gt": false} {
		if got := OpAllowed(column, op); got != want {
			t.Errorf("uuid %s = %v, want %v", op, got, want)
		}
	}
}
