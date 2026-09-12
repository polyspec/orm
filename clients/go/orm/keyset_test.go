package orm

import (
	"testing"
	"time"

	"github.com/polyspec/orm/engine/ir"
)

func TestKeysetCursorPreservesTypedValuesAndRejectsTampering(t *testing.T) {
	order := []ir.Order{{Column: "seq"}, {Column: "created_ts", Desc: true}}
	wantTime := time.Date(2026, 9, 13, 12, 34, 56, 123456000, time.FixedZone("KST", 9*60*60))
	encoded, err := EncodeKeysetCursor(order, []any{int64(9223372036854770000), wantTime})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeKeysetCursor(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Version != 1 || len(decoded.Order) != 2 || decoded.Order[1].Desc != true {
		t.Fatalf("cursor metadata: %+v", decoded)
	}
	params, err := cursorParams(decoded)
	if err != nil {
		t.Fatal(err)
	}
	decodedTime, ok := params[1].(time.Time)
	if params[0] != int64(9223372036854770000) || !ok || !decodedTime.Equal(wantTime) {
		t.Fatalf("cursor values: %#v", params)
	}
	bad := encoded[:len(encoded)-1] + "!"
	if _, err := DecodeKeysetCursor(bad); err == nil {
		t.Fatal("tampered cursor accepted")
	}
}

func TestQKeysetAddsPrimaryKeysAndValidatesCursorOrder(t *testing.T) {
	req := &Req{IR: ir.Request{IRVersion: ir.Version, Query: ir.Query{Entity: "battle"}}}
	q := &Q{Req: req, Node: &req.IR.Query}
	if err := q.Keyset("after", "", 20, []string{"seq"}); err != nil {
		t.Fatal(err)
	}
	if len(q.Node.Order) != 1 || q.Node.Order[0].Column != "seq" || q.Node.Limit.Count != 20 || q.Node.Keyset != nil {
		t.Fatalf("initial keyset: %+v", q.Node)
	}
	cursor, err := EncodeKeysetCursor(q.Node.Order, []any{int64(10)})
	if err != nil {
		t.Fatal(err)
	}
	if err := q.Keyset("after", cursor, 20, []string{"seq"}); err != nil {
		t.Fatal(err)
	}
	if q.Node.Keyset == nil || len(q.Node.Keyset.Values) != 1 || len(req.Params) != 1 {
		t.Fatalf("boundary keyset: %+v params=%#v", q.Node.Keyset, req.Params)
	}
	wrong, _ := EncodeKeysetCursor([]ir.Order{{Column: "name"}}, []any{"x"})
	if err := q.Keyset("after", wrong, 20, []string{"seq"}); err == nil {
		t.Fatal("cursor with different order accepted")
	}
}
