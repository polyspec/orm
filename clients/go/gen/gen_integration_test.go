package gen_test

// Integration test against the local MySQL (orm_bench, /tmp/mysql.sock).
// Skips when the socket is absent. This is the Go half of the S1 demo.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
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

	// join result access
	j, err := gen.NewBattle().JoinService(gen.NewService().Where(func(w *gen.ServiceWhere) { w.SeqEq(7) })).SeqEq(6).One(ctx, db)
	if err != nil || j == nil || j.GetService() == nil || j.GetService().Name != "service-7" {
		t.Errorf("joined row access: %v %+v", err, j)
	}
}

func TestRelationPaths(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	// data: service 7 has 50 members (service_member.service_seq = 7) and 1 module; each user has 20 battles.
	var stmts []string
	db.Cfg().OnQuery = func(e orm.Event) { stmts = append(stmts, e.SQL) }

	// one relation off the root, many off a nested one, key_by + limit_per_parent + drop_child_key
	rows, err := gen.NewBattle().
		ServiceSeqEq(7).OrderBySeqAsc().Limit(0, 5).
		RelationUser(gen.NewUser()).
		RelationService(gen.NewService().
			RelationsMembers(gen.NewServiceMember().OrderBySeqDesc().LimitPerParent(3).KeyByUserSeq().DropChildKey())).
		All(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if rows.Len() != 5 || len(stmts) != 4 { // main, user, service, members
		t.Fatalf("len=%d statements=%d", rows.Len(), len(stmts))
	}
	for _, b := range rows.All() {
		if b.GetUser() == nil || b.User.Seq != b.UserSeq || b.User.Name != fmt.Sprintf("user-%d", b.UserSeq) {
			t.Errorf("battle %d user: %+v", b.Seq, b.User)
		}
		if b.GetService() == nil || b.Service.Seq != 7 || b.Service.GetMembers().Len() != 3 {
			t.Errorf("battle %d service/members: %+v", b.Seq, b.Service)
		}
		for k, m := range b.Service.GetMembers().All() {
			if k.I != m.UserSeq || m.ServiceSeq != 7 {
				t.Errorf("member key %v vs %+v", k, m)
			}
		}
	}
	// the members step: 3 per service by seq desc, one IN value (service 7), dropped key stays readable (typed)
	if !strings.Contains(stmts[3], "ROW_NUMBER() OVER (PARTITION BY `a`.`service_seq` ORDER BY `a`.`seq` DESC)") || !strings.Contains(stmts[3], "`orm_rn` <= 3") {
		t.Errorf("members sql: %s", stmts[3])
	}

	// if_parent: users only for closed battles (seq%7==0); many relation with key_by; join + relation off the join
	stmts = nil
	rows, err = gen.NewBattle().
		SeqIn([]int64{7, 8, 14}).OrderBySeqAsc().
		RelationUser(gen.NewUser().IfParentIsCloseEq(true).RelationsBattles(gen.NewBattle().OrderBySeqAsc().LimitPerParent(2))).
		JoinService(gen.NewService().RelationsModules(gen.NewServiceModule())).
		All(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	b7, b8, b14 := rows.Get(orm.KeyOf(int64(7))), rows.Get(orm.KeyOf(int64(8))), rows.Get(orm.KeyOf(int64(14)))
	if b7.GetUser() == nil || b14.GetUser() == nil || b8.GetUser() != nil {
		t.Errorf("if_parent: 7=%v 8=%v 14=%v", b7.User != nil, b8.User != nil, b14.User != nil)
	}
	if n := b7.User.GetBattles().Len(); n != 2 || b7.User.Battles.First().UserSeq != b7.UserSeq {
		t.Errorf("nested many limit_per_parent: %d", n)
	}
	if b8.GetService() == nil || b8.Service.GetModules().Len() != 1 || b8.Service.Modules.First().ServiceSeq != b8.ServiceSeq {
		t.Errorf("relation off join: %+v", b8.Service)
	}
	// the users step binds only the closed battles' user_seq (7 and 14 → two values → padded to 2 placeholders)
	if !strings.Contains(stmts[1], "`a`.`seq` IN (?, ?)") {
		t.Errorf("users IN: %s", stmts[1])
	}

	// no parents → relation steps are skipped, collections stay empty (never nil)
	stmts = nil
	none, err := gen.NewBattle().SeqEq(0).RelationUser(gen.NewUser()).All(ctx, db)
	if err != nil || none.Len() != 0 || len(stmts) != 1 {
		t.Errorf("empty parents: len=%d statements=%d err=%v", none.Len(), len(stmts), err)
	}
	one, err := gen.NewBattle().SeqEq(42).RelationService(gen.NewService().RelationsMembers(gen.NewServiceMember().LimitPerParent(1))).One(ctx, db)
	if err != nil || one == nil || one.Service == nil || one.Service.GetMembers().Len() != 1 {
		t.Errorf("one + relation: %+v %v", one, err)
	}
	// flatten: typed access is unchanged (array/JSON forms merge the child's columns)
	m, err := gen.NewServiceMember().ServiceSeqEq(7).OrderBySeqAsc().Limit(0, 2).RelationUser(gen.NewUser().Flatten()).All(ctx, db)
	if err != nil || m.First().GetUser() == nil || m.First().User.Name != fmt.Sprintf("user-%d", m.First().UserSeq) {
		t.Errorf("flatten: %v %+v", err, m.First())
	}
	// paginate keeps relations
	page, err := gen.NewBattle().ServiceSeqEq(7).OrderBySeqAsc().RelationUser(gen.NewUser()).Paginate(ctx, db, 1, 4)
	if err != nil || page.Total != 1000 || page.Items.Len() != 4 || page.Items.First().GetUser() == nil {
		t.Errorf("paginate + relation: %+v %v", page, err)
	}
	db.Cfg().OnQuery = nil
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

func TestErrorSurface(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	if _, err := gen.NewBattle().SeqIn([]int64{}).Count(ctx, db); err == nil || !strings.Contains(err.Error(), "EMPTY_IN") {
		t.Errorf("EMPTY_IN: %v", err)
	}
}

// TestDeadlockRetry is the S3 deadlock gate: two transactions lock the same two
// rows in opposite order, MySQL kills one with 1213, and Transaction re-runs
// that closure until both commit.
func TestDeadlockRetry(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	insert := func(name string) *gen.BattleRow {
		t.Helper()
		r, err := gen.NewBattle().
			SetName(name).
			SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
			SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)).
			Insert(ctx, db)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	a, b := insert("dl-go-1"), insert("dl-go-2")
	t.Cleanup(func() {
		if n, err := gen.NewBattle().SeqIn([]int64{a.Seq, b.Seq}).Delete(ctx, db); err != nil || n != 2 {
			t.Errorf("cleanup: deleted %d, %v", n, err)
		}
	})

	var calls atomic.Int32
	// Both sides hold their first row before touching the second, so the second
	// updates close the lock cycle; only the first attempt synchronises.
	var locked sync.WaitGroup
	locked.Add(2)
	writer := func(tag int32, first, second int64) error {
		attempt := 0
		_, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (struct{}, error) {
			attempt++
			calls.Add(1)
			if _, err := gen.NewBattle().SeqEq(first).SetLikeCount(tag).Update(ctx, tx); err != nil {
				return struct{}{}, err
			}
			if attempt == 1 {
				locked.Done()
				locked.Wait()
			}
			_, err := gen.NewBattle().SeqEq(second).SetLikeCount(tag).Update(ctx, tx)
			return struct{}{}, err
		})
		return err
	}
	errs := make(chan error, 2)
	go func() { errs <- writer(1, a.Seq, b.Seq) }()
	go func() { errs <- writer(2, b.Seq, a.Seq) }()
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("transaction did not recover: %v", err)
		}
	}
	if n := calls.Load(); n < 3 {
		t.Errorf("closure invocations = %d, the deadlock victim must have re-run", n)
	}
	ra, _ := gen.NewBattle().OneBySeq(ctx, db, a.Seq)
	rb, _ := gen.NewBattle().OneBySeq(ctx, db, b.Seq)
	if ra.LikeCount != rb.LikeCount || (ra.LikeCount != 1 && ra.LikeCount != 2) {
		t.Errorf("last writer must own both rows: a=%d b=%d", ra.LikeCount, rb.LikeCount)
	}
}
