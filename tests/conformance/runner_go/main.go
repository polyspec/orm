// Conformance runner (Go). Runs every vector against the local MySQL and prints
// {"<vector>": {"statements": [{"sql", "binds"}], "result": …}} — the PHP and
// Rust runners print the same document for the same chains.
//
// Usage: runner_go <schema.json>
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"github.com/maxkwon/orm/clients/go/gen"
	"github.com/maxkwon/orm/clients/go/orm"
	"github.com/maxkwon/orm/engine"
	"github.com/maxkwon/orm/engine/ir"
	"github.com/maxkwon/orm/engine/schema"
)

type stmt struct {
	SQL   string `json:"sql"`
	Binds []any  `json:"binds"`
}

type vector struct {
	Statements []stmt `json:"statements"`
	Result     any    `json:"result"`
}

var (
	log     []stmt
	maskSeq int64
	maskTs  time.Time
)

func fmtTime(t time.Time) string {
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02 15:04:05")
	}
	return t.Format("2006-01-02 15:04:05.000000")
}

// norm renders a bound value the way every runner does: ints as numbers,
// datetimes as canonical strings, the write cycle's row identity masked.
func norm(v any) any {
	switch x := v.(type) {
	case int:
		return norm(int64(x))
	case int32:
		return norm(int64(x))
	case int64:
		if maskSeq != 0 && x == maskSeq {
			return "$SEQ"
		}
		return x
	case time.Time:
		if !maskTs.IsZero() && x.Equal(maskTs) {
			return "$TS"
		}
		return fmtTime(x)
	case []byte:
		if len(x) > 0 && x[0] == 0x78 { // zlib stream (gz style): bytes differ per zlib implementation
			return "$ZLIB"
		}
		return string(x)
	}
	return v
}

func code(err error) any {
	var e *ir.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return err.Error()
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: runner_go <schema.json>")
		os.Exit(2)
	}
	js, err := os.ReadFile(os.Args[1])
	if err != nil {
		fail(err)
	}
	m, err := schema.Load(js)
	if err != nil {
		fail(err)
	}
	eng, err := engine.New(m, "mysql")
	if err != nil {
		fail(err)
	}
	db, err := orm.Open("mysql", "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true", eng, orm.Config{
		AESKey: "bench-salt",
		OnQuery: func(e orm.Event) {
			binds := make([]any, len(e.Args))
			for i, a := range e.Args {
				binds[i] = norm(a)
			}
			log = append(log, stmt{SQL: e.SQL, Binds: binds})
		},
	})
	if err != nil {
		fail(err)
	}
	gen.Init(eng)
	ctx := context.Background()
	out := map[string]vector{}

	run := func(name string, fn func() (any, error)) {
		log = nil
		res, err := fn()
		if err != nil {
			res = map[string]any{"error": code(err)}
		}
		out[name] = vector{Statements: append([]stmt{}, log...), Result: res}
	}
	row := func(b *gen.BattleRow) any {
		if b == nil {
			return nil
		}
		return map[string]any{
			"seq": b.Seq, "name": b.Name, "aes_hex_email": b.AesHexEmail, "is_close": b.IsClose, "is_display": b.IsDisplay,
			"description": b.Description, "start_dt": fmtTime(b.StartDt), "like_count": b.LikeCount,
		}
	}
	keyed := func(c *orm.Collection[gen.BattleRow]) any {
		items := []any{}
		for k, r := range c.All() {
			items = append(items, []any{k.I, map[string]any{"seq": r.Seq, "name": r.Name, "like_count": r.LikeCount}})
		}
		return items
	}
	keys := func(c *orm.Collection[gen.BattleRow]) []int64 {
		ks := []int64{}
		for k := range c.All() {
			ks = append(ks, k.I)
		}
		return ks
	}
	now := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)

	run("pk_one", func() (any, error) {
		b, err := gen.NewBattle().SeqEq(42).One(ctx, db)
		return row(b), err
	})
	run("pk_one_by", func() (any, error) {
		b, err := gen.NewBattle().OneBySeq(ctx, db, 42)
		return row(b), err
	})
	run("pk_missing", func() (any, error) {
		b, err := gen.NewBattle().SeqEq(0).One(ctx, db)
		return row(b), err
	})
	run("select_lazy", func() (any, error) {
		b, err := gen.NewBattle().SelectDescription().SeqEq(42).One(ctx, db)
		if err != nil {
			return nil, err
		}
		return map[string]any{"seq": b.Seq, "description_prefix": (*b.Description)[:7]}, nil
	})
	run("list_order_limit", func() (any, error) {
		c, err := gen.NewBattle().ServiceSeqEq(7).IsCloseEq(false).OrderBySeqDesc().Limit(0, 5).All(ctx, db)
		if err != nil {
			return nil, err
		}
		return keyed(c), nil
	})
	run("in_keyed", func() (any, error) {
		c, err := gen.NewBattle().SeqIn([]int64{306, 6, 106}).OrderBySeqAsc().All(ctx, db)
		if err != nil {
			return nil, err
		}
		return keys(c), nil
	})
	run("group_or", func() (any, error) {
		c, err := gen.NewBattle().
			ServiceSeqEq(7).
			IsCloseEq(false).
			And(func(w *gen.BattleWhere) {
				w.IsDisplayEq(true).Or().And(func(w *gen.BattleWhere) { w.IsDisplayEq(false).DisplayStartDtLt(now) })
			}).
			SeqIn([]int64{6, 106, 206, 306, 406}).
			OrderBySeqDesc().
			Limit(0, 3).
			All(ctx, db)
		if err != nil {
			return nil, err
		}
		return keyed(c), nil
	})
	run("aggregates", func() (any, error) {
		n, err := gen.NewBattle().ServiceSeqEq(7).Count(ctx, db)
		if err != nil {
			return nil, err
		}
		sum, err := gen.NewBattle().ServiceSeqEq(7).SumLikeCount(ctx, db)
		if err != nil {
			return nil, err
		}
		avg, err := gen.NewBattle().ServiceSeqEq(7).AvgLikeCount(ctx, db)
		if err != nil {
			return nil, err
		}
		return map[string]any{"count": n, "sum_like_count": sum, "avg_like_count": avg}, nil
	})
	run("join_nav_count", func() (any, error) {
		return gen.NewBattle().
			JoinService(gen.NewService().Where(func(w *gen.ServiceWhere) { w.NameEq("service-7") })).
			LeftJoinUser(gen.NewUser().On(func(w *gen.UserWhere) { w.NameContains("user") })).
			IsCloseEq(false).
			And(func(w *gen.BattleWhere) {
				w.IsDisplayEq(true).Or().Service(func(s *gen.ServiceWhere) { s.SeqGt(1000) })
			}).
			Count(ctx, db)
	})
	run("join_row", func() (any, error) {
		b, err := gen.NewBattle().JoinService(gen.NewService().Where(func(w *gen.ServiceWhere) { w.SeqEq(7) })).SeqEq(6).One(ctx, db)
		if err != nil {
			return nil, err
		}
		return map[string]any{"seq": b.Seq, "service": map[string]any{"seq": b.GetService().Seq, "name": b.GetService().Name}}, nil
	})
	run("paginate", func() (any, error) {
		p, err := gen.NewBattle().ServiceSeqEq(7).OrderBySeqAsc().Paginate(ctx, db, 2, 10)
		if err != nil {
			return nil, err
		}
		return map[string]any{"total": p.Total, "pages": p.Pages, "current": p.Current, "per": p.Per, "keys": keys(p.Items)}, nil
	})
	run("contains_escape", func() (any, error) {
		return gen.NewBattle().NameContains("%").Count(ctx, db)
	})
	run("empty_in_error", func() (any, error) {
		return gen.NewBattle().SeqIn([]int64{}).Count(ctx, db)
	})
	run("op_not_allowed_error", func() (any, error) {
		// Not expressible through the typed builder (the method does not exist); the untyped core reaches the engine.
		q := orm.NewQ(eng, "battle")
		q.W().Pred("seq", "like", "x")
		q.Req.IR.Kind = "count"
		return orm.Scalar(ctx, db, q.Req)
	})
	run("write_cycle", func() (any, error) {
		created, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
			return gen.NewBattle().
				SetName("conf-write").
				SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
				SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)).
				SetAesHexEmail("w@example.com").
				Insert(ctx, tx)
		})
		if err != nil {
			return nil, err
		}
		maskSeq, maskTs = created.Seq, created.UpdatedTs
		// the INSERT's own log entries were recorded before the mask existed: re-mask them
		for i := range log {
			for j := range log[i].Binds {
				log[i].Binds[j] = norm(log[i].Binds[j])
			}
		}
		created.SetName("conf-write-2").SetLikeCount(5)
		if err := created.UpdateOptimistic(ctx, db); err != nil {
			return nil, err
		}
		again, err := gen.NewBattle().OneBySeq(ctx, db, created.Seq)
		if err != nil {
			return nil, err
		}
		created.SetName("stale")
		stale := code(created.UpdateOptimistic(ctx, db))
		if err := again.Delete(ctx, db); err != nil {
			return nil, err
		}
		left, err := gen.NewBattle().SeqEq(created.Seq).Count(ctx, db)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"inserted": created.Seq > 0, "email": created.AesHexEmail,
			"after_update": map[string]any{"name": again.Name, "like_count": again.LikeCount},
			"stale": stale, "left": left,
		}, nil
	})

	run("codec_roundtrip", func() (any, error) {
		value := map[string]any{"a": int64(1), "b": []any{int64(1), int64(2), map[string]any{"c": "한글/slash"}}, "d": nil, "e": true, "f": 1.5}
		ip := "10.1.2.3"
		created, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
			return gen.NewBattle().
				SetName("conf-codec").
				SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
				SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)).
				SetJsonSetting(value).SetJsonsTags([]any{"x", "y"}).SetBase64Extra(value).SetSerializeData(value).SetGzExtend(value).SetIp(ip).
				Insert(ctx, tx)
		})
		if err != nil {
			return nil, err
		}
		maskSeq, maskTs = created.Seq, created.UpdatedTs
		for i := range log {
			for j := range log[i].Binds {
				log[i].Binds[j] = norm(log[i].Binds[j])
			}
		}
		b, err := gen.NewBattle().SelectJsonSetting().SelectJsonsTags().SelectBase64Extra().SelectSerializeData().SelectGzExtend().SeqEq(created.Seq).One(ctx, db)
		if err != nil {
			return nil, err
		}
		if err := b.Delete(ctx, db); err != nil {
			return nil, err
		}
		return map[string]any{"json_setting": b.JsonSetting, "jsons_tags": b.JsonsTags, "base64_extra": b.Base64Extra, "serialize_data": b.SerializeData, "gz_extend": b.GzExtend, "ip": b.Ip}, nil
	})

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "runner_go:", err)
	os.Exit(1)
}
