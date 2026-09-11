// A complex statement in three languages, one JSON document (docs/examples/complex-query.md
// shows the same product-domain shapes). Run:
//
//	go run ./examples/complex/go schema/schema.json
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	_ "github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/clients/go/gen"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

func main() {
	js, err := os.ReadFile(os.Args[1])
	check(err)
	m, err := schema.Load(js)
	check(err)
	eng, err := engine.New(m, "mysql")
	check(err)
	db, err := orm.Open("mysql", dsn(), eng, orm.Config{AESKey: "bench-salt"})
	check(err)
	check(gen.Init(eng))
	ctx := context.Background()

	// A join carrying its own ON and WHERE, a root group mixing a predicate with
	// navigation into the joined entity, and three levels of relations with options.
	rows, err := gen.Battle().
		SelectNone().SelectName().
		JoinService(gen.Service().
			On(func(w *gen.ServiceWhere) { w.SeqGt(0) }).
			Where(func(w *gen.ServiceWhere) { w.Name("service-7") })).
		IsClose(false).
		And(func(w *gen.BattleWhere) {
			w.IsDisplay(true).Or().Service(func(s *gen.ServiceWhere) { s.Seq(7) })
		}).
		RelationUser(gen.User().
			RelationsBattles(gen.Battle().SelectNone().OrderBySeqDesc().LimitPerParent(2).DropChildKey())).
		RelationService(gen.Service().
			RelationsMembers(gen.ServiceMember().SelectNone().OrderBySeqAsc().LimitPerParent(2).KeyByUserSeq())).
		OrderBySeqAsc().Limit(0, 2).Bind(ctx, db).Gets()
	check(err)
	items := []any{}
	for _, b := range rows.All() {
		item, err := b.ToArray()
		check(err)
		items = append(items, item)
	}

	// Aggregates over the same slice of data: a grouped count with HAVING, min/max, distinct.
	groups, err := gen.Battle().ServiceSeq(7).GroupByUserSeq().
		Having(func(w *gen.BattleWhere) { w.Expr("COUNT(*) > ?", 1) }).Bind(ctx, db).GetCount()
	check(err)
	min, err := gen.Battle().ServiceSeq(7).Bind(ctx, db).MinSeq()
	check(err)
	max, err := gen.Battle().ServiceSeq(7).Bind(ctx, db).MaxSeq()
	check(err)
	users, err := gen.Battle().ServiceSeq(7).Bind(ctx, db).CountDistinctUserSeq()
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
	return "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true"
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "complex:", err)
		os.Exit(1)
	}
}
