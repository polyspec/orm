package model_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/legacy/packages/go/model"
	"github.com/polyspec/orm/legacy/packages/go/orm"
	_ "github.com/polyspec/orm/legacy/packages/go/orm/pg"
	_ "github.com/polyspec/orm/legacy/packages/go/orm/sqlite"

	"github.com/polyspec/orm/legacy/packages/go/internal/benchset"
	"github.com/polyspec/orm/legacy/packages/go/internal/testassert"
	"github.com/polyspec/orm/legacy/packages/go/internal/testdb"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// databases returns a case database of its own (internal/testdb) for SQLite,
// MySQL and PostgreSQL with the schema installed: a new SQLite file and new
// databases on the servers of ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN,
// dropped when the test ends. The test fails when either DSN is unset.
func databases(t *testing.T) map[string]*orm.DB {
	t.Helper()
	out := map[string]*orm.DB{}
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		dsn := testdb.New(t, driver)
		db, err := model.Connect(dsn, orm.Config{AESKey: "test-aes-key", BlindIndexKey: "test-blind-key"})
		if err != nil {
			t.Fatalf("%s: %v", driver, err)
		}
		t.Cleanup(func() { testcase.Close(t, db) })
		if err := benchset.Install(db); err != nil {
			t.Fatalf("%s install: %v", driver, err)
		}
		out[driver] = db
	}
	return out
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

func readColumn[T any](t *testing.T, getter func() (T, error)) T {
	return testassert.ReadColumn(t, getter)
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
	f.module = must(model.ServiceRegion().Connect(db).SetServiceSeq(readColumn(t, f.service.GetSeq)).SetName("module").Create())
	f.member = must(model.ServiceMember().Connect(db).SetServiceSeq(readColumn(t, f.service.GetSeq)).SetUserSeq(readColumn(t, f.users[0].GetSeq)).Create())
	for i, name := range []string{"alpha", "beta", "gamma", "delta"} {
		cover := "cover-" + name
		b := model.Author().Connect(db).
			SetName(name).
			SetUserSeq(readColumn(t, f.users[i%2].GetSeq)).
			SetServiceSeq(readColumn(t, f.service.GetSeq)).
			SetServiceRegionSeq(readColumn(t, f.module.GetSeq)).
			SetServiceMemberSeq(readColumn(t, f.member.GetSeq)).
			SetStartDt(start.Add(time.Duration(i) * time.Hour).Format(time.DateTime)).
			SetEndDt(start.Add(48 * time.Hour).Format(time.DateTime)).
			SetReadCount(int32(i * 10)).
			SetIsClose(i%2 == 1)
		if i < 2 {
			b.SetPhotoUrl(&cover)
		}
		f.authors = append(f.authors, must(b.Create()))
	}
	return f
}

func names(t *testing.T, c *orm.Collection[*model.AuthorModel]) string {
	var out []string
	for _, b := range c.Slice() {
		out = append(out, readColumn(t, b.GetName))
	}
	return strings.Join(out, ",")
}

// Requirements: DSL-60, PLN-6, PLN-7, PLN-16, PLN-23, PLN-28, PLN-30, PLN-34, PLN-37, PLN-38, PLN-39.
func TestConditions(t *testing.T) {
	testcase.Start(t)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		svc := readColumn(t, f.service.GetSeq)
		rows := must(model.Author().Connect(db).
			ServiceSeq(svc).
			AndIsClose(false).
			Or().IsClose(true).
			OrderBySeqAsc().
			Gets())
		if names(t, rows) != "alpha,beta,gamma,delta" {
			t.Fatalf("connectors: %s", names(t, rows))
		}
		rows = must(model.Author().Connect(db).
			ServiceSeq(svc).
			And(func(q *model.AuthorModel) { q.GeReadCount(10).AndLtReadCount(30).Or().Name("alpha") }).
			OrderByReadCountDescAndSeqAsc().
			Gets())
		if names(t, rows) != "gamma,beta,alpha" {
			t.Fatalf("group: %s", names(t, rows))
		}
		rows = must(model.Author().Connect(db).GetsBySeqAndNeName([]int64{readColumn(t, f.authors[0].GetSeq), readColumn(t, f.authors[1].GetSeq)}, "beta"))
		if names(t, rows) != "alpha" {
			t.Fatalf("getsBy list: %s", names(t, rows))
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
		if n := must(model.Author().Connect(db).GtStartDt(start.Add(90 * time.Minute).Format(time.DateTime)).GetCount()); n != 2 {
			t.Fatalf("time compare: %d", n)
		}
		one := must(model.Author().Connect(db).GetByName("gamma"))
		if one == nil || readColumn(t, one.GetReadCount) != 20 {
			t.Fatalf("getBy: %+v", one)
		}
		if none, err := model.Author().Connect(db).GetByName("missing"); none != nil || err != nil {
			t.Fatalf("get without a row: %v, %v; want nil, nil", none, err)
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

// Requirements: PLN-30.
func TestGoConstructorForms(t *testing.T) {
	testcase.Start(t)
	each(t, func(t *testing.T, db *orm.DB) {
		created := must(model.User().Connect(db).SetName("constructor-form").Create())
		rebound := created.Connect(db)
		if rebound != created {
			t.Fatal("connected loaded row did not return itself")
		}
		must(rebound.SetName("constructor-form-rebound").Update())
		loaded := must(model.User().Connect(db).GetBySeq(readColumn(t, created.GetSeq)))
		if loaded == nil || readColumn(t, loaded.GetName) != "constructor-form-rebound" {
			t.Fatalf("connected loaded row update: %+v", loaded)
		}
	})
}

// Requirements: PLN-8, PLN-9, PLN-14.
func TestColumnsAndSubqueries(t *testing.T) {
	testcase.Start(t)
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
		sum := must(model.Author().Connect(db).ServiceSeq(readColumn(t, f.service.GetSeq)).SumReadCount().GetSum())
		avg := must(model.Author().Connect(db).ServiceSeq(readColumn(t, f.service.GetSeq)).AvgReadCount().GetAvg())
		if sum != 60 || avg == nil || *avg != 15 {
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
		if page.TotalCount != 4 || page.TotalPages != 2 || page.Items.Len() != 1 || readColumn(t, page.Items.First().GetName) != "delta" {
			t.Fatalf("page: %+v", page)
		}
		var pageEvents []orm.StatementEvent
		unsubscribe, err := db.Subscribe(func(event orm.StatementEvent) error {
			pageEvents = append(pageEvents, event)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		writer := model.User().MatchUserSeqWithSeq().AliasWriter()
		pageWithRelations := must(model.Author().Connect(db).
			Relation(writer).
			Relations(model.ServiceMember().MatchServiceSeqWithServiceSeq().AliasMembers()).
			OrderBySeqAsc().GetsPage(1, 2))
		unsubscribe()
		if pageWithRelations.TotalCount != 4 || pageWithRelations.Items.Len() != 2 {
			t.Fatalf("page with relations: total %d items %d", pageWithRelations.TotalCount, pageWithRelations.Items.Len())
		}
		var pageEventTables [][]string
		for _, event := range pageEvents {
			pageEventTables = append(pageEventTables, event.Tables)
		}
		wantPageEventTables := [][]string{{"author"}, {"author"}, {"user"}, {"service_member"}}
		eventsMatch := len(pageEventTables) == len(wantPageEventTables)
		if eventsMatch {
			for i := range pageEventTables {
				if !slices.Equal(pageEventTables[i], wantPageEventTables[i]) {
					eventsMatch = false
					break
				}
			}
		}
		if !eventsMatch {
			t.Fatalf("page statement tables = %v, want rows, count, writer relation, members relation: %v", pageEventTables, wantPageEventTables)
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
		if n := must(model.CompositeMembership().Connect(db).Creates(memberships, 2)); n != 3 {
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

// Requirements: PLN-12, PLN-27.
func TestWrites(t *testing.T) {
	testcase.Start(t)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		b := must(model.Author().Connect(db).GetBySeq(readColumn(t, f.authors[0].GetSeq)))
		must(b.SetName("renamed").PlusReadCount(5).Update(true))
		again := must(model.Author().Connect(db).AddColumnName().AddColumnReadCount().GetBySeq(readColumn(t, b.GetSeq)))
		if readColumn(t, again.GetName) != "renamed" || readColumn(t, again.GetReadCount) != 5 {
			t.Fatalf("update: %s %d", readColumn(t, again.GetName), readColumn(t, again.GetReadCount))
		}
		// Requirements: DSL-155.
		if _, err := b.SetName("stale").Update(true); orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("optimistic update without a fresh version: %v", err)
		}
		must(again.SetName("again").Update())
		if _, err := b.SetName("x").Update(); err != nil {
			t.Fatal(err)
		}
		// Requirements: DSL-115.
		item := must(model.Account().Connect(db).SetName("acc").NewLabel("shown").Create())
		if item.GetLabel() != "shown" || item.ToArray()["label"] != "shown" {
			t.Fatalf("new value: %v", item.ToArray())
		}
		saved := must(model.Account().Connect(db).SetSeq(readColumn(t, item.GetSeq)).SetName("saved").Save())
		itemSeq := readColumn(t, item.GetSeq)
		if readColumn(t, saved.GetName) != "saved" || readColumn(t, must(model.Account().Connect(db).GetBySeq(itemSeq)).GetName) != "saved" {
			t.Fatal("save as update")
		}
		if err := must(model.Author().Connect(db).GetBySeq(readColumn(t, f.authors[3].GetSeq))).Delete(); err != nil {
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
		if got := must(model.CompositeAccount().Connect(db).AddColumnName().GetByTenantIdAndAccountId(9, 9)); readColumn(t, got.GetName) != "second" {
			t.Fatalf("duplication: %s", readColumn(t, got.GetName))
		}
	})
}

// TestTransactions holds that a goroutine started inside the callback has no active transaction, so an unconnected model
// there returns CONFIG. A recipe step runs in one flow, so this form of Go stays native (FCV-2).
// Requirements: PLN-18, DSL-122.
func TestTransactions(t *testing.T) {
	testcase.Start(t)
	each(t, func(t *testing.T, db *orm.DB) {
		err := db.Transaction(func() error {
			done := make(chan error, 1)
			go func() {
				_, err := model.User().GetCount()
				done <- err
			}()
			if err := <-done; orm.ErrorCode(err) != orm.CodeConfig {
				t.Errorf("goroutine inherited the transaction: %v", err)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	})
}
