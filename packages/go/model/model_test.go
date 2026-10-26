package model_test

import (
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"

	"github.com/polyspec/orm/packages/go/internal/benchset"
	"github.com/polyspec/orm/packages/go/internal/testassert"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/testcase"
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
		if driver == "sqlite" {
			dsn += "?_pragma=busy_timeout(5000)"
		}
		db, err := model.Connect(dsn, orm.Config{AESKey: "test-aes-key", BlindIndexKey: "test-blind-key"})
		if err != nil {
			t.Fatalf("%s: %v", driver, err)
		}
		t.Cleanup(func() { testcase.Close(t, db) })
		dsns.Store(db, dsn)
		if err := benchset.Install(db); err != nil {
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
	testcase.Start(t, testcase.Database)
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
	testcase.Start(t, testcase.Database)
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

func TestGetMissingReturnsNil(t *testing.T) {
	testcase.Start(t, testcase.Database)
	path := filepath.Join(t.TempDir(), "model.sqlite")
	db, err := model.Connect("sqlite://"+path, orm.Config{AESKey: "test-aes-key", BlindIndexKey: "test-blind-key"})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)
	if err := benchset.Install(db); err != nil {
		t.Fatal(err)
	}
	row, err := model.User().Connect(db).Seq(999999999).Get()
	if row != nil {
		t.Fatalf("missing row returned a model: %#v", row)
	}
	if err != nil {
		t.Fatalf("missing row error = %v, want nil", err)
	}
}

// Requirements: DBS-118, PLN-10, PLN-35, PLN-41, PLN-42, PLN-43.
func TestJoinsAndRelations(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		author := model.User().
			On(func(u *model.UserModel) { u.NeName("nobody") }).
			Name("kim")
		rows := must(model.Author().Connect(db).
			LeftJoinUserSeqWithSeq(author).
			ServiceSeq(readColumn(t, f.service.GetSeq)).
			And(func(q *model.AuthorModel) { q.Name("delta").Or(author) }).
			OrderBySeqAsc().
			Gets())
		if names(t, rows) != "alpha,gamma,delta" {
			t.Fatalf("placed join conditions: %s", names(t, rows))
		}
		if u := must(rows.First().GetUserModel()); u == nil || readColumn(t, u.GetName) != "kim" {
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
		if w := must(b.GetWriter()); w == nil || readColumn(t, w.GetName) != "kim" {
			t.Fatalf("relation alias: %+v", w)
		}
		if members, module := must(b.GetMembers()), must(b.GetServiceRegionModel()); members.Len() != 1 || readColumn(t, module.GetName) != "module" {
			t.Fatalf("relations: %d %+v", members.Len(), module)
		}
		limited := must(model.User().Connect(db).
			Relations(model.Author().MatchSeqWithUserSeq().OrderBySeqDesc().GroupLimit(1)).
			OrderBySeqAsc().
			Gets())
		if got := must(limited.First().GetAuthorModels()); got.Len() != 1 || readColumn(t, got.First().GetName) != "gamma" {
			t.Fatalf("groupLimit: %s", names(t, got))
		}
		other := must(model.Connect(dsnOf(t, db), orm.Config{}))
		defer testcase.Close(t, other)
		external := must(model.Author().Connect(db).
			Relation(model.User().Connect(other).MatchUserSeqWithSeq().AliasOwner()).
			GetByName("beta"))
		if owner := readColumn(t, external.GetOwner); owner == nil || readColumn(t, owner.GetName) != "lee" {
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
	s, isString := v.(string)
	if !isString {
		t.Fatalf("connection DSN recorded as %T, want string", v)
	}
	return s
}

// Requirements: PLN-8, PLN-9, PLN-14.
// TestInsertWithoutIdentityOnEveryDatabase inserts a row of a table with a composite key and no identity column on every
// database: the insert succeeds where the driver reports no insert id (pgx on PostgreSQL), since only a driver that
// reports one is asked for it.
func TestInsertWithoutIdentityOnEveryDatabase(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		row := must(model.CompositeAccount().Connect(db).SetTenantId(1).SetAccountId(10).SetName("n").Create())
		if readColumn(t, row.GetAccountId) != 10 {
			t.Fatalf("created account %d, want 10", readColumn(t, row.GetAccountId))
		}
	})
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
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		b := must(model.Author().Connect(db).GetBySeq(readColumn(t, f.authors[0].GetSeq)))
		must(b.SetName("renamed").PlusReadCount(5).Update(true))
		again := must(model.Author().Connect(db).GetBySeq(readColumn(t, b.GetSeq)))
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
		if got := must(model.CompositeAccount().Connect(db).GetByTenantIdAndAccountId(9, 9)); readColumn(t, got.GetName) != "second" {
			t.Fatalf("duplication: %s", readColumn(t, got.GetName))
		}
	})
}

// TestTransactions runs a transaction with its savepoint, lock, local and retry calls. A goroutine started inside the
// callback has no active transaction, so an unconnected model there returns CONFIG.
// Requirements: PLN-13, PLN-16, PLN-17, PLN-18, PLN-20, PLN-21, DSL-122, INT-51, INT-59, INT-61, INT-73, INT-134.
func TestTransactions(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		checkPrivilegeOperations(t, db)
		if db.Utils().Aes() == nil || db.Utils().Privileges() == nil || db.Utils().Schema() == nil {
			t.Fatal("connection utilities are missing a group")
		}
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

func checkPrivilegeOperations(t *testing.T, db *orm.DB) {
	t.Helper()
	privileges := db.Utils().Privileges()
	if db.Driver() != "postgres" {
		for _, operation := range []func() error{
			func() error { return privileges.GrantTable("public.user", "ormtest_privilege") },
			func() error { _, err := privileges.InspectTable("public.user"); return err },
			func() error { return privileges.RevokeTable("public.user", "SELECT", "ormtest_privilege") },
		} {
			if err := operation(); orm.ErrorCode(err) != orm.CodeCapabilityUnsupported {
				t.Fatalf("%s privilege operation = %v, want CAPABILITY_UNSUPPORTED", db.Driver(), err)
			}
		}
		return
	}
	const table = "public.privilege_probe"
	raw := openNative(t, "postgres", dsnOf(t, db))
	tableCreated := false
	roleCreated := false
	role := "orm_priv_" + testdb.Name()
	defer func() {
		if roleCreated {
			if _, err := raw.ExecContext(t.Context(), "DROP OWNED BY \""+role+"\""); err != nil {
				t.Errorf("drop owned privileges for %s: %v", role, err)
			}
			if _, err := raw.ExecContext(t.Context(), "DROP ROLE \""+role+"\""); err != nil {
				t.Errorf("drop role %s: %v", role, err)
			}
		}
		if tableCreated {
			if _, err := raw.ExecContext(t.Context(), `DROP TABLE "privilege_probe"`); err != nil {
				t.Errorf("drop privilege probe table: %v", err)
			}
		}
		if err := raw.Close(); err != nil {
			t.Errorf("close privilege probe connection: %v", err)
		}
	}()
	if _, err := raw.ExecContext(t.Context(), `CREATE TABLE "privilege_probe" ("id" INTEGER)`); err != nil {
		t.Fatal(err)
	}
	tableCreated = true
	got, err := privileges.InspectTable(table)
	if err != nil || !got.Select || !got.Insert || !got.Update || !got.Delete || !got.Truncate {
		t.Fatalf("postgres owner privileges = %+v, %v", got, err)
	}
	if _, err := raw.ExecContext(t.Context(), "CREATE ROLE \""+role+"\""); err != nil {
		t.Fatal(err)
	}
	roleCreated = true
	if err := privileges.GrantTable(table, role); err != nil {
		t.Fatal(err)
	}
	var schemaUsage, selectPrivilege, insertPrivilege, updatePrivilege, deletePrivilege bool
	if err := raw.QueryRowContext(t.Context(), "SELECT has_schema_privilege($1, 'public', 'USAGE'), has_table_privilege($1, 'public.privilege_probe', 'SELECT'), has_table_privilege($1, 'public.privilege_probe', 'INSERT'), has_table_privilege($1, 'public.privilege_probe', 'UPDATE'), has_table_privilege($1, 'public.privilege_probe', 'DELETE')", role).Scan(&schemaUsage, &selectPrivilege, &insertPrivilege, &updatePrivilege, &deletePrivilege); err != nil {
		t.Fatal(err)
	}
	if !schemaUsage || !selectPrivilege || !insertPrivilege || !updatePrivilege || !deletePrivilege {
		t.Fatalf("granted role privileges: schemaUsage=%t select=%t insert=%t update=%t delete=%t", schemaUsage, selectPrivilege, insertPrivilege, updatePrivilege, deletePrivilege)
	}
	if err := privileges.RevokeTable(table, " select ", role); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRowContext(t.Context(), "SELECT has_table_privilege($1, 'public.privilege_probe', 'SELECT'), has_table_privilege($1, 'public.privilege_probe', 'INSERT'), has_table_privilege($1, 'public.privilege_probe', 'UPDATE'), has_table_privilege($1, 'public.privilege_probe', 'DELETE')", role).Scan(&selectPrivilege, &insertPrivilege, &updatePrivilege, &deletePrivilege); err != nil {
		t.Fatal(err)
	}
	if selectPrivilege || !insertPrivilege || !updatePrivilege || !deletePrivilege {
		t.Fatalf("privileges after SELECT revoke: select=%t insert=%t update=%t delete=%t", selectPrivilege, insertPrivilege, updatePrivilege, deletePrivilege)
	}
}

// Requirements: COD-8, PLN-44, INT-60, INT-75, INT-131.
func TestAESRotation(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		email := "person@example.com"
		phone := "01012345678"
		b := must(model.Author().Connect(db).GetBySeq(readColumn(t, f.authors[0].GetSeq)))
		must(b.SetAesHexEmail(&email).SetAesHexPhone(&phone).Update())
		keyring, err := orm.NewAESKeyring(map[int32]string{1: "test-aes-key", 2: "next-aes-key"}, 2)
		if err != nil {
			t.Fatal(err)
		}
		status := must(db.Utils().Aes().Status(model.Author(), keyring))
		if status.Current != 2 || status.Total != 4 || status.Pending != 4 || !reflect.DeepEqual(status.Versions, map[int32]int64{1: 4}) {
			t.Fatalf("status: %+v", status)
		}
		if n := must(db.Utils().Aes().Rotate(model.Author(), keyring)); n != 4 {
			t.Fatalf("rotated %d", n)
		}
		status = must(db.Utils().Aes().Status(model.Author(), keyring))
		if status.Current != 2 || status.Total != 4 || status.Pending != 0 || !reflect.DeepEqual(status.Versions, map[int32]int64{2: 4}) {
			t.Fatalf("after rotation: %+v", status)
		}
		current, err := model.Connect(dsnOf(t, db), orm.Config{
			AESKey: "next-aes-key", AESVersion: 2, AESKeys: map[int32]string{2: "next-aes-key"},
			BlindIndexKey: "test-blind-key",
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { testcase.Close(t, current) })
		rotated := must(model.Author().Connect(current).GetBySeq(readColumn(t, f.authors[0].GetSeq)))
		gotEmail := readColumn(t, rotated.GetAesHexEmail)
		gotPhone := readColumn(t, rotated.GetAesHexPhone)
		if gotEmail == nil || *gotEmail != email || gotPhone == nil || *gotPhone != phone {
			t.Fatalf("rotated AES values: email=%v phone=%v", gotEmail, gotPhone)
		}
	})
}

// TestDuplicateRelationNamesTheAliasCall: two unaliased relations of one child entity have one result name, and the CONFIG message names that
// result and the alias call (CPX-5).
func TestDuplicateRelationNamesTheAliasCall(t *testing.T) {
	testcase.Start(t, testcase.Database)
	each(t, func(t *testing.T, db *orm.DB) {
		_, err := model.Author().Connect(db).
			Relation(model.User().MatchUserSeqWithSeq()).
			Relation(model.User().MatchUserSeqWithSeq()).
			Gets()
		if orm.ErrorCode(err) != orm.CodeConfig {
			t.Fatalf("duplicate relation: want CONFIG, got %v", err)
		}
		if msg := err.Error(); !strings.Contains(msg, "user_model") || !strings.Contains(msg, "alias") {
			t.Fatalf("CONFIG message does not name user_model and the alias call: %s", msg)
		}
	})
}
