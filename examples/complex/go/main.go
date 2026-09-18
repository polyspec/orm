// A complex statement in every client language, one JSON document. Run:
//
//	go run ./examples/complex/go schema/schema.json
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

func main() {
	db, err := model.Connect(dsn(), os.Args[1], orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	check(err)
	defer db.Close()

	// A join child with its own ON conditions whose WHERE conditions are placed
	// in a group, and two levels of relations with options.
	service := model.Service().
		On(func(s *model.ServiceModel) { s.GtSeq(0) }).
		Name("service-7")
	rows, err := model.Battle().Connect(db).
		RemoveAllColumns().AddColumnName().
		JoinServiceSeqWithSeq(service).
		IsClose(false).
		And(func(q *model.BattleModel) { q.IsDisplay(true).Or(service) }).
		Relation(model.User().MatchUserSeqWithSeq().
			Relations(model.Battle().MatchSeqWithUserSeq().RemoveAllColumns().OrderBySeqDesc().GroupLimit(2))).
		Relation(model.Service().MatchServiceSeqWithSeq().AliasOwnerService().
			Relations(model.ServiceMember().MatchSeqWithServiceSeq().RemoveAllColumns().OrderBySeqAsc().GroupLimit(2).KeyNameUserSeq())).
		OrderBySeqAsc().
		Limit(0, 2).
		Gets()
	check(err)

	// Aggregates over the same data: grouped counts, a sum, an average, and a page.
	groups, err := model.Battle().Connect(db).ServiceSeq(7).GroupByUserSeq().GetsCount()
	check(err)
	sum, err := model.Battle().Connect(db).ServiceSeq(7).SumReadCount().GetSum()
	check(err)
	avg, err := model.Battle().Connect(db).ServiceSeq(7).AvgLikeCount().GetAvg()
	check(err)
	page, err := model.Battle().Connect(db).ServiceSeq(7).RemoveAllColumns().OrderBySeqAsc().GetsPage(2, 10)
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

func dsn() string {
	if v := os.Getenv("ORM_BENCH_MYSQL_DSN"); v != "" {
		return v
	}
	return "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock"
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "complex:", err)
		os.Exit(1)
	}
}
