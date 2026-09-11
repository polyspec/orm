package orm

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/polyspec/orm/engine/ir"
)

// A newly added mutable IR field must also survive an independent clone. The
// mutation walker visits every reachable field, including nested queries/groups.
func TestQueryCloneCoversEveryField(t *testing.T) {
	var original ir.Query
	type snapshot struct {
		copy ir.Query
		want string
		path string
	}
	var copies []snapshot
	eachMutation(reflect.ValueOf(&original).Elem(), "", 0, func(path string) {
		b, _ := json.Marshal(original)
		copy := ir.CloneQuery(original)
		if got, _ := json.Marshal(copy); string(got) != string(b) {
			t.Fatalf("%s: clone changed the query", path)
		}
		copies = append(copies, snapshot{copy, string(b), path})
	})
	for _, s := range copies {
		b, _ := json.Marshal(s.copy)
		if string(b) != s.want {
			t.Errorf("%s: clone still aliases the source", s.path)
		}
	}
	if len(copies) < 100 {
		t.Fatalf("only %d fields covered", len(copies))
	}
}

func TestAttachSnapshotsAllParameterLocations(t *testing.T) {
	child := &Req{IR: ir.Request{Query: ir.Query{Entity: "user"}}}
	group := func(i int) *ir.Group {
		return &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "seq", Op: "eq", P: &i}}}}
	}
	child.Params = []any{int64(1), int64(2), int64(3), int64(4)}
	child.IR.On, child.IR.Where, child.IR.Having = group(0), group(1), group(2)
	child.IR.IfParent = &ir.IfParent{Column: "seq", P: 3}
	child.Err = &ir.Error{Code: CodeCodecUnsupported, Msg: "fixture"}
	before, _ := json.Marshal(child.IR.Query)
	p1, p2 := &Req{Params: []any{int64(9)}}, &Req{Params: []any{int64(8), int64(7)}}
	a, b := p1.Attach(child), p2.Attach(child)
	a.Where.Items[0].Pred.Column = "changed"
	if got, _ := json.Marshal(child.IR.Query); string(got) != string(before) {
		t.Fatal("attach mutated child")
	}
	if b.Where.Items[0].Pred.Column != "seq" {
		t.Fatal("parents share a condition")
	}
	for off, q := range map[int]*ir.Query{1: a, 2: b} {
		if *q.On.Items[0].Pred.P != off || *q.Where.Items[0].Pred.P != off+1 || *q.Having.Items[0].Pred.P != off+2 || q.IfParent.P != off+3 {
			t.Fatalf("wrong parameter indices at offset %d", off)
		}
	}
	if p1.Err != child.Err || p2.Err != child.Err {
		t.Fatal("child error lost")
	}
}
