package ir

import (
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestStringAndTextSupportOrderedCursorPredicates(t *testing.T) {
	for _, typ := range []string{"string", "text"} {
		column := &schema.Col{Type: typ}
		for _, op := range []string{"gt", "gte", "lt", "lte"} {
			if !OpAllowed(column, op) {
				t.Fatalf("%s column does not allow %s", typ, op)
			}
		}
	}
}
