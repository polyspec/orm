// A complex statement in every client language, one JSON document. Run:
//
//	go run ./examples/complex/go
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

func main() {
	db, err := model.Connect(dsn(), orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	check(err)
	defer db.Close()

	// A join child with its own ON conditions whose WHERE conditions are placed
	// in a group, and two levels of relations with options.
	service := model.Service().
		On(func(s *model.ServiceModel) { s.GtSeq(0) }).
		Name("service-7")
	rows, err := model.Author().Connect(db).
		RemoveAllColumns().AddColumnName().
		JoinServiceSeqWithSeq(service).
		IsClose(false).
		And(func(q *model.AuthorModel) { q.IsDisplay(true).Or(service) }).
		Relation(model.User().MatchUserSeqWithSeq().
			Relations(model.Author().MatchSeqWithUserSeq().RemoveAllColumns().OrderBySeqDesc().GroupLimit(2))).
		Relation(model.Service().MatchServiceSeqWithSeq().AliasOwnerService().
			Relations(model.ServiceMember().MatchSeqWithServiceSeq().RemoveAllColumns().OrderBySeqAsc().GroupLimit(2).KeyNameUserSeq())).
		OrderBySeqAsc().
		Limit(0, 2).
		Gets()
	check(err)

	// Aggregates over the same data: grouped counts, a sum, an average, and a page.
	groups, err := model.Author().Connect(db).ServiceSeq(7).GroupByUserSeq().GetsCount()
	check(err)
	sum, err := model.Author().Connect(db).ServiceSeq(7).SumReadCount().GetSum()
	check(err)
	avg, err := model.Author().Connect(db).ServiceSeq(7).AvgLikeCount().GetAvg()
	check(err)
	page, err := model.Author().Connect(db).ServiceSeq(7).RemoveAllColumns().OrderBySeqAsc().GetsPage(2, 10)
	check(err)

	out, err := json.MarshalIndent(map[string]any{
		"rows":        rows,
		"groups":      groups.Len(),
		"read_sum":    sum,
		"like_avg":    avg,
		"page_total":  page.TotalCount,
		"page_pages":  page.TotalPages,
		"page_length": page.Items.Len(),
	}, "", "  ")
	check(err)
	fmt.Println(string(out))
}

// dsn은 시드된 bench database를 가리키는 ORM_BENCH_MYSQL_DSN이다. 없거나 비어
// 있으면 연결하지 않고 그 변수 이름을 출력하며 끝난다.
func dsn() string {
	v := os.Getenv("ORM_BENCH_MYSQL_DSN")
	if v == "" {
		fmt.Fprintln(os.Stderr, "ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database")
		os.Exit(1)
	}
	return v
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "complex:", err)
		os.Exit(1)
	}
}
