package gen_test

// Integration test against the local MySQL (orm_bench, /tmp/mysql.sock).
// Skips when the socket is absent. This is the Go half of the S1 demo.

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"github.com/maxkwon/orm/clients/go/gen"
	"github.com/maxkwon/orm/clients/go/orm"
	"github.com/maxkwon/orm/engine"
	"github.com/maxkwon/orm/engine/schema"
)

func open(t *testing.T) *orm.DB {
	t.Helper()
	if _, err := os.Stat("/tmp/mysql.sock"); err != nil {
		t.Skip("no local mysql")
	}
	js, err := os.ReadFile("../../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Load(js)
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.New(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	var log []string
	db, err := orm.Open("mysql", "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true", eng, orm.Config{
		AESKey:  "bench-salt",
		OnQuery: func(e orm.Event) { log = append(log, e.SQL) },
	})
	if err != nil {
		t.Fatal(err)
	}
	gen.Init(eng)
	t.Cleanup(func() {
		if t.Failed() {
			for _, s := range log {
				t.Log(s)
			}
		}
	})
	return db
}

func TestReadPaths(t *testing.T) {
	db := open(t)
	ctx := context.Background()

	b, err := gen.NewBattle().OneBySeq(ctx, db, 42)
	if err != nil || b == nil {
		t.Fatalf("one: %v %v", err, b)
	}
	if b.GetSeq() != 42 || b.GetName() != "battle-42" || b.GetAesHexEmail() == nil || *b.GetAesHexEmail() != "user42@example.com" {
		t.Errorf("row: seq=%d name=%q email=%v", b.Seq, b.Name, b.AesHexEmail)
	}
	if b.Description != nil {
		t.Error("lazy column must not be loaded by default")
	}
	// data: is_close = seq%7==0, is_display = seq%3!=0 → 42: closed, not displayed
	if b.CreatedTs.IsZero() || !b.IsClose || b.IsDisplay {
		t.Errorf("types: created=%v is_close=%v is_display=%v", b.CreatedTs, b.IsClose, b.IsDisplay)
	}

	// lazy opt-in
	b2, _ := gen.NewBattle().SelectDescription().SeqEq(42).One(ctx, db)
	if b2.Description == nil || !strings.HasPrefix(*b2.Description, "desc-42") {
		t.Errorf("select lazy: %v", b2.Description)
	}

	// all + group + or + in + order + limit
	now := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)
	rows, err := gen.NewBattle().
		ServiceSeqEq(7).
		IsCloseEq(false).
		And(func(w *gen.BattleWhere) {
			w.IsDisplayEq(true).Or().And(func(w *gen.BattleWhere) { w.IsDisplayEq(false).DisplayStartDtLt(now) })
		}).
		SeqIn([]int64{6, 106, 206, 306, 406}). // service_seq 7 ⇔ seq ≡ 6 (mod 100); 406 is closed
		OrderBySeqDesc().
		Limit(0, 3).
		All(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if rows.Len() != 3 || rows.First().Seq != 306 {
		t.Errorf("all: len=%d first=%v", rows.Len(), rows.First())
	}
	for k, r := range rows.All() {
		if k.I != r.Seq {
			t.Errorf("key %v != seq %d", k, r.Seq)
		}
	}

	n, err := gen.NewBattle().ServiceSeqEq(7).Count(ctx, db)
	if err != nil || n != 1000 {
		t.Errorf("count: %d %v", n, err)
	}
	sum, err := gen.NewBattle().ServiceSeqEq(7).SumLikeCount(ctx, db)
	if err != nil || sum <= 0 {
		t.Errorf("sum: %v %v", sum, err)
	}

	// join + nav + on/where placement
	cnt, err := gen.NewBattle().
		JoinService(gen.NewService().Where(func(w *gen.ServiceWhere) { w.NameEq("service-7") })).
		LeftJoinUser(gen.NewUser().On(func(w *gen.UserWhere) { w.NameContains("user") })).
		IsCloseEq(false).
		And(func(w *gen.BattleWhere) {
			w.IsDisplayEq(true).Or().Service(func(s *gen.ServiceWhere) { s.SeqGt(1000) })
		}).
		Count(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if cnt == 0 {
		t.Error("join count is zero")
	}

	page, err := gen.NewBattle().ServiceSeqEq(7).OrderBySeqAsc().Paginate(ctx, db, 2, 10)
	if err != nil || page.Total != 1000 || page.Pages != 100 || page.Items.Len() != 10 || page.Items.First().Seq != 1006 {
		t.Errorf("paginate: %+v err=%v", page, err)
	}

	// contains transform escapes % and _
	zero, err := gen.NewBattle().NameContains("%").Count(ctx, db)
	if err != nil || zero != 0 {
		t.Errorf("contains escape: %d %v", zero, err)
	}
}

func TestWritePaths(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	email := "w@example.com"
	created, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
		return gen.NewBattle().
			SetName("go-write").
			SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
			SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)).
			SetAesHexEmail(email).
			Insert(ctx, tx)
	})
	if err != nil || created == nil || created.Seq == 0 || created.AesHexEmail == nil || *created.AesHexEmail != email {
		t.Fatalf("insert: %v %+v", err, created)
	}
	defer gen.NewBattle().ServiceSeqEq(999).Count(ctx, db) // keep compiler happy about unused paths

	// update dirty columns only, optimistic
	created.SetName("go-write-2").SetLikeCount(5)
	if err := created.UpdateOptimistic(ctx, db); err != nil {
		t.Fatalf("update: %v", err)
	}
	again, _ := gen.NewBattle().OneBySeq(ctx, db, created.Seq)
	if again.Name != "go-write-2" || again.LikeCount != 5 {
		t.Errorf("after update: %+v", again)
	}
	// stale optimistic value → OPTIMISTIC_LOCK
	created.SetName("stale")
	if err := created.UpdateOptimistic(ctx, db); err == nil || !strings.Contains(err.Error(), "OPTIMISTIC_LOCK") {
		t.Errorf("optimistic lock not detected: %v", err)
	}
	// plus/minus via draft-style update through query is S3; delete now
	if err := again.Delete(ctx, db); err != nil {
		t.Fatal(err)
	}
	if left, _ := gen.NewBattle().SeqEq(created.Seq).Count(ctx, db); left != 0 {
		t.Errorf("row not deleted")
	}
}
