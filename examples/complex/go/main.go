// A complex statement in three languages, one JSON document (docs/examples/complex-query.md
// shows the same shapes against the example schema). Run:
//
//	go run ./examples/complex/go schema/schema.json
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	_ "github.com/go-sql-driver/mysql"

	"github.com/maxkwon/orm/clients/go/gen"
	"github.com/maxkwon/orm/clients/go/orm"
	"github.com/maxkwon/orm/engine"
	"github.com/maxkwon/orm/engine/schema"
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
	rows, err := gen.NewBattle().
		SelectNone().SelectName().
		JoinService(gen.NewService().
			On(func(w *gen.ServiceWhere) { w.SeqGt(0) }).
			Where(func(w *gen.ServiceWhere) { w.NameEq("service-7") })).
		IsCloseEq(false).
		And(func(w *gen.BattleWhere) {
			w.IsDisplayEq(true).Or().Service(func(s *gen.ServiceWhere) { s.SeqEq(7) })
		}).
		RelationUser(gen.NewUser().
			RelationsBattles(gen.NewBattle().SelectNone().OrderBySeqDesc().LimitPerParent(2).DropChildKey())).
		RelationService(gen.NewService().
			RelationsMembers(gen.NewServiceMember().SelectNone().OrderBySeqAsc().LimitPerParent(2).KeyByUserSeq())).
		OrderBySeqAsc().Limit(0, 2).
		All(ctx, db)
	check(err)
	items := []any{}
	for _, b := range rows.All() {
		items = append(items, b.ToArray())
	}

	// Aggregates over the same slice of data: a grouped count with HAVING, min/max, distinct.
	groups, err := gen.NewBattle().ServiceSeqEq(7).GroupByUserSeq().
		Having(func(w *gen.BattleWhere) { w.Expr("COUNT(*) > ?", 1) }).Count(ctx, db)
	check(err)
	min, err := gen.NewBattle().ServiceSeqEq(7).MinSeq(ctx, db)
	check(err)
	max, err := gen.NewBattle().ServiceSeqEq(7).MaxSeq(ctx, db)
	check(err)
	users, err := gen.NewBattle().ServiceSeqEq(7).CountDistinctUserSeq(ctx, db)
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
