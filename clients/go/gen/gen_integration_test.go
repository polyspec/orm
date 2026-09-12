package gen_test

// Integration test against the local MySQL (orm_bench, /tmp/mysql.sock).
// Skips when the socket is absent. This is the Go half of the S1 demo.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"

	"github.com/polyspec/orm/clients/go/gen"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
)

const localDSN = "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true"

// dsn is ORM_MYSQL_DSN_GO when set (CI), else the local socket; the test skips
// when neither is available.
var rePgPlaceholder = regexp.MustCompile(`\$\d+`)

// normSQL renders a statement in the MySQL spelling (backticks, `?`) so the
// SQL assertions below read the same on every dialect; results are asserted as they are.
func normSQL(sql string) string {
	if testDriver() == "mysql" {
		return sql
	}
	return rePgPlaceholder.ReplaceAllString(strings.ReplaceAll(sql, `"`, "`"), "?")
}

// testDriver selects the database under test: ORM_TEST_DRIVER (mysql default) with ORM_TEST_DSN.
func testDriver() string {
	if v := os.Getenv("ORM_TEST_DRIVER"); v != "" {
		return v
	}
	return "mysql"
}

func dsn(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("ORM_TEST_DSN"); v != "" {
		return v
	}
	if v := os.Getenv("ORM_MYSQL_DSN_GO"); v != "" && testDriver() == "mysql" {
		return v
	}
	if testDriver() != "mysql" {
		t.Fatalf("ORM_TEST_DSN is required for driver %s", testDriver())
	}
	if _, err := os.Stat("/tmp/mysql.sock"); err != nil {
		t.Skip("no local mysql")
	}
	return localDSN
}

func schemaPath(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs("../../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func loadEngine(t *testing.T) *engine.Engine {
	t.Helper()
	js, err := os.ReadFile(schemaPath(t))
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Load(js)
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.New(m, testDriver())
	if err != nil {
		t.Fatal(err)
	}
	return eng
}

func open(t *testing.T) *orm.DB {
	t.Helper()
	d := dsn(t)
	eng := loadEngine(t)
	var log []string
	db, err := orm.Open(testDriver(), d, eng, orm.Config{
		AESKey:  "bench-salt",
		OnQuery: func(e orm.Event) { log = append(log, normSQL(e.SQL)) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := gen.Init(eng); err != nil {
		t.Fatal(err)
	}
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

	b, err := gen.Battle().Using(ctx, db).OneBySeq(42)
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
	b2, _ := gen.Battle().SelectDescription().SeqEq(42).Using(ctx, db).One()
	if b2.Description == nil || !strings.HasPrefix(*b2.Description, "desc-42") {
		t.Errorf("select lazy: %v", b2.Description)
	}

	// all + group + or + in + order + limit
	now := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)
	rows, err := gen.Battle().
		ServiceSeqEq(7).
		IsCloseEq(false).
		And(func(w *gen.BattleWhere) {
			w.IsDisplayEq(true).Or().And(func(w *gen.BattleWhere) { w.IsDisplayEq(false).DisplayStartDtLt(now) })
		}).
		SeqIn([]int64{6, 106, 206, 306, 406}). // service_seq 7 ⇔ seq ≡ 6 (mod 100); 406 is closed
		OrderBySeqDesc().
		Limit(0, 3).Using(ctx, db).All()
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

	n, err := gen.Battle().ServiceSeqEq(7).Using(ctx, db).Count()
	if err != nil || n != 1000 {
		t.Errorf("count: %d %v", n, err)
	}
	sum, err := gen.Battle().ServiceSeqEq(7).Using(ctx, db).SumLikeCount()
	if err != nil || sum <= 0 {
		t.Errorf("sum: %v %v", sum, err)
	}

	// join + nav + on/where placement
	cnt, err := gen.Battle().
		Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.NameEq("service-7") })).
		LeftJoin(gen.User().On(func(w *gen.UserWhere) { w.NameContains("user") })).
		IsCloseEq(false).
		And(func(w *gen.BattleWhere) {
			w.IsDisplayEq(true).Or().Service(func(s *gen.ServiceWhere) { s.SeqGt(1000) })
		}).Using(ctx, db).Count()
	if err != nil {
		t.Fatal(err)
	}
	if cnt == 0 {
		t.Error("join count is zero")
	}

	page, err := gen.Battle().ServiceSeqEq(7).OrderBySeqAsc().Using(ctx, db).Paginate(2, 10)
	if err != nil || page.Total != 1000 || page.Pages != 100 || page.Items.Len() != 10 || page.Items.First().Seq != 1006 {
		t.Errorf("paginate: %+v err=%v", page, err)
	}

	// contains transform escapes % and _
	zero, err := gen.Battle().NameContains("%").Using(ctx, db).Count()
	if err != nil || zero != 0 {
		t.Errorf("contains escape: %d %v", zero, err)
	}

	// join result access
	j, err := gen.Battle().Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.SeqEq(7) })).SeqEq(6).Using(ctx, db).One()
	if err != nil || j == nil || j.GetService() == nil || j.GetService().Name != "service-7" {
		t.Errorf("joined row access: %v %+v", err, j)
	}
}

func TestStreamLifecycleAndRowOwnership(t *testing.T) {
	db := open(t)
	db.SQL.SetMaxOpenConns(1)
	ctx := context.Background()
	var kept []*gen.BattleRow
	result, err := gen.Battle().ServiceSeq(7).OrderBySeqAsc().Using(ctx, db).Stream(func(row *gen.BattleRow) bool {
		kept = append(kept, row)
		return len(kept) < 3
	})
	if err != nil || result.State != orm.StreamStopped || result.Count != 3 {
		t.Fatalf("stopped stream: result=%+v err=%v", result, err)
	}
	if len(kept) != 3 || kept[0] == kept[1] || kept[0].GetSeq() == kept[1].GetSeq() || kept[0].GetName() == "" {
		t.Fatalf("stream rows are not independently owned: %#v", kept)
	}
	if count, err := gen.Battle().ServiceSeq(7).Using(ctx, db).GetCount(); err != nil || count == 0 {
		t.Fatalf("cursor was not released after stop: count=%d err=%v", count, err)
	}

	result, err = gen.Battle().ServiceSeq(7).OrderBySeqAsc().Limit(0, 4).Using(ctx, db).Stream(func(*gen.BattleRow) bool { return true })
	if err != nil || result.State != orm.StreamExhausted || result.Count != 4 {
		t.Fatalf("exhausted stream: result=%+v err=%v", result, err)
	}
	if _, err := gen.Battle().Relation(gen.User()).Using(ctx, db).Stream(func(*gen.BattleRow) bool { return true }); err == nil || !strings.Contains(err.Error(), "IR_INVALID") {
		t.Fatalf("relation stream must fail before opening a cursor: %v", err)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if result, err := gen.Battle().Using(cancelled, db).Stream(func(*gen.BattleRow) bool { return true }); err == nil || !errors.Is(err, context.Canceled) || result.State != orm.StreamCancelled {
		t.Fatalf("cancelled stream: result=%+v err=%v", result, err)
	}
}

func TestRootFinderKeepsJoinAndRelation(t *testing.T) {
	db := open(t)
	ctx := context.Background()

	query := func() (*orm.Collection[gen.BattleRow], error) {
		return gen.Battle().
			SelectNone().
			Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.Name("service-7") })).
			Relation(gen.User()).
			OrderBySeqAsc().Limit(0, 2).Using(ctx, db).GetsByServiceSeq(7)
	}
	var direct []orm.Event
	db.Cfg().OnQuery = func(e orm.Event) { direct = append(direct, e) }
	got, err := query()
	if err != nil {
		t.Fatal(err)
	}

	var chained []orm.Event
	db.Cfg().OnQuery = func(e orm.Event) { chained = append(chained, e) }
	want, err := gen.Battle().
		SelectNone().
		Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.Name("service-7") })).
		Relation(gen.User()).
		ServiceSeq(7).
		OrderBySeqAsc().Limit(0, 2).Using(ctx, db).Gets()
	if err != nil {
		t.Fatal(err)
	}

	if len(direct) != len(chained) {
		t.Fatalf("finder changed statement count: direct=%d chained=%d", len(direct), len(chained))
	}
	for i := range direct {
		if direct[i].SQL != chained[i].SQL || !reflect.DeepEqual(direct[i].Args, chained[i].Args) {
			t.Errorf("finder changed statement %d:\ndirect:  %s %v\nchained: %s %v", i, direct[i].SQL, direct[i].Args, chained[i].SQL, chained[i].Args)
		}
	}
	if got.Len() != want.Len() {
		t.Fatalf("finder changed rows: direct=%d chained=%d", got.Len(), want.Len())
	}
	for i, a := range got.ToSlice() {
		b := want.ToSlice()[i]
		if a.Seq != b.Seq || a.ServiceSeq != b.ServiceSeq || a.UserSeq != b.UserSeq || a.GetService() == nil || b.GetService() == nil || a.GetService().Seq != b.GetService().Seq || a.GetUser() == nil || b.GetUser() == nil || a.GetUser().Seq != b.GetUser().Seq {
			t.Errorf("finder changed row %d: direct=%+v chained=%+v", i, a, b)
		}
	}

	countQuery := func() *gen.BattleQuery {
		return gen.Battle().
			SelectNone().
			Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.Name("service-7") })).
			Relation(gen.User())
	}
	var directCountEvents []orm.Event
	db.Cfg().OnQuery = func(e orm.Event) { directCountEvents = append(directCountEvents, e) }
	directCount, err := countQuery().Using(ctx, db).GetCountByServiceSeq(7)
	if err != nil {
		t.Fatal(err)
	}
	var chainedCountEvents []orm.Event
	db.Cfg().OnQuery = func(e orm.Event) { chainedCountEvents = append(chainedCountEvents, e) }
	chainedCount, err := countQuery().ServiceSeq(7).Using(ctx, db).GetCount()
	if err != nil {
		t.Fatal(err)
	}
	if directCount != chainedCount {
		t.Errorf("count finder changed value: direct=%d chained=%d", directCount, chainedCount)
	}
	if len(directCountEvents) != len(chainedCountEvents) {
		t.Fatalf("count finder changed statement count: direct=%d chained=%d", len(directCountEvents), len(chainedCountEvents))
	}
	for i := range directCountEvents {
		if directCountEvents[i].SQL != chainedCountEvents[i].SQL || !reflect.DeepEqual(directCountEvents[i].Args, chainedCountEvents[i].Args) {
			t.Errorf("count finder changed statement %d:\ndirect:  %s %v\nchained: %s %v", i, directCountEvents[i].SQL, directCountEvents[i].Args, chainedCountEvents[i].SQL, chainedCountEvents[i].Args)
		}
	}
}

func TestRelationPaths(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	// data: service 7 has 50 members (service_member.service_seq = 7) and 1 module; each user has 20 battles.
	var stmts []string
	db.Cfg().OnQuery = func(e orm.Event) { stmts = append(stmts, normSQL(e.SQL)) }

	// one relation off the root, many off a nested one, key_by + limit_per_parent + drop_child_key
	rows, err := gen.Battle().
		ServiceSeqEq(7).OrderBySeqAsc().Limit(0, 5).
		Relation(gen.User()).
		Relation(gen.Service().
			Relations(gen.ServiceMember().OrderBySeqDesc().LimitPerParent(3).KeyByUserSeq().DropChildKey())).Using(ctx, db).All()
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
	rows, err = gen.Battle().
		SeqIn([]int64{7, 8, 14}).OrderBySeqAsc().
		Relation(gen.User().IfParentIsCloseEq(true).Relations(gen.Battle().OrderBySeqAsc().LimitPerParent(2))).
		Join(gen.Service().Relations(gen.ServiceModule())).Using(ctx, db).All()
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
	none, err := gen.Battle().SeqEq(0).Relation(gen.User()).Using(ctx, db).All()
	if err != nil || none.Len() != 0 || len(stmts) != 1 {
		t.Errorf("empty parents: len=%d statements=%d err=%v", none.Len(), len(stmts), err)
	}
	one, err := gen.Battle().SeqEq(42).Relation(gen.Service().Relations(gen.ServiceMember().LimitPerParent(1))).Using(ctx, db).One()
	if err != nil || one == nil || one.Service == nil || one.Service.GetMembers().Len() != 1 {
		t.Errorf("one + relation: %+v %v", one, err)
	}
	// flatten: typed access is unchanged (array/JSON forms merge the child's columns)
	m, err := gen.ServiceMember().ServiceSeqEq(7).OrderBySeqAsc().Limit(0, 2).Relation(gen.User().Flatten()).Using(ctx, db).All()
	if err != nil || m.First().GetUser() == nil || m.First().User.Name != fmt.Sprintf("user-%d", m.First().UserSeq) {
		t.Errorf("flatten: %v %+v", err, m.First())
	}
	// paginate keeps relations
	page, err := gen.Battle().ServiceSeqEq(7).OrderBySeqAsc().Relation(gen.User()).Using(ctx, db).Paginate(1, 4)
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
		return gen.Battle().
			SetName("go-write").
			SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
			SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)).
			SetAesHexEmail(email).Using(ctx, tx).Insert()
	})
	if err != nil || created == nil || created.Seq == 0 || created.AesHexEmail == nil || *created.AesHexEmail != email {
		t.Fatalf("insert: %v %+v", err, created)
	}

	// update dirty columns only, optimistic
	created.SetName("go-write-2").SetLikeCount(5)
	if err := created.Using(ctx, db).UpdateOptimistic(); err != nil {
		t.Fatalf("update: %v", err)
	}
	again, _ := gen.Battle().Using(ctx, db).OneBySeq(created.Seq)
	if again.Name != "go-write-2" || again.LikeCount != 5 {
		t.Errorf("after update: %+v", again)
	}
	// stale optimistic value → OPTIMISTIC_LOCK
	created.SetName("stale")
	if err := created.Using(ctx, db).UpdateOptimistic(); err == nil || !strings.Contains(err.Error(), "OPTIMISTIC_LOCK") {
		t.Errorf("optimistic lock not detected: %v", err)
	}
	// plus/minus via draft-style update through query is S3; delete now
	if err := again.Using(ctx, db).Delete(); err != nil {
		t.Fatal(err)
	}
	if left, _ := gen.Battle().SeqEq(created.Seq).Using(ctx, db).Count(); left != 0 {
		t.Errorf("row not deleted")
	}
}

func TestCompositeCRUDRelationsAndPagination(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	const tenantID int64 = 910007
	_, _ = gen.CompositeMembership().TenantIdEq(tenantID).Using(ctx, db).Delete()
	_, _ = gen.CompositeAccount().TenantIdEq(tenantID).Using(ctx, db).Delete()
	t.Cleanup(func() {
		_, _ = gen.CompositeMembership().TenantIdEq(tenantID).Using(context.Background(), db).Delete()
		_, _ = gen.CompositeAccount().TenantIdEq(tenantID).Using(context.Background(), db).Delete()
	})
	for _, accountID := range []int64{11, 12} {
		row, err := gen.CompositeAccount().SetTenantId(tenantID).SetAccountId(accountID).SetName(fmt.Sprintf("account-%d", accountID)).Using(ctx, db).Insert()
		if err != nil || row == nil || row.TenantId != tenantID || row.AccountId != accountID {
			t.Fatalf("account insert %d: row=%#v err=%v", accountID, row, err)
		}
		member, err := gen.CompositeMembership().SetTenantId(tenantID).SetAccountId(accountID).SetRole("reader").Using(ctx, db).Insert()
		if err != nil || member == nil {
			t.Fatalf("membership insert %d: row=%#v err=%v", accountID, member, err)
		}
	}
	first, err := gen.CompositeMembership().Using(ctx, db).GetByTenantIdAndAccountId(tenantID, 11)
	if err != nil || first == nil {
		t.Fatalf("composite get: row=%#v err=%v", first, err)
	}
	first.SetRole("owner")
	if err := first.Update(); err != nil {
		t.Fatal(err)
	}
	second, err := gen.CompositeMembership().SetTenantId(tenantID).SetAccountId(12).SetRole("editor").Using(ctx, db).Save()
	if err != nil || second == nil || second.Role != "editor" {
		t.Fatalf("composite save: row=%#v err=%v", second, err)
	}
	page, err := gen.CompositeMembership().TenantIdEq(tenantID).OrderByTenantIdAsc().OrderByAccountIdAsc().Using(ctx, db).Paginate(1, 1)
	if err != nil || page.Total != 2 || page.Items.Len() != 1 || page.Items.First().AccountId != 11 {
		t.Fatalf("composite page=%#v err=%v", page, err)
	}
	accounts, err := gen.CompositeAccount().TenantIdEq(tenantID).OrderByAccountIdAsc().Relations(gen.CompositeMembership()).Using(ctx, db).Gets()
	if err != nil || accounts.Len() != 2 || accounts.First().GetMemberships().Len() != 1 {
		t.Fatalf("composite relation: rows=%#v err=%v", accounts, err)
	}
	rollback := errors.New("composite rollback")
	_, err = orm.Transaction(ctx, db, func(tx *orm.Tx) (struct{}, error) {
		if _, err := gen.CompositeAccount().SetTenantId(tenantID).SetAccountId(13).SetName("rollback").Using(ctx, tx).Insert(); err != nil {
			return struct{}{}, err
		}
		if _, err := gen.CompositeMembership().SetTenantId(tenantID).SetAccountId(13).SetRole("rollback").Using(ctx, tx).Insert(); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("composite rollback error: %v", err)
	}
	if count, err := gen.CompositeAccount().TenantIdEq(tenantID).AccountIdEq(13).Using(ctx, db).GetCount(); err != nil || count != 0 {
		t.Fatalf("composite rollback: count=%d err=%v", count, err)
	}
	if err := first.Delete(); err != nil {
		t.Fatal(err)
	}
	if count, err := gen.CompositeMembership().TenantIdEq(tenantID).Using(ctx, db).GetCount(); err != nil || count != 1 {
		t.Fatalf("composite delete: count=%d err=%v", count, err)
	}
}

// TestAggregatesHavingRawPredicates covers the S4 surface: countDistinct/min/max
// terminals (nil on no rows), having after groupBy, raw root, named predicates.
func TestAggregatesHavingRawPredicates(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	var stmts []string
	db.Cfg().OnQuery = func(e orm.Event) { stmts = append(stmts, normSQL(e.SQL)) }
	t.Cleanup(func() { db.Cfg().OnQuery = nil })

	// service 7 ⇔ seq ≡ 6 (mod 100), 1000 rows: min 6, max 99906
	mn, err := gen.Battle().ServiceSeqEq(7).Using(ctx, db).MinSeq()
	if err != nil || mn == nil || *mn != 6 {
		t.Errorf("min: %v %v", mn, err)
	}
	mx, err := gen.Battle().ServiceSeqEq(7).Using(ctx, db).MaxSeq()
	if err != nil || mx == nil || *mx != 99906 {
		t.Errorf("max: %v %v", mx, err)
	}
	if !strings.Contains(stmts[0], "SELECT MIN(`a`.`seq`)") || !strings.Contains(stmts[1], "SELECT MAX(`a`.`seq`)") {
		t.Errorf("min/max sql: %v", stmts)
	}
	// typed like the column: datetime → *time.Time
	dt, err := gen.Battle().ServiceSeqEq(7).Using(ctx, db).MaxStartDt()
	if err != nil || dt == nil || dt.IsZero() {
		t.Errorf("max datetime: %v %v", dt, err)
	}
	// no rows → nil, no error
	none, err := gen.Battle().SeqEq(0).Using(ctx, db).MinSeq()
	if err != nil || none != nil {
		t.Errorf("min on no rows: %v %v", none, err)
	}
	total, err := gen.Battle().ServiceSeqEq(7).Using(ctx, db).CountDistinctUserSeq()
	if err != nil || total <= 0 || total > 1000 {
		t.Errorf("count distinct: %d %v", total, err)
	}
	if !strings.Contains(stmts[len(stmts)-1], "COUNT(DISTINCT `a`.`user_seq`)") {
		t.Errorf("count distinct sql: %s", stmts[len(stmts)-1])
	}

	// count + groupBy = number of groups; having filters the groups
	groups, err := gen.Battle().ServiceSeqEq(7).GroupByUserSeq().Using(ctx, db).Count()
	if err != nil || groups != total {
		t.Errorf("group count %d != distinct users %d (%v)", groups, total, err)
	}
	stmts = nil
	multi, err := gen.Battle().ServiceSeqEq(7).GroupByUserSeq().
		Having(func(w *gen.BattleWhere) { w.Expr("COUNT(*) > ?", 1) }).Using(ctx, db).Count()
	if err != nil || multi < 0 || multi > groups {
		t.Errorf("having count: %d %v", multi, err)
	}
	if !strings.Contains(stmts[0], "GROUP BY `a`.`user_seq` HAVING (COUNT(*) > ?)") || !strings.Contains(stmts[0], "AS `orm_g`") {
		t.Errorf("having sql: %s", stmts[0])
	}
	// having without groupBy is an engine error
	if _, err := gen.Battle().Having(func(w *gen.BattleWhere) { w.Expr("COUNT(*) > ?", 1) }).Using(ctx, db).Count(); err == nil || !strings.Contains(err.Error(), "IR_INVALID") {
		t.Errorf("having needs group_by: %v", err)
	}

	// named predicates on the query and inside a where group
	visible, err := gen.Battle().Visible().ServiceSeqEq(7).Using(ctx, db).Count()
	if err != nil {
		t.Fatal(err)
	}
	manual, err := gen.Battle().IsCloseEq(false).IsDisplayEq(true).ServiceSeqEq(7).Using(ctx, db).Count()
	if err != nil || visible != manual || visible == 0 {
		t.Errorf("visible %d != manual %d (%v)", visible, manual, err)
	}
	after, err := gen.Battle().StartedAfter("2026-01-01 00:00:00").ServiceSeqEq(7).Using(ctx, db).Count()
	if err != nil || after <= 0 || after > 1000 {
		t.Errorf("started_after: %d %v", after, err)
	}
	stmts = nil
	grouped, err := gen.Battle().ServiceSeqEq(7).
		And(func(w *gen.BattleWhere) { w.Visible().Or().StartedAfter("2030-01-01 00:00:00") }).Using(ctx, db).Count()
	if err != nil || grouped != visible {
		t.Errorf("predicates in a group: %d vs %d (%v)", grouped, visible, err)
	}
	if !strings.Contains(stmts[0], "((`a`.`is_close` = FALSE AND `a`.`is_display` = TRUE) OR (`a`.`start_dt` > ?))") {
		t.Errorf("predicate group sql: %s", stmts[0])
	}

	// raw root: {table} substitution, binds in order, rows keyed by column name
	stmts = nil
	rows, err := gen.Battle().
		Raw("SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?", 7, false).Using(ctx, db).RawAll()
	if err != nil || len(rows) != 1 {
		t.Fatalf("raw: %v %v", rows, err)
	}
	if !strings.HasPrefix(stmts[0], "SELECT COUNT(*) AS n, MAX(seq) AS m FROM `battle` WHERE") {
		t.Errorf("raw sql: %s", stmts[0])
	}
	if n, ok := rows[0]["n"].(int64); !ok || n <= 0 {
		t.Errorf("raw n: %#v", rows[0]["n"])
	}
	if m, ok := rows[0]["m"].(int64); !ok || m != 99906 {
		t.Errorf("raw m: %#v", rows[0]["m"])
	}
	// empty result is an empty slice, never nil
	empty, err := gen.Battle().Raw("SELECT seq FROM {table} WHERE seq = ?", 0).Using(ctx, db).RawAll()
	if err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("raw empty: %#v %v", empty, err)
	}
	// placeholder/bind mismatch is an engine error (ormgen:ignore — the mismatch is the point)
	if _, err := gen.Battle().Raw("SELECT seq FROM {table} WHERE seq = ?").Using(ctx, db).RawAll(); err == nil || !strings.Contains(err.Error(), "IR_INVALID") {
		t.Errorf("raw arity: %v", err)
	}
}

func TestErrorSurface(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	if _, err := gen.Battle().SeqIn([]int64{}).Using(ctx, db).Count(); err == nil || !strings.Contains(err.Error(), "EMPTY_IN") {
		t.Errorf("EMPTY_IN: %v", err)
	}
}

// TestDeadlockRetry is the S3 deadlock gate: two transactions lock the same two
// rows in opposite order, MySQL kills one with 1213, and Transaction re-runs
// that closure until both commit.
func TestDeadlockRetry(t *testing.T) {
	if testDriver() == "sqlite" {
		t.Skip("SQLite has one writer: two transactions cannot interleave row locks (SQLITE_BUSY is mapped to DEADLOCK and re-run, but this scenario cannot happen)")
	}
	db := open(t)
	ctx := context.Background()
	insert := func(name string) *gen.BattleRow {
		t.Helper()
		r, err := gen.Battle().
			SetName(name).
			SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
			SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)).Using(ctx, db).Insert()
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	a, b := insert("dl-go-1"), insert("dl-go-2")
	t.Cleanup(func() {
		if n, err := gen.Battle().SeqIn([]int64{a.Seq, b.Seq}).Using(ctx, db).Delete(); err != nil || n != 2 {
			t.Errorf("cleanup: deleted %d, %v", n, err)
		}
	})

	var calls atomic.Int32
	// Both sides hold their first row before touching the second, so the second
	// updates close the lock cycle; only the first attempt synchronises.
	var locked sync.WaitGroup
	locked.Add(2)
	writer := func(tag int64, first, second int64) error {
		attempt := 0
		_, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (struct{}, error) {
			attempt++
			calls.Add(1)
			if _, err := gen.Battle().SeqEq(first).SetLikeCount(tag).Using(ctx, tx).Update(); err != nil {
				return struct{}{}, err
			}
			if attempt == 1 {
				locked.Done()
				locked.Wait()
			}
			_, err := gen.Battle().SeqEq(second).SetLikeCount(tag).Using(ctx, tx).Update()
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
	ra, _ := gen.Battle().Using(ctx, db).OneBySeq(a.Seq)
	rb, _ := gen.Battle().Using(ctx, db).OneBySeq(b.Seq)
	if ra.LikeCount != rb.LikeCount || (ra.LikeCount != 1 && ra.LikeCount != 2) {
		t.Errorf("last writer must own both rows: a=%d b=%d", ra.LikeCount, rb.LikeCount)
	}
}

// ---- S5 hardening ----

func codeOf(err error) string {
	var e *ir.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// TestSchemaHashCheck: Init compares the generated hash with the engine's
// manifest once; a different manifest is SCHEMA_HASH_MISMATCH and leaves the
// package bound to the previous engine.
func TestSchemaHashCheck(t *testing.T) {
	open(t)
	other := loadEngine(t)
	other.M.SchemaHash = "0000000000000000"
	err := gen.Init(other)
	if codeOf(err) != orm.CodeSchemaHashMismatch {
		t.Fatalf("Init with a foreign manifest: %v", err)
	}
	if !strings.Contains(err.Error(), gen.SchemaHash) || !strings.Contains(err.Error(), "0000000000000000") {
		t.Errorf("message must name both hashes: %v", err)
	}
	if gen.Battle().Req().IR.SchemaHash != gen.SchemaHash {
		t.Error("a failed Init must not rebind the package")
	}
}

// TestOpenConfig: orm.toml loads per docs/config.md; a relative path, a
// symlink, an unknown key and an unset aes_env are CONFIG errors.
func TestOpenConfig(t *testing.T) {
	if testDriver() != "mysql" {
		t.Skip("the config fixtures are MySQL DSNs")
	}
	d := dsn(t)
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	good := fmt.Sprintf("schema = %q\n[db]\ndsn = %q\npool = 2\n[secrets]\naes = \"bench-salt\"\n[debug]\non_query = false\n", schemaPath(t), d)
	bad := map[string]string{
		"relative": strings.Replace(good, schemaPath(t), "schema/schema.json", 1),
		"missing":  strings.Replace(good, schemaPath(t), filepath.Join(dir, "nope.json"), 1),
		"unknown":  good + "[db2]\nx = 1\n",
		"aes_env":  strings.Replace(good, "aes = \"bench-salt\"", "aes_env = \"ORM_TEST_UNSET_KEY\"", 1),
		"no_key":   strings.Replace(good, "aes = \"bench-salt\"", "", 1),
		"engine":   good + "[engine]\nwasm = \"/nonexistent/ormengine.wasm\"\n",
	}
	link := filepath.Join(dir, "schema-link.json")
	if err := os.Symlink(schemaPath(t), link); err == nil {
		bad["symlink"] = strings.Replace(good, schemaPath(t), link, 1)
	}
	for name, body := range bad {
		_, err := orm.OpenConfig(write(name+".toml", body))
		if codeOf(err) != orm.CodeConfig {
			t.Errorf("%s: want CONFIG, got %v", name, err)
		}
	}
	if _, err := orm.OpenConfig("orm.toml"); codeOf(err) != orm.CodeConfig {
		t.Errorf("relative config path: %v", err)
	}

	db, err := orm.OpenConfig(write("orm.toml", good))
	if err != nil {
		t.Fatal(err)
	}
	defer db.SQL.Close()
	if err := gen.Init(db.Eng); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	b, err := gen.Battle().Using(ctx, db).OneBySeq(42)
	if err != nil || b == nil || b.GetAesHexEmail() == nil || *b.GetAesHexEmail() != "user42@example.com" {
		t.Fatalf("query through OpenConfig: %v %v", err, b)
	}
	if n := db.SQL.Stats().MaxOpenConnections; n != 2 {
		t.Errorf("pool: %d", n)
	}
}

// TestDuplicateKey: MySQL 1062 surfaces as DUPLICATE_KEY with the driver's message kept.
func TestDuplicateKey(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	uuid := fmt.Sprintf("dup-go-%d", time.Now().UnixNano())
	draft := func() *gen.BattleQuery {
		return gen.Battle().SetName("dup-go").SetUuid(uuid).
			SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
			SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC))
	}
	r, err := draft().Using(ctx, db).Insert()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Using(ctx, db).Delete() })
	_, err = draft().Using(ctx, db).Insert()
	if codeOf(err) != orm.CodeDuplicateKey {
		t.Fatalf("want DUPLICATE_KEY, got %v", err)
	}
	if driverMsg := map[string]string{"mysql": "1062", "postgres": "23505", "sqlite": "UNIQUE"}[testDriver()]; !strings.Contains(err.Error(), driverMsg) {
		t.Errorf("driver message must be kept: %v", err)
	}
	if orm.IsDeadlock(err) {
		t.Error("a duplicate key is not a deadlock")
	}
}

// TestOnQueryEvent: the hook carries the plan id (stable per shape) and masks secret binds.
func TestOnQueryEvent(t *testing.T) {
	if testDriver() != "mysql" {
		t.Skip("secret slots exist only where AES runs in SQL (MySQL)")
	}
	db := open(t)
	ctx := context.Background()
	var events []orm.Event
	db.Cfg().OnQuery = func(e orm.Event) { events = append(events, e) }
	t.Cleanup(func() { db.Cfg().OnQuery = nil })
	for _, seq := range []int64{42, 43} {
		if _, err := gen.Battle().Using(ctx, db).OneBySeq(seq); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := gen.Battle().ServiceSeqEq(7).Using(ctx, db).Count(); err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Fatalf("events: %d", len(events))
	}
	if len(events[0].PlanID) != 16 || events[0].PlanID != events[1].PlanID || events[2].PlanID == events[0].PlanID {
		t.Errorf("plan ids: %q %q %q", events[0].PlanID, events[1].PlanID, events[2].PlanID)
	}
	if events[0].Duration <= 0 {
		t.Error("duration")
	}
	masked := 0
	for _, e := range events[:2] {
		for _, a := range e.Args {
			if a == "bench-salt" {
				t.Error("secret leaked into the hook payload")
			}
			if a == orm.Secret {
				masked++
			}
		}
	}
	if masked == 0 {
		t.Error("the aes select binds the key: expected $SECRET in the event")
	}
}
