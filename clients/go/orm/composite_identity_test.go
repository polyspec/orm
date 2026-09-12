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

func TestMoveKeysToWhereUsesEveryPrimaryKeyComponent(t *testing.T) {
	q := compositeTestQuery()
	q.Set("tenant_id", int64(7))
	q.Set("account_id", int64(11))
	q.Set("name", "updated")

	values, found, err := q.MoveKeysToWhere([]string{"tenant_id", "account_id"})
	if err != nil || !found || !reflect.DeepEqual(values, []any{int64(7), int64(11)}) {
		t.Fatalf("values=%#v found=%t err=%v", values, found, err)
	}
	if len(q.Req.IR.Set) != 1 || q.Req.IR.Set[0].Column != "name" {
		t.Fatalf("remaining assignments=%#v", q.Req.IR.Set)
	}
	if q.Req.IR.Where == nil || len(q.Req.IR.Where.Items) != 2 {
		t.Fatalf("where=%#v", q.Req.IR.Where)
	}
	for i, want := range []string{"tenant_id", "account_id"} {
		if got := q.Req.IR.Where.Items[i].Pred.Column; got != want {
			t.Fatalf("predicate %d column=%q want=%q", i, got, want)
		}
	}
}

func TestMoveKeysToWhereRejectsPartialPrimaryKeyWithoutMutation(t *testing.T) {
	q := compositeTestQuery()
	q.Set("tenant_id", int64(7))
	q.Set("name", "updated")
	beforeSet := append([]string(nil), q.Req.IR.Set[0].Column, q.Req.IR.Set[1].Column)

	if _, _, err := q.MoveKeysToWhere([]string{"tenant_id", "account_id"}); err == nil {
		t.Fatal("partial primary key was accepted")
	}
	if q.Req.IR.Where != nil {
		t.Fatalf("partial key changed where: %#v", q.Req.IR.Where)
	}
	afterSet := []string{q.Req.IR.Set[0].Column, q.Req.IR.Set[1].Column}
	if !reflect.DeepEqual(afterSet, beforeSet) {
		t.Fatalf("assignments changed: before=%v after=%v", beforeSet, afterSet)
	}
}

func TestCompositeCollectionKeySeparatesAmbiguousValues(t *testing.T) {
	a := KeyFromValues([]any{"1", "23"})
	b := KeyFromValues([]any{"12", "3"})
	if a == b {
		t.Fatalf("composite keys collided: %q", a.String())
	}
}
