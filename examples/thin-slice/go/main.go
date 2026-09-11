// S1 demo (Go): one statement, three languages, one JSON.
// stdout: the result as JSON — byte-identical to the PHP and Rust demos.
// stderr: p50 of the generated client vs the same SQL through database/sql directly.
//
//	go run ./examples/thin-slice/go schema/schema.json
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"github.com/maxkwon/orm/clients/go/gen"
	"github.com/maxkwon/orm/clients/go/orm"
	"github.com/maxkwon/orm/engine"
	"github.com/maxkwon/orm/engine/schema"
)

const iterations = 500

func main() {
	js, err := os.ReadFile(os.Args[1])
	check(err)
	m, err := schema.Load(js)
	check(err)
	eng, err := engine.New(m, "mysql")
	check(err)
	var lastSQL string
	var lastArgs []any
	db, err := orm.Open("mysql", "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true", eng, orm.Config{
		AESKey:  "bench-salt",
		OnQuery: func(e orm.Event) { lastSQL, lastArgs = e.SQL, e.Args },
	})
	check(err)
	gen.Init(eng)
	ctx := context.Background()
	now := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)

	query := func() (*orm.Collection[gen.BattleRow], error) {
		return gen.NewBattle().
			ServiceSeqEq(7).
			IsCloseEq(false).
			And(func(w *gen.BattleWhere) {
				w.IsDisplayEq(true).Or().And(func(w *gen.BattleWhere) { w.IsDisplayEq(false).DisplayStartDtLt(now) })
			}).
			SeqIn([]int64{6, 106, 206, 306, 406}).
			OrderBySeqDesc().
			Limit(0, 3).
			All(ctx, db)
	}

	rows, err := query()
	check(err)
	out := []map[string]any{}
	for _, r := range rows.All() {
		out = append(out, map[string]any{"seq": r.Seq, "name": r.Name, "is_display": r.IsDisplay, "like_count": r.LikeCount})
	}
	b, err := json.Marshal(out)
	check(err)
	fmt.Println(string(b))

	client := p50(func() {
		_, err := query()
		check(err)
	})
	stmt, err := db.SQL.PrepareContext(ctx, lastSQL)
	check(err)
	native := p50(func() {
		rs, err := stmt.QueryContext(ctx, lastArgs...)
		check(err)
		cols, _ := rs.Columns()
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		for rs.Next() {
			check(rs.Scan(ptrs...))
		}
		rs.Close()
	})
	fmt.Fprintf(os.Stderr, "go: client p50 %dµs, native p50 %dµs (%d iterations)\n", client, native, iterations)
}

func p50(f func()) int64 {
	var s []int64
	for i := 0; i < iterations; i++ {
		t := time.Now()
		f()
		s = append(s, time.Since(t).Microseconds())
	}
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2]
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "demo:", err)
		os.Exit(1)
	}
}
