package orm

import (
	"reflect"
	"testing"

	"github.com/polyspec/orm/engine/ir"
)

func compositeTestQuery() *Q {
	req := &Req{IR: ir.Request{IRVersion: ir.Version, Kind: "all", Entity: "membership"}}
	return &Q{Req: req, Node: &req.IR.Query}
}

func TestAssignedKeyValuesRequiresEveryPrimaryKeyWithoutMutation(t *testing.T) {
	q := compositeTestQuery()
	q.Set("tenant_id", int64(7))
	q.Set("account_id", int64(11))
	q.Set("name", "created")
	values, err := q.AssignedKeyValues([]string{"tenant_id", "account_id"})
	if err != nil || !reflect.DeepEqual(values, []any{int64(7), int64(11)}) {
		t.Fatalf("values=%#v err=%v", values, err)
	}
	if len(q.Req.IR.Set) != 3 || q.Req.IR.Where != nil {
		t.Fatalf("key inspection changed request: set=%#v where=%#v", q.Req.IR.Set, q.Req.IR.Where)
	}

	partial := compositeTestQuery()
	partial.Set("tenant_id", int64(7))
	partial.Set("name", "created")
	if _, err := partial.AssignedKeyValues([]string{"tenant_id", "account_id"}); err == nil {
		t.Fatal("partial insert primary key was accepted")
	}
	if len(partial.Req.IR.Set) != 2 || partial.Req.IR.Where != nil {
		t.Fatalf("failed inspection changed request: set=%#v where=%#v", partial.Req.IR.Set, partial.Req.IR.Where)
	}
}

func TestCompositeCollectionKeySeparatesAmbiguousValues(t *testing.T) {
	a := KeyFromValues([]any{"1", "23"})
	b := KeyFromValues([]any{"12", "3"})
	if a == b {
		t.Fatalf("composite keys collided: %q", a.String())
	}
}
