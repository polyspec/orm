// A complex statement in three languages, one JSON document (docs/examples/complex-query.md
// shows the same product-domain shapes). Run:
//
//	go run ./examples/complex/go schema/schema.json
package main

import (
	"encoding/json"
	"fmt"
	"os"

	_ "github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/clients/go/gen"
	"github.com/polyspec/orm/clients/go/orm"
)

func main() {
	db, err := gen.Connect(dsn(), os.Args[1], orm.Config{AESKey: "bench-salt"})
	check(err)
	// A join carrying its own ON and WHERE, a root group mixing a predicate with
	// navigation into the joined entity, and three levels of relations with options.
	rows, err := gen.Battle().
		SelectNone().SelectName().
		Join(gen.Service().
			On(func(w *gen.ServiceWhere) { w.SeqGt(0) }).
			Where(func(w *gen.ServiceWhere) { w.Name("service-7") })).
		IsClose(false).
		And(func(w *gen.BattleWhere) {
			w.IsDisplay(true).Or().Service(func(s *gen.ServiceWhere) { s.Seq(7) })
		}).
		Relation(gen.User().
			Relations(gen.Battle().SelectNone().OrderBySeqDesc().LimitPerParent(2).DropChildKey())).
		Relation(gen.Service().
			Relations(gen.ServiceMember().SelectNone().OrderBySeqAsc().LimitPerParent(2).KeyByUserSeq())).
		OrderBySeqAsc().Limit(0, 2).Using(db).Gets()
	check(err)
	items := []any{}
	for _, b := range rows.All() {
		item, err := b.ToArray()
		check(err)
		items = append(items, item)
	}

	// Aggregates over the same slice of data: a grouped count with HAVING, min/max, distinct.
	groups, err := gen.Battle().ServiceSeq(7).GroupByUserSeq().
		Having(func(w *gen.BattleWhere) { w.Expr("COUNT(*) > ?", 1) }).Using(db).GetCount()
	check(err)
	min, err := gen.Battle().ServiceSeq(7).Using(db).MinSeq()
	check(err)
	max, err := gen.Battle().ServiceSeq(7).Using(db).MaxSeq()
	check(err)
	users, err := gen.Battle().ServiceSeq(7).Using(db).CountDistinctUserSeq()
	check(err)

	out, err := json.MarshalIndent(map[string]any{
		"rows":       items,
		"groups":     groups,
		"min_seq":    *min,
		"max_seq":    *max,
		"user_count": users,
	}, "", "  ")
	check(err)
	fmt.Println(string(out))
}

func dsn() string {
	if v := os.Getenv("ORM_MYSQL_DSN_GO"); v != "" {
		return v
	}
	return "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock&parseTime=true&clientFoundRows=true"
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "complex:", err)
		os.Exit(1)
	}
}
