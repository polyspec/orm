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

	// 세 언어가 같은 byte를 내도록 member 순서는 output이 고정하고 HTML 문자는
	// escape하지 않는다.
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	check(enc.Encode(output{
		Rows:       rows,
		Groups:     groups.Len(),
		ReadSum:    sum,
		LikeAvg:    avg,
		PageTotal:  page.TotalCount,
		PagePages:  page.TotalPages,
		PageLength: page.Items.Len(),
	}))
}

// output은 출력 문서의 member를 PHP와 Rust 프로그램과 같은 순서로 선언한다.
type output struct {
	Rows       any     `json:"rows"`
	Groups     int     `json:"groups"`
	ReadSum    float64 `json:"read_sum"`
	LikeAvg    float64 `json:"like_avg"`
	PageTotal  int64   `json:"page_total"`
	PagePages  int64   `json:"page_pages"`
	PageLength int     `json:"page_length"`
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
