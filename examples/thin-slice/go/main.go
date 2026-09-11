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

	"github.com/polyspec/orm/clients/go/gen"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
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
	const aesKey = "bench-salt"
	db, err := orm.Open("mysql", dsn(), eng, orm.Config{
		AESKey: aesKey,
		OnQuery: func(e orm.Event) {
			lastSQL, lastArgs = e.SQL, e.Args
			// the hook masks secret binds; the native replay below needs the real key
			for i, a := range lastArgs {
				if a == orm.Secret {
					lastArgs[i] = aesKey
				}
			}
		},
	})
	check(err)
	check(gen.Init(eng))
	ctx := context.Background()
	now := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)

	query := func() (*orm.Collection[gen.BattleRow], error) {
		return gen.Battle().
			ServiceSeq(7).
			IsClose(false).
			And(func(w *gen.BattleWhere) {
				w.IsDisplay(true).Or().And(func(w *gen.BattleWhere) { w.IsDisplay(false).DisplayStartDtLt(now) })
			}).
			SeqIn([]int64{6, 106, 206, 306, 406}).
			OrderBySeqDesc().
			Limit(0, 3).Using(ctx, db).Gets()
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

// dsn is ORM_MYSQL_DSN_GO when set (CI), else the local socket.
func dsn() string {
	if v := os.Getenv("ORM_MYSQL_DSN_GO"); v != "" {
		return v
	}
	return "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true"
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
