// A complex statement in every client language, one JSON document. Run:
//
//	go run ./examples/complex/go
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
)

// main ends with the exit code of run. Since os.Exit does not run defers, it is not called inside run: a failed
// check/dsn rises up to run as an exit panic, and the defers in between (closing connections) run.
func main() {
	os.Exit(run())
}

// exit is the panic by which check/dsn ends run, and its value is the exit code.
type exit int

func run() (code int) {
	defer func() {
		if recovered := recover(); recovered != nil {
			value, ok := recovered.(exit)
			if !ok {
				panic(recovered)
			}
			code = int(value)
		}
	}()
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

	// So that the three languages emit the same bytes, the output fixes the member order, and HTML characters
	// are not escaped.
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
	return 0
}

// output declares the members of the output document in the same order as the PHP and Rust programs.
type output struct {
	Rows       any     `json:"rows"`
	Groups     int     `json:"groups"`
	ReadSum    float64 `json:"read_sum"`
	LikeAvg    float64 `json:"like_avg"`
	PageTotal  int64   `json:"page_total"`
	PagePages  int64   `json:"page_pages"`
	PageLength int     `json:"page_length"`
}

// dsn is ORM_BENCH_MYSQL_DSN, which points to the seeded bench database. If it is missing or empty,
// the program does not connect; it prints that variable name and ends.
func dsn() string {
	v := os.Getenv("ORM_BENCH_MYSQL_DSN")
	if v == "" {
		fmt.Fprintln(os.Stderr, "ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run")
		panic(exit(1))
	}
	return v
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "complex:", err)
		panic(exit(1))
	}
}
