//go:build featurecoverage

package model_test

import (
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageModelQueryRows counts, with the generated model, the authors in the seed bench database,
// reads them sorted, aggregates them, and reads users together with the declared match.
func TestCoverageModelQueryRows(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	if n := must(model.Author().Connect(db).UserSeq(1).GetCount()); n != 20 {
		t.Fatalf("author count with user_seq 1 = %d, want 20", n)
	}
	rows := must(model.Author().Connect(db).ServiceSeq(7).OrderBySeqDesc().Limit(0, 3).Gets())
	var names []string
	for _, b := range rows.Slice() {
		names = append(names, b.GetName())
	}
	if want := []string{"author-99906", "author-99806", "author-99706"}; !slices.Equal(names, want) {
		t.Fatalf("service_seq 7 by seq desc = %q, want %q", names, want)
	}
	if sum := must(model.Author().Connect(db).ServiceSeq(7).SumReadCount().GetSum()); sum != 456000 {
		t.Fatalf("read_count sum of service_seq 7 = %v, want 456000", sum)
	}
	author := must(model.Author().Connect(db).Relation(model.User().MatchUserSeqWithSeq()).GetBySeq(5000))
	if u := must(author.GetUserModel()); u == nil || u.GetName() != "user-1" {
		t.Fatalf("user of author 5000 = %+v, want user-1", u)
	}
}
