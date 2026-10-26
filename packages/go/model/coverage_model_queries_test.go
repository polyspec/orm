//go:build featurecoverage

package model_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageModelQueryRows counts, with the generated model, the authors in the seed bench database,
// reads them sorted, aggregates them, and reads users together with the declared match.
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30, INT-32, INT-33, PLN-11, PLN-25.
func TestCoverageModelQueryRows(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, driver, _ := connectFeature(t)
	if n := must(model.Author().Connect(db).UserSeq(1).GetCount()); n != 20 {
		t.Fatalf("author count with user_seq 1 = %d, want 20", n)
	}
	if row := must(model.Author().Connect(db).Seq(-1).Get()); row != nil {
		t.Fatalf("get for a missing author = %v, want nil", row)
	}
	rows := must(model.Author().Connect(db).ServiceSeq(7).OrderBySeqDesc().Limit(0, 3).Gets())
	var names []string
	for _, b := range rows.Slice() {
		names = append(names, readColumn(t, b.GetName))
	}
	if want := []string{"author-99906", "author-99806", "author-99706"}; !slices.Equal(names, want) {
		t.Fatalf("service_seq 7 by seq desc = %q, want %q", names, want)
	}
	page := must(model.Author().Connect(db).ServiceSeq(7).OrderBySeqDesc().GetsPage(1, 3))
	pageNames := make([]string, 0, page.Items.Len())
	for _, author := range page.Items.Slice() {
		pageNames = append(pageNames, readColumn(t, author.GetName))
	}
	count := must(model.Author().Connect(db).ServiceSeq(7).GetCount())
	if !slices.Equal(pageNames, names) || page.TotalCount != count {
		t.Fatalf("service_seq 7 first page = (%q, total %d), want (%q, total %d)", pageNames, page.TotalCount, names, count)
	}
	if sum := must(model.Author().Connect(db).ServiceSeq(7).SumReadCount().GetSum()); sum != 456000 {
		t.Fatalf("read_count sum of service_seq 7 = %v, want 456000", sum)
	}
	alias := must(model.Author().Connect(db).RemoveAllColumns().AddColumnStartDtAliasStartYear(orm.Year()).GetBySeq(42))
	aliasValues := alias.ToArray()
	if _, exists := aliasValues["StartYear"]; exists {
		t.Fatalf("computed alias retained its method name: %#v", aliasValues)
	}
	if got, ok := aliasValues["start_year"].(int64); !ok || got != 2026 {
		t.Fatalf("computed alias start_year = %#v (%T), want int64(2026)", aliasValues["start_year"], aliasValues["start_year"])
	}
	author := must(model.Author().Connect(db).Relation(model.User().MatchUserSeqWithSeq()).GetBySeq(5000))
	if u := must(author.GetUserModel()); u == nil || readColumn(t, u.GetName) != "user-1" {
		t.Fatalf("user of author 5000 = %+v, want user-1", u)
	}
	var joinSQL string
	unsubscribe, err := db.Subscribe(func(event orm.StatementEvent) error {
		if event.Kind == orm.KindSelect {
			joinSQL = event.SQL
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := must(model.Author().Connect(db).ServiceSeq(7).
		JoinServiceMemberSeqWithSeq(model.ServiceMember().ForceIndexIxServiceMemberService()).
		JoinUserSeqWithSeq(model.User().
			AddColumnReadTotal(func(u *model.UserModel) orm.Model {
				return model.Author().SumReadCount().UserSeqEqSeq(u)
			}).
			OrderBySeqDesc()).
		Gets())
	unsubscribe()
	if driver == "sqlite" && !strings.Contains(joinSQL, `INDEXED BY "ix_service_member_service"`) {
		t.Fatalf("joined table forceIndex SQL = %q", joinSQL)
	}
	if driver == "mysql" && !strings.Contains(joinSQL, "FORCE INDEX (`ix_service_member_service`)") {
		t.Fatalf("joined table forceIndex SQL = %q", joinSQL)
	}
	joinedRows := joined.Slice()
	if len(joinedRows) == 0 {
		t.Fatal("joined query returned no authors")
	}
	var priorUserSeq int64
	first := true
	for _, row := range joinedRows {
		user := must(row.GetUserModel())
		if user == nil {
			t.Fatal("joined user is missing")
		}
		userSeq := readColumn(t, user.GetSeq)
		if !first && userSeq > priorUserSeq {
			t.Fatalf("joined user order = %d after %d, want descending", userSeq, priorUserSeq)
		}
		first = false
		priorUserSeq = userSeq
		readTotal := must(orm.AsInt64(user.GetReadTotal()))
		wantTotal := must(model.Author().Connect(db).UserSeq(userSeq).SumReadCount().GetSum())
		if float64(readTotal) != wantTotal {
			t.Fatalf("joined aggregate read_total = %d, want %v", readTotal, wantTotal)
		}
	}
}

// TestCoverageGroupRowsDatabase runs the shared grouped-row assertions on the selected database.
// Requirements: INT-31.
func TestCoverageGroupRowsDatabase(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	checkGroupRowsDatabase(t, db)
}

// Requirements: DSL-76.
func TestCoverageModelRemoveColumns(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	row := must(model.Author().Connect(db).RemoveAllColumns().AddColumnName().GetBySeq(42))
	values := row.ToArray()
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	want := []string{"name", "seq", "service_member_seq", "service_region_seq", "service_seq", "user_seq"}
	if !slices.Equal(keys, want) {
		t.Fatalf("removeAllColumns plus name keys = %q, want %q", keys, want)
	}
}
