package orm_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestTransactionControlIsNotPublic reads the exported methods of *orm.DB: a transaction runs only through
// Transaction, and no method begins, commits or rolls back one. The test of DSL-124 (docs/spec/dsl.md "Transactions").
func TestTransactionControlIsNotPublic(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	typ := reflect.TypeFor[*orm.DB]()
	if _, ok := typ.MethodByName("Transaction"); !ok {
		t.Fatal("*orm.DB has no Transaction method, so the check reads the wrong type")
	}
	for i := range typ.NumMethod() {
		name := strings.ToLower(typ.Method(i).Name)
		for _, control := range []string{"begin", "commit", "rollback"} {
			if strings.HasPrefix(name, control) {
				t.Errorf("*orm.DB exports %s, which %ss a transaction outside Transaction", typ.Method(i).Name, control)
			}
		}
	}
}
