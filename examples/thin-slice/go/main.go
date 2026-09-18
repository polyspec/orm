// Thin-slice demo (Go): one statement in every client language, one JSON.
// stdout: the result as JSON. stderr: p50 of the generated client and of the
// same SQL through database/sql directly.
//
//	go run ./examples/thin-slice/go schema/schema.json
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

const iterations = 500

func main() {
	const aesKey = "bench-salt"
	var lastSQL string
	var lastArgs []any
	db, err := model.Connect(dsn(), os.Args[1], orm.Config{
		AESKey:        aesKey,
		BlindIndexKey: "bench-blind-index",
		OnQuery: func(e orm.Event) {
			lastSQL, lastArgs = e.SQL, e.Args
			for i, a := range lastArgs {
				if a == orm.Secret {
					lastArgs[i] = aesKey
				}
			}
		},
	})
	check(err)
	defer db.Close()
	now := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)

	query := func() (*orm.Collection[*model.BattleModel], error) {
		return model.Battle().Connect(db).
			ServiceSeq(7).
			AndIsClose(false).
			And(func(q *model.BattleModel) {
				q.IsDisplay(true).Or(func(q *model.BattleModel) { q.IsDisplay(false).AndLtDisplayStartDt(now) })
			}).
			AndSeq([]int64{6, 106, 206, 306, 406}).
			OrderBySeqDesc().
			Limit(0, 3).
			Gets()
	}

	rows, err := query()
	check(err)
	out := []map[string]any{}
	for _, r := range rows.Slice() {
		out = append(out, map[string]any{"seq": r.GetSeq(), "name": r.GetName(), "is_display": r.GetIsDisplay(), "like_count": r.GetLikeCount()})
	}
	b, err := json.Marshal(out)
	check(err)
	fmt.Println(string(b))

	client := p50(func() {
		_, err := query()
		check(err)
	})
	raw, err := sql.Open("mysql", nativeDSN(dsn()))
	check(err)
	defer raw.Close()
	stmt, err := raw.PrepareContext(context.Background(), lastSQL)
	check(err)
	native := p50(func() {
		rs, err := stmt.Query(lastArgs...)
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

func dsn() string {
	if v := os.Getenv("ORM_BENCH_MYSQL_DSN"); v != "" {
		return v
	}
	return "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock"
}

func nativeDSN(raw string) string {
	u, err := url.Parse(raw)
	check(err)
	cfg := mysql.NewConfig()
	cfg.User = u.User.Username()
	cfg.Passwd, _ = u.User.Password()
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	cfg.Net, cfg.Addr = "tcp", u.Host
	if socket := u.Query().Get("socket"); socket != "" {
		cfg.Net, cfg.Addr = "unix", socket
	}
	return cfg.FormatDSN()
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
