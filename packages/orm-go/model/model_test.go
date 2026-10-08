package model_test

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/orm-go/model"
	"github.com/polyspec/orm/packages/orm-go/orm"
	_ "github.com/polyspec/orm/packages/orm-go/orm/pg"
	_ "github.com/polyspec/orm/packages/orm-go/orm/sqlite"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/internal/testdb"
)

// databases returns a case database of its own (internal/testdb) for SQLite,
// MySQL and PostgreSQL with the schema installed: a new SQLite file and new
// databases on the servers of ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN,
// dropped when the test ends. The test fails when either DSN is unset.
func databases(t *testing.T) map[string]*orm.DB {
	t.Helper()
	out := map[string]*orm.DB{}
	manifest := model.Schema
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		dsn := testdb.New(t, driver)
		if driver == "sqlite" {
			dsn += "?_pragma=busy_timeout(5000)"
		}
		db, err := model.Connect(dsn, orm.Config{AESKey: "test-aes-key", BlindIndexKey: "test-blind-key"})
		if err != nil {
			t.Fatalf("%s: %v", driver, err)
		}
		t.Cleanup(func() { db.Close() })
		dsns.Store(db, dsn)
		if err := db.Utils().Schema().Install(manifest); err != nil {
			t.Fatalf("%s install: %v", driver, err)
		}
		out[driver] = db
	}
	return out
}

// openNative opens the database of a client DSN through the native
// database/sql driver.
func openNative(t *testing.T, driver, dsn string) *sql.DB {
	t.Helper()
	return testdb.Open(t, driver, dsn)
}

func each(t *testing.T, fn func(t *testing.T, db *orm.DB)) {
	for driver, db := range databases(t) {
		t.Run(driver, func(t *testing.T) { fn(t, db) })
	}
}

// must returns v; an error fails the test through the panic it raises.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

type fixture struct {
	service *model.ServiceModel
	member  *model.ServiceMemberModel
	module  *model.ServiceRegionModel
	users   []*model.UserModel
	authors []*model.AuthorModel
}

var start = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

func seed(t *testing.T, db *orm.DB) fixture {
	t.Helper()
	var f fixture
	f.service = must(model.Service().Connect(db).SetName("service").Create())
	for _, name := range []string{"kim", "lee", "park"} {
		f.users = append(f.users, must(model.User().Connect(db).SetName(name).Create()))
	}
	f.module = must(model.ServiceRegion().Connect(db).SetServiceSeq(f.service.GetSeq()).SetName("module").Create())
	f.member = must(model.ServiceMember().Connect(db).SetServiceSeq(f.service.GetSeq()).SetUserSeq(f.users[0].GetSeq()).Create())
	for i, name := range []string{"alpha", "beta", "gamma", "delta"} {
		cover := "cover-" + name
		b := model.Author().Connect(db).
			SetName(name).
			SetUserSeq(f.users[i%2].GetSeq()).
			SetServiceSeq(f.service.GetSeq()).
			SetServiceRegionSeq(f.module.GetSeq()).
			SetServiceMemberSeq(f.member.GetSeq()).
			SetStartDt(start.Add(time.Duration(i) * time.Hour)).
			SetEndDt(start.Add(48 * time.Hour)).
			SetReadCount(int32(i * 10)).
			SetIsClose(i%2 == 1)
		if i < 2 {
			b.SetPhotoUrl(&cover)
		}
		f.authors = append(f.authors, must(b.Create()))
	}
	return f
}

func names(c *orm.Collection[*model.AuthorModel]) string {
	var out []string
	for _, b := range c.Slice() {
		out = append(out, b.GetName())
	}
	return strings.Join(out, ",")
}

func TestConditions(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		svc := f.service.GetSeq()
		rows := must(model.Author().Connect(db).
			ServiceSeq(svc).
			AndIsClose(false).
			Or().IsClose(true).
			OrderBySeqAsc().
			Gets())
		if names(rows) != "alpha,beta,gamma,delta" {
			t.Fatalf("connectors: %s", names(rows))
		}
		rows = must(model.Author().Connect(db).
			ServiceSeq(svc).
			And(func(q *model.AuthorModel) { q.GeReadCount(10).AndLtReadCount(30).Or().Name("alpha") }).
			OrderByReadCountDescAndSeqAsc().
			Gets())
		if names(rows) != "gamma,beta,alpha" {
			t.Fatalf("group: %s", names(rows))
		}
		rows = must(model.Author().Connect(db).GetsBySeqAndNeName([]int64{f.authors[0].GetSeq(), f.authors[1].GetSeq()}, "beta"))
		if names(rows) != "alpha" {
			t.Fatalf("getsBy list: %s", names(rows))
		}
		if n := must(model.Author().Connect(db).PhotoUrl(orm.Null).GetCount()); n != 2 {
			t.Fatalf("null: %d", n)
		}
		if n := must(model.Author().Connect(db).NePhotoUrl(orm.Null).AndLkName("lph").GetCount()); n != 1 {
			t.Fatalf("not null and like: %d", n)
		}
		if n := must(model.Author().Connect(db).BetweenReadCount([2]int{10, 20}).GetCount()); n != 2 {
			t.Fatalf("between: %d", n)
		}
		if n := must(model.Author().Connect(db).GtStartDt(start.Add(90 * time.Minute)).GetCount()); n != 2 {
			t.Fatalf("time compare: %d", n)
		}
		one := must(model.Author().Connect(db).GetByName("gamma"))
		if one == nil || one.GetReadCount() != 20 {
			t.Fatalf("getBy: %+v", one)
		}
		if none, err := model.Author().Connect(db).GetByName("missing"); none != nil || orm.ErrorCode(err) != orm.CodeNoRows {
			t.Fatalf("get without a row: %v, %v; want NO_ROWS", none, err)
		}
		q := model.Author().Connect(db).ServiceSeq(svc)
		first := must(q.GetCountByIsClose(true))
		second := must(q.GetCount())
		if first != 2 || second != 4 {
			t.Fatalf("terminal changed the model: %d %d", first, second)
		}
		atLeast := must(model.Author().Connect(db).GeReadCount(20).GetCount())
		if atLeast != 2 {
			t.Fatalf("ge: %d", atLeast)
		}
		_, err := model.Author().Connect(db).Name("a").IsClose(true).Gets()
		if orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("missing connector: %v", err)
		}
		_, err = model.Author().Connect(db).Name("a").And().Gets()
		if orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("dangling connector: %v", err)
		}
		_, err = model.Author().Connect(db).Seq([]int64{}).Gets()
		if orm.ErrorCode(err) != orm.CodeEmptyIn {
			t.Fatalf("empty list: %v", err)
		}
		stmt := must(model.Author().Connect(db).Name("alpha").GetQuery())
		if !strings.Contains(stmt.SQL, "name") || len(stmt.Binds) != 1 {
			t.Fatalf("getQuery: %+v", stmt)
		}
		if _, err := model.Author().Name("alpha").Gets(); orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("no connection: %v", err)
		}
	})
}

func TestGetMissingReturnsNoRows(t *testing.T) {
	testcase.Start(t, testcase.Database)
	path := filepath.Join(t.TempDir(), "model.sqlite")
	db, err := model.Connect("sqlite://"+path, orm.Config{AESKey: "test-aes-key", BlindIndexKey: "test-blind-key"})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	manifest := model.Schema
	if err := db.Utils().Schema().Install(manifest); err != nil {
		t.Fatal(err)
	}
	row, err := model.User().Connect(db).Seq(999999999).Get()
	if row != nil {
		t.Fatalf("missing row returned a model: %#v", row)
	}
	if orm.ErrorCode(err) != orm.CodeNoRows {
		t.Fatalf("missing row error code = %q, error = %v", orm.ErrorCode(err), err)
	}
}

func TestJoinsAndRelations(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		author := model.User().
			On(func(u *model.UserModel) { u.NeName("nobody") }).
			Name("kim")
		rows := must(model.Author().Connect(db).
			LeftJoinUserSeqWithSeq(author).
			ServiceSeq(f.service.GetSeq()).
			And(func(q *model.AuthorModel) { q.Name("delta").Or(author) }).
			OrderBySeqAsc().
			Gets())
		if names(rows) != "alpha,gamma,delta" {
			t.Fatalf("placed join conditions: %s", names(rows))
		}
		if u := must(rows.First().GetUserModel()); u == nil || u.GetName() != "kim" {
			t.Fatalf("join result: %+v", u)
		}
		member := model.ServiceMember()
		cmp := must(model.Author().Connect(db).
			JoinServiceMemberSeqWithSeq(member).
			ReadCountGtSeq(member).
			GetCount())
		if cmp != 3 {
			t.Fatalf("column comparison with a joined model: %d", cmp)
		}

		writer := model.User().MatchUserSeqWithSeq().AliasWriter()
		loaded := must(model.Author().Connect(db).
			Relation(writer).
			Relations(model.ServiceMember().MatchServiceSeqWithServiceSeq().AliasMembers()).
			Relation(model.ServiceRegion().MatchServiceRegionSeqWithSeq()).
			OrderBySeqAsc().
			Gets())
		b := loaded.First()
		if w := must(b.GetWriter()); w == nil || w.GetName() != "kim" {
			t.Fatalf("relation alias: %+v", w)
		}
		if members, module := must(b.GetMembers()), must(b.GetServiceRegionModel()); members.Len() != 1 || module.GetName() != "module" {
			t.Fatalf("relations: %d %+v", members.Len(), module)
		}
		limited := must(model.User().Connect(db).
			Relations(model.Author().MatchSeqWithUserSeq().OrderBySeqDesc().GroupLimit(1)).
			OrderBySeqAsc().
			Gets())
		if got := must(limited.First().GetAuthorModels()); got.Len() != 1 || got.First().GetName() != "gamma" {
			t.Fatalf("groupLimit: %s", names(got))
		}
		other := must(model.Connect(dsnOf(t, db), orm.Config{}))
		defer other.Close()
		external := must(model.Author().Connect(db).
			Relation(model.User().Connect(other).MatchUserSeqWithSeq().AliasOwner()).
			GetByName("beta"))
		if owner := must(external.GetOwner()); owner == nil || owner.GetName() != "lee" {
			t.Fatalf("relation on another connection: %+v", owner)
		}
		if _, err := model.Author().Connect(db).JoinUserSeqWithSeq(model.User().Connect(db)).Gets(); orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("join child with connection: %v", err)
		}
		if _, err := model.Author().Connect(db).Name("a").Or(model.User()).Gets(); orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("unjoined model placement: %v", err)
		}
		array := b.ToArray()
		if array["writer"] == nil || array["name"] != "alpha" {
			t.Fatalf("toArray: %v", array)
		}
	})
}

var dsns sync.Map

func dsnOf(t *testing.T, db *orm.DB) string {
	t.Helper()
	v, ok := dsns.Load(db)
	if !ok {
		t.Fatal("connection DSN is not recorded")
	}
	return v.(string)
}

func TestColumnsAndSubqueries(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		users := must(model.User().Connect(db).
			AddColumnReadTotal(func(u *model.UserModel) orm.Model {
				return model.Author().SumReadCount().UserSeqEqSeq(u)
			}).
			Seq(model.Author().AddColumnUserSeq().IsClose(false)).
			OrderBySeqAsc().
			Gets())
		if users.Len() != 1 {
			t.Fatalf("subquery IN: %d", users.Len())
		}
		u := users.First()
		if must(orm.AsInt64(u.GetReadTotal())) != 20 {
			t.Fatalf("added column: %v", u.GetReadTotal())
		}
		sum := must(model.Author().Connect(db).ServiceSeq(f.service.GetSeq()).SumReadCount().GetSum())
		avg := must(model.Author().Connect(db).ServiceSeq(f.service.GetSeq()).AvgReadCount().GetAvg())
		if sum != 60 || avg != 15 {
			t.Fatalf("aggregates: %v %v", sum, avg)
		}
		grouped := must(model.Author().Connect(db).GroupByIsClose().GetsCount())
		if grouped.Len() != 2 {
			t.Fatalf("getsCount: %d", grouped.Len())
		}
		counts := map[bool]int64{}
		for row := range grouped.All() {
			value, err := row.Value("is_close")
			if err != nil {
				t.Fatal(err)
			}
			closed, ok := value.(bool)
			if !ok {
				t.Fatalf("grouped boolean has type %T", value)
			}
			if _, err := row.Value("name"); orm.ErrorCode(err) != orm.CodeColumnUnselected {
				t.Fatalf("unselected grouped model column error = %v", err)
			}
			counts[closed] = row.Count()
		}
		if counts[false] != 2 || counts[true] != 2 {
			t.Fatalf("grouped counts: %#v", counts)
		}
		page := must(model.Author().Connect(db).OrderBySeqAsc().GetsPage(2, 3))
		if page.TotalCount != 4 || page.TotalPages != 2 || page.Items.Len() != 1 || page.Items.First().GetName() != "delta" {
			t.Fatalf("page: %+v", page)
		}
		keyed := must(model.Author().Connect(db).KeyNameName().Gets())
		if got, err := keyed.Get("beta"); err != nil || got == nil {
			t.Fatal("keyName")
		}
		memberships := []*model.CompositeMembershipModel{
			model.CompositeMembership().SetTenantId(1).SetAccountId(10).SetRole("owner"),
			model.CompositeMembership().SetTenantId(1).SetAccountId(11).SetRole("member"),
			model.CompositeMembership().SetTenantId(2).SetAccountId(10).SetRole("member"),
		}
		for _, a := range []int64{10, 11} {
			for _, tenant := range []int64{1, 2} {
				must(model.CompositeAccount().Connect(db).SetTenantId(tenant).SetAccountId(a).SetName("n").Create())
			}
		}
		if n := must(model.CompositeMembership().Connect(db).Creates(memberships)); n != 3 {
			t.Fatalf("creates: %d", n)
		}
		pairs := must(model.CompositeMembership().Connect(db).
			TupleTenantIdWithAccountId([]model.CompositeMembershipTenantIdWithAccountId{{TenantId: 1, AccountId: 10}, {TenantId: 2, AccountId: 10}}).
			GetCount())
		if pairs != 2 {
			t.Fatalf("tuple: %d", pairs)
		}
	})
}

func TestWrites(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		b := must(model.Author().Connect(db).GetBySeq(f.authors[0].GetSeq()))
		must(b.SetName("renamed").PlusReadCount(5).Update(true))
		again := must(model.Author().Connect(db).GetBySeq(b.GetSeq()))
		if again.GetName() != "renamed" || again.GetReadCount() != 5 {
			t.Fatalf("update: %s %d", again.GetName(), again.GetReadCount())
		}
		if _, err := b.SetName("stale").Update(true); orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("optimistic update without a fresh version: %v", err)
		}
		must(again.SetName("again").Update())
		if _, err := b.SetName("x").Update(); err != nil {
			t.Fatal(err)
		}
		item := must(model.Account().Connect(db).SetName("acc").NewLabel("shown").Create())
		if item.GetLabel() != "shown" || item.ToArray()["label"] != "shown" {
			t.Fatalf("new value: %v", item.ToArray())
		}
		saved := must(model.Account().Connect(db).SetSeq(item.GetSeq()).SetName("saved").Save())
		if saved.GetName() != "saved" || must(model.Account().Connect(db).GetBySeq(item.GetSeq())).GetName() != "saved" {
			t.Fatal("save as update")
		}
		if err := must(model.Author().Connect(db).GetBySeq(f.authors[3].GetSeq())).Delete(); err != nil {
			t.Fatal(err)
		}
		if n := must(model.Author().Connect(db).GetCount()); n != 3 {
			t.Fatalf("delete: %d", n)
		}
		rows := must(model.Author().Connect(db).IsClose(true).Gets())
		if err := rows.Delete(); err != nil {
			t.Fatal(err)
		}
		if n := must(model.Author().Connect(db).GetCount()); n != 2 {
			t.Fatalf("collection delete: %d", n)
		}
		up := model.CompositeAccount().Connect(db).SetTenantId(9).SetAccountId(9).SetName("first")
		must(up.Create())
		must(model.CompositeAccount().Connect(db).SetTenantId(9).SetAccountId(9).SetName("first").
			Duplication(model.CompositeAccount().SetName("second")).Create())
		if got := must(model.CompositeAccount().Connect(db).GetByTenantIdAndAccountId(9, 9)); got.GetName() != "second" {
			t.Fatalf("duplication: %s", got.GetName())
		}
	})
}

func TestTransactions(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		boom := errors.New("boom")
		err := db.Transaction(func() error {
			if _, err := model.User().SetName("rolled back").Create(); err != nil {
				return err
			}
			return boom
		})
		if !errors.Is(err, boom) || must(model.User().Connect(db).GetCount()) != 0 {
			t.Fatalf("rollback: %v", err)
		}
		err = db.Transaction(func() error {
			if _, err := model.User().SetName("outer").Create(); err != nil {
				return err
			}
			inner := db.Transaction(func() error {
				if _, err := model.User().SetName("inner").Create(); err != nil {
					return err
				}
				return boom
			})
			if !errors.Is(inner, boom) {
				return inner
			}
			if n, err := model.User().GetCount(); err != nil || n != 1 {
				t.Errorf("savepoint rollback: %d %v", n, err)
			}
			if _, err := model.User().Name("outer").ForUpdate().Gets(); err != nil {
				return err
			}
			if err := db.Utils().Lock("users"); err != nil {
				return err
			}
			if err := db.Utils().SetLocal("ormtest.actor", "tester"); err != nil {
				return err
			}
			if v, err := db.Utils().Local("ormtest.actor"); err != nil || v != "tester" {
				t.Errorf("local: %q %v", v, err)
			}
			if _, err := db.Utils().Local("ormtest.missing"); orm.ErrorCode(err) != orm.CodeNoRows {
				t.Errorf("missing local: %v", err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := model.User().GetCount()
				done <- err
			}()
			if err := <-done; orm.ErrorCode(err) != orm.CodeConfig {
				t.Errorf("goroutine inherited the transaction: %v", err)
			}
			return nil
		}, orm.Isolation(orm.ReadCommitted), orm.Retry(0))
		if err != nil {
			t.Fatal(err)
		}
		if n := must(model.User().Connect(db).GetCount()); n != 1 {
			t.Fatalf("commit: %d", n)
		}
		if _, err := model.User().Connect(db).ForUpdate().Gets(); orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("lock outside a transaction: %v", err)
		}
		if err := db.Utils().Lock("x"); orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("lock utility outside a transaction: %v", err)
		}
		attempts := 0
		err = db.Transaction(func() error {
			attempts++
			if attempts < 3 {
				return orm.TransactionConflict("retry")
			}
			return nil
		})
		if err != nil || attempts != 3 {
			t.Fatalf("retry: %d %v", attempts, err)
		}
		empty := must(db.Utils().Schema().Empty())
		installed := must(db.Utils().Schema().Installed("public", "user"))
		_ = installed
		if empty {
			t.Fatal("schema().empty() on an installed schema")
		}
		if db.Utils().Stats().OpenConnections < 1 {
			t.Fatal("stats")
		}
	})
}

func TestAESRotation(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		email := "person@example.com"
		b := must(model.Author().Connect(db).GetBySeq(f.authors[0].GetSeq()))
		must(b.SetAesHexEmail(&email).Update())
		keyring, err := orm.NewAESKeyring(map[int32]string{1: "test-aes-key", 2: "next-aes-key"}, 2)
		if err != nil {
			t.Fatal(err)
		}
		status := must(db.Utils().Aes().Status(model.Author(), keyring))
		if status.Total != 4 || status.Pending != 4 {
			t.Fatalf("status: %+v", status)
		}
		if n := must(db.Utils().Aes().Rotate(model.Author(), keyring)); n != 4 {
			t.Fatalf("rotated %d", n)
		}
		status = must(db.Utils().Aes().Status(model.Author(), keyring))
		if status.Pending != 0 {
			t.Fatalf("after rotation: %+v", status)
		}
	})
}
