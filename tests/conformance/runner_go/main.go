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
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"

	"github.com/polyspec/orm/clients/go/gen"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
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
	log      []stmt
	maskSeqs map[int64]bool
	maskTs   time.Time
)

// maskRows hides the identity of the rows a vector created: their seqs
// wherever they are bound and the updated_ts read with the first one. The
// creating statements were logged before the rows existed, so they are
// re-masked here.
func maskRows(ts time.Time, seqs ...int64) {
	maskTs = ts
	for _, seq := range seqs {
		maskSeqs[seq] = true
	}
	for i := range log {
		for j := range log[i].Binds {
			log[i].Binds[j] = norm(log[i].Binds[j])
		}
	}
}

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
		if maskSeqs[x] {
			return "$SEQ"
		}
		return x
	case time.Time:
		if !maskTs.IsZero() && x.Equal(maskTs) {
			return "$TS"
		}
		return fmtTime(x)
	case string:
		// SQLite binds datetimes as text: the same value still masks
		if !maskTs.IsZero() && x == maskTs.UTC().Format("2006-01-02 15:04:05.000000") {
			return "$TS"
		}
		return x
	case []byte:
		if len(x) > 0 && x[0] == 0x78 { // zlib stream (gz style): bytes differ per zlib implementation
			return "$ZLIB"
		}
		return string(x)
	}
	return v
}

func code(err error) any {
	if err == nil {
		return nil
	}
	var e *ir.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return err.Error()
}

func servicePageKeys(page *orm.KeysetPage[gen.ServiceRow]) []any {
	keys := make([]any, 0, page.Items.Len())
	for _, key := range page.Items.Keys() {
		keys = append(keys, key.Value())
	}
	return keys
}

// dsn is ORM_MYSQL_DSN_GO when set (CI), else the local socket.
// driver/dsnFlag come from -driver/-dsn (default mysql on the local socket, or ORM_MYSQL_DSN_GO).
var (
	driver  = "mysql"
	dsnFlag = ""
)

func dsn() string {
	if dsnFlag != "" {
		return dsnFlag
	}
	if v := os.Getenv("ORM_MYSQL_DSN_GO"); v != "" && driver == "mysql" {
		return v
	}
	switch driver {
	case "postgres":
		return "postgres://maxkwon@localhost:5432/orm_bench?sslmode=disable"
	case "sqlite":
		return "file:/tmp/orm_bench.sqlite?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	}
	return "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true"
}

func main() {
	args := os.Args[1:]
	compilerEndpoint := ""
	var rest []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-driver":
			driver = args[i+1]
			i++
		case "-dsn":
			dsnFlag = args[i+1]
			i++
		case "-compiler":
			compilerEndpoint = args[i+1]
			i++
		default:
			rest = append(rest, args[i])
		}
	}
	if len(rest) < 1 {
		fmt.Fprintln(os.Stderr, "usage: runner_go [-driver mysql|postgres|sqlite] [-dsn …] -compiler <http-endpoint> <schema.json>")
		os.Exit(2)
	}
	if compilerEndpoint == "" {
		fail(fmt.Errorf("-compiler is required"))
	}
	js, err := os.ReadFile(rest[0])
	if err != nil {
		fail(err)
	}
	m, err := schema.Load(js)
	if err != nil {
		fail(err)
	}
	eng, err := engine.New(m, driver)
	if err != nil {
		fail(err)
	}
	const aesKey = "bench-salt"
	ctx := context.Background()
	compiler, err := orm.NewConnectCompiler(compilerEndpoint, 5*time.Second)
	if err != nil {
		fail(err)
	}
	db, err := orm.OpenWithCompiler(ctx, dsn(), eng, compiler, orm.Config{
		AESKey: aesKey,
		OnQuery: func(e orm.Event) {
			binds := make([]any, len(e.Args))
			for i, a := range e.Args {
				binds[i] = norm(a) // secret slots arrive masked as $SECRET and are recorded that way
			}
			log = append(log, stmt{SQL: e.SQL, Binds: binds})
		},
	})
	if err != nil {
		fail(err)
	}
	if err := gen.Init(eng); err != nil {
		fail(err)
	}
	out := map[string]vector{}

	run := func(name string, fn func() (any, error)) {
		log, maskSeqs, maskTs = nil, map[int64]bool{}, time.Time{}
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

	run("interface_query_reuse", func() (any, error) {
		q := gen.Battle().Using(db).ServiceSeq(7).Limit(0, 2)
		first, err := q.GetCount()
		if err != nil {
			return nil, err
		}
		rows, err := q.Gets()
		if err != nil {
			return nil, err
		}
		last, err := q.GetCount()
		return []any{first, rows.Len(), last}, err
	})
	run("interface_attach", func() (any, error) {
		child := gen.User().SeqIn([]int64{1, 2}).And(func(w *gen.UserWhere) { w.Name("user-1").Or().Name("user-2") })
		a := gen.Battle().ServiceSeq(7).Join(child)
		b := gen.Battle().ServiceSeq(8).Join(child)
		child.Name("later")
		return map[string]any{"a": a.Req().IR.Query, "b": b.Req().IR.Query, "child": child.Req().IR.Query,
			"a_params": a.Req().Params, "b_params": b.Req().Params, "child_params": child.Req().Params}, nil
	})
	run("interface_typed_keys", func() (any, error) {
		c := orm.NewCollection[gen.ServiceRow](0)
		for _, v := range []struct {
			k    any
			name string
		}{{int64(1), "first"}, {"1", "string"}, {int64(2), "second"}, {int64(1), "last"}} {
			c.Put(orm.KeyOf(v.k), (&gen.ServiceRow{}).SetName(v.name))
		}
		out := []any{}
		for _, entry := range c.Entries() {
			out = append(out, []any{entry.Key.Value(), entry.Value.Name})
		}
		return out, nil
	})
	run("interface_invalid_page", func() (any, error) {
		_, err := gen.Battle().Using(db).Paginate(1, 0)
		return nil, err
	})
	run("interface_error", func() (any, error) {
		child := gen.User()
		_, child.Req().Err = orm.Encode([]string{"unsupported"}, "x")
		q := gen.Battle().Using(db).Join(child)
		_, first := q.SQL()
		_, second := q.SQL()
		return []any{code(first), code(second)}, nil
	})
	run("interface_row_state", func() (any, error) {
		var result any
		rollback := errors.New("interface rollback")
		_, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (any, error) {
			r, err := gen.Battle().Using(tx).SelectNone().SelectSeq().GetBySeq(6)
			if err != nil {
				return nil, err
			}
			before := r.Has("name")
			r.SetName("interface-first").SetLikeCount(5).SetName("interface-final")
			if err := r.Update(); err != nil {
				return nil, err
			}
			n := len(log)
			if err := r.Update(); err != nil {
				return nil, err
			}
			exported, err := r.ToArray()
			if err != nil {
				return nil, err
			}
			result = map[string]any{"before": before, "assigned": r.Has("name"), "value": r.Name, "export": exported, "noop_statements": len(log) - n, "relation_loaded": r.RelLoaded("user")}
			return nil, rollback
		})
		if !errors.Is(err, rollback) {
			return nil, err
		}
		return result, nil
	})
	run("interface_dirty_retry", func() (any, error) {
		var result any
		rollback := errors.New("interface rollback")
		_, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (any, error) {
			r, err := gen.Battle().Using(tx).GetBySeq(6)
			if err != nil {
				return nil, err
			}
			maskRows(r.UpdatedTs)
			if _, err := gen.Battle().Using(tx).Seq(6).SetUpdatedTs(time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)).Update(); err != nil {
				return nil, err
			}
			r.SetName("interface-pending")
			first, second := r.UpdateOptimistic(), r.UpdateOptimistic()
			result = map[string]any{"errors": []any{code(first), code(second)}, "value": r.Name}
			return nil, rollback
		})
		if !errors.Is(err, rollback) {
			return nil, err
		}
		return result, nil
	})

	run("interface_original_version", func() (any, error) {
		var result any
		rollback := errors.New("interface rollback")
		_, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (any, error) {
			r, err := gen.Battle().Using(tx).GetBySeq(6)
			if err != nil {
				return nil, err
			}
			maskRows(r.UpdatedTs)
			version := time.Date(2002, 1, 1, 0, 0, 0, 0, time.UTC)
			r.SetUpdatedTs(version).SetName("interface-version")
			if err := r.UpdateOptimistic(); err != nil {
				return nil, err
			}
			sparse, err := gen.Battle().Using(tx).SelectNone().SelectSeq().GetBySeq(6)
			if err != nil {
				return nil, err
			}
			sparse.SetName("not-written")
			missing := sparse.UpdateOptimistic()
			stored, err := gen.Battle().Using(tx).GetBySeq(6)
			if err != nil {
				return nil, err
			}
			result = map[string]any{"name": stored.Name, "version_retained": r.UpdatedTs.Equal(version) && stored.UpdatedTs.Equal(version), "missing_version": code(missing), "pending": sparse.Name}
			return nil, rollback
		})
		if !errors.Is(err, rollback) {
			return nil, err
		}
		return result, nil
	})
	run("interface_identity", func() (any, error) {
		var result any
		rollback := errors.New("interface rollback")
		_, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (any, error) {
			r, err := gen.Battle().Using(tx).GetBySeq(6)
			if err != nil {
				return nil, err
			}
			r.Seq = 5
			r.SetName("identity-original")
			if err := r.Update(); err != nil {
				return nil, err
			}
			stored, err := gen.Battle().Using(tx).GetBySeq(6)
			if err != nil {
				return nil, err
			}
			if err := r.Delete(); err != nil {
				return nil, err
			}
			original, err := gen.Battle().Using(tx).GetCountBySeq(6)
			if err != nil {
				return nil, err
			}
			other, err := gen.Battle().Using(tx).GetCountBySeq(5)
			if err != nil {
				return nil, err
			}
			result = map[string]any{"updated": stored.Name, "original_left": original, "other_left": other}
			return nil, rollback
		})
		if !errors.Is(err, rollback) {
			return nil, err
		}
		return result, nil
	})
	run("interface_nested_keys", func() (any, error) {
		r, err := gen.Service().Using(db).Relations(gen.ServiceMember().OrderBySeqAsc().LimitPerParent(1)).GetBySeq(7)
		if err != nil {
			return nil, err
		}
		members := r.GetMembers()
		first := members.First()
		members.Put(orm.KeyOf(int64(1)), first)
		members.Put(orm.KeyOf("1"), first)
		return r.ToArray()
	})
	run("interface_stream", func() (any, error) {
		seen := 0
		var first *gen.BattleRow
		var firstSeq int64
		stopped, err := gen.Battle().ServiceSeq(7).OrderBySeqAsc().Using(db).Stream(func(row *gen.BattleRow) bool {
			if first == nil {
				first = row
				firstSeq = row.Seq
			}
			seen++
			return seen < 3
		})
		if err != nil {
			return nil, err
		}
		if first == nil || first.Seq != firstSeq {
			return nil, fmt.Errorf("stream row ownership check failed")
		}
		exhausted, err := gen.Battle().ServiceSeq(7).OrderBySeqAsc().Limit(0, 4).Using(db).Stream(func(*gen.BattleRow) bool { return true })
		if err != nil {
			return nil, err
		}
		var relationErr error
		_, relationErr = gen.Battle().ServiceSeq(7).Relation(gen.User()).Using(db).Stream(func(*gen.BattleRow) bool { return true })
		return map[string]any{
			"stopped":        map[string]any{"state": stopped.State, "count": stopped.Count},
			"exhausted":      map[string]any{"state": exhausted.State, "count": exhausted.Count},
			"relation_error": code(relationErr),
		}, nil
	})
	run("unbound_terminal", func() (any, error) {
		return gen.Battle().GetCountByServiceSeq(7)
	})
	run("bound_count_finder", func() (any, error) {
		return gen.Battle().Using(db).
			Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.Name("service-7") })).
			Relation(gen.User()).GetCountByServiceSeq(7)
	})
	run("finished_transaction", func() (any, error) {
		q, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleQuery, error) {
			return gen.Battle().Using(tx), nil
		})
		if err != nil {
			return nil, err
		}
		return q.GetCountByServiceSeq(7)
	})
	run("bound_transaction_rollback", func() (any, error) {
		rollback := errors.New("binding rollback")
		var s *gen.ServiceRow
		var m *gen.ServiceMemberRow
		var changed int64
		var joinedName string
		_, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (bool, error) {
			var err error
			s, err = gen.Service().Using(tx).SetName("conf-bind").Insert()
			if err != nil {
				return false, err
			}
			if err = s.SetName("conf-bound").Update(); err != nil {
				return false, err
			}
			m, err = gen.ServiceMember().Using(tx).SetServiceSeq(s.Seq).SetUserSeq(1).Insert()
			if err != nil {
				return false, err
			}
			parent, err := gen.Service().Using(db).Using(tx).
				Relations(gen.ServiceMember().Using(db).Join(gen.User())).GetBySeq(s.Seq)
			if err != nil {
				return false, err
			}
			if parent == nil || parent.Name != "conf-bound" || parent.Members.Len() != 1 {
				return false, errors.New("bound relation missing")
			}
			child := parent.Members.First()
			if err = child.SetUserSeq(2).Update(); err != nil {
				return false, err
			}
			if err = child.GetUser().SetName("conf-user").Update(); err != nil {
				return false, err
			}
			changed, err = gen.ServiceMember().Using(tx).UserSeq(2).GetCountByServiceSeq(s.Seq)
			if err != nil {
				return false, err
			}
			u, err := gen.User().Using(tx).GetBySeq(1)
			if err != nil {
				return false, err
			}
			joinedName = u.Name
			return false, rollback
		})
		if !errors.Is(err, rollback) {
			return nil, err
		}
		maskRows(time.Time{}, s.Seq, m.Seq)
		expired := code(m.Delete())
		membersLeft, err := gen.ServiceMember().Using(db).GetCountByServiceSeq(s.Seq)
		if err != nil {
			return nil, err
		}
		serviceLeft, err := gen.Service().Using(db).GetCountBySeq(s.Seq)
		if err != nil {
			return nil, err
		}
		u, err := gen.User().Using(db).GetBySeq(1)
		if err != nil {
			return nil, err
		}
		return map[string]any{"changed": changed, "joined_name": joinedName, "expired_row": expired, "members_left": membersLeft, "service_left": serviceLeft, "user_name": u.Name}, nil
	})

	run("pk_one", func() (any, error) {
		b, err := gen.Battle().Seq(42).Using(db).Get()
		return row(b), err
	})
	run("pk_one_by", func() (any, error) {
		b, err := gen.Battle().Using(db).GetBySeq(42)
		return row(b), err
	})
	run("pk_missing", func() (any, error) {
		b, err := gen.Battle().Seq(0).Using(db).Get()
		return row(b), err
	})
	run("select_lazy", func() (any, error) {
		b, err := gen.Battle().SelectDescription().Seq(42).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return map[string]any{"seq": b.Seq, "description_prefix": (*b.Description)[:7]}, nil
	})
	run("list_order_limit", func() (any, error) {
		c, err := gen.Battle().ServiceSeq(7).IsClose(false).OrderBySeqDesc().Limit(0, 5).Using(db).Gets()
		if err != nil {
			return nil, err
		}
		return keyed(c), nil
	})
	run("in_keyed", func() (any, error) {
		c, err := gen.Battle().SeqIn([]int64{306, 6, 106}).OrderBySeqAsc().Using(db).Gets()
		if err != nil {
			return nil, err
		}
		return keys(c), nil
	})
	run("group_or", func() (any, error) {
		c, err := gen.Battle().
			ServiceSeq(7).
			IsClose(false).
			And(func(w *gen.BattleWhere) {
				w.IsDisplay(true).Or().And(func(w *gen.BattleWhere) { w.IsDisplay(false).DisplayStartDtLt(now) })
			}).
			SeqIn([]int64{6, 106, 206, 306, 406}).
			OrderBySeqDesc().
			Limit(0, 3).Using(db).Gets()
		if err != nil {
			return nil, err
		}
		return keyed(c), nil
	})
	run("aggregates", func() (any, error) {
		n, err := gen.Battle().ServiceSeq(7).Using(db).GetCount()
		if err != nil {
			return nil, err
		}
		sum, err := gen.Battle().ServiceSeq(7).Using(db).SumLikeCount()
		if err != nil {
			return nil, err
		}
		avg, err := gen.Battle().ServiceSeq(7).Using(db).AvgLikeCount()
		if err != nil {
			return nil, err
		}
		return map[string]any{"count": n, "sum_like_count": sum, "avg_like_count": avg}, nil
	})
	run("join_nav_count", func() (any, error) {
		return gen.Battle().
			Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.Name("service-7") })).
			LeftJoin(gen.User().On(func(w *gen.UserWhere) { w.NameContains("user") })).
			IsClose(false).
			And(func(w *gen.BattleWhere) {
				w.IsDisplay(true).Or().Service(func(s *gen.ServiceWhere) { s.SeqGt(1000) })
			}).Using(db).GetCount()
	})
	run("join_row", func() (any, error) {
		b, err := gen.Battle().Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.Seq(7) })).Seq(6).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return map[string]any{"seq": b.Seq, "service": map[string]any{"seq": b.GetService().Seq, "name": b.GetService().Name}}, nil
	})
	run("root_finder_join_relation", func() (any, error) {
		c, err := gen.Battle().SelectNone().
			Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.Name("service-7") })).
			Relation(gen.User()).OrderBySeqAsc().Limit(0, 2).Using(db).GetsByServiceSeq(7)
		if err != nil {
			return nil, err
		}
		items := []any{}
		for _, b := range c.ToSlice() {
			items = append(items, map[string]any{
				"seq":     b.Seq,
				"service": map[string]any{"seq": b.GetService().Seq, "name": b.GetService().Name},
				"user":    map[string]any{"seq": b.GetUser().Seq, "name": b.GetUser().Name},
			})
		}
		return items, nil
	})
	run("paginate", func() (any, error) {
		p, err := gen.Battle().ServiceSeq(7).OrderBySeqAsc().Using(db).Paginate(2, 10)
		if err != nil {
			return nil, err
		}
		return map[string]any{"total": p.Total, "pages": p.Pages, "current": p.Current, "per": p.Per, "keys": keys(p.Items)}, nil
	})
	run("contains_escape", func() (any, error) {
		return gen.Battle().NameContains("%").Using(db).GetCount()
	})
	run("empty_in_error", func() (any, error) {
		return gen.Battle().SeqIn([]int64{}).Using(db).GetCount()
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
			return gen.Battle().
				SetName("conf-write").
				SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
				SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)).
				SetAesHexEmail("w@example.com").Using(tx).Insert()
		})
		if err != nil {
			return nil, err
		}
		maskRows(created.UpdatedTs, created.Seq)
		created.SetName("conf-write-2").SetLikeCount(5)
		if err := created.Using(db).UpdateOptimistic(); err != nil {
			return nil, err
		}
		again, err := gen.Battle().Using(db).GetBySeq(created.Seq)
		if err != nil {
			return nil, err
		}
		created.SetName("stale")
		stale := code(created.Using(db).UpdateOptimistic())
		if err := again.Delete(); err != nil {
			return nil, err
		}
		left, err := gen.Battle().Seq(created.Seq).Using(db).GetCount()
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"inserted": created.Seq > 0, "email": created.AesHexEmail,
			"after_update": map[string]any{"name": again.Name, "like_count": again.LikeCount},
			"stale":        stale, "left": left,
		}, nil
	})

	run("eq_col_where", func() (any, error) {
		// service.seq = a.service_module_seq → battles 1..9 only (seq 10 has service 11, module 1)
		c, err := gen.Battle().
			Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.SeqEqCol(gen.BattleCols.ServiceModuleSeq) })).
			SeqIn([]int64{1, 2, 10}).OrderBySeqAsc().Using(db).Gets()
		if err != nil {
			return nil, err
		}
		return keys(c), nil
	})
	run("expr_where", func() (any, error) {
		return gen.Battle().ServiceSeq(7).Expr("LENGTH(`name`) > ?", 8).Using(db).GetCount()
	})
	run("select_expr", func() (any, error) {
		b, err := gen.Battle().SelectExpr("tag", "CONCAT(`name`, '!')").Seq(42).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return map[string]any{"seq": b.Seq, "tag": b.Extra("tag")}, nil
	})
	run("relation_four_levels", func() (any, error) {
		// battle → service → members (2 per service) → user → battles (1 per user): four relation steps
		b, err := gen.Battle().SelectNone().Seq(7).
			Relation(gen.Service().
				Relations(gen.ServiceMember().OrderBySeqAsc().LimitPerParent(2).
					Relation(gen.User().
						Relations(gen.Battle().SelectNone().OrderBySeqAsc().LimitPerParent(1))))).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return b.ToArray()
	})
	run("relation_one_ordered", func() (any, error) {
		// a one-relation with an ORDER is fetched through a per-parent window of 1
		b, err := gen.Battle().SelectNone().Seq(7).Relation(gen.Service().OrderBySeqDesc()).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return b.ToArray()
	})
	run("relation_if_parent", func() (any, error) {
		c, err := gen.Battle().SelectNone().SeqIn([]int64{7, 8, 14}).OrderBySeqAsc().Relation(gen.User().IfParentIsCloseEq(true)).Using(db).Gets()
		if err != nil {
			return nil, err
		}
		items := []any{}
		for _, b := range c.All() {
			item, err := b.ToArray()
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return items, nil
	})
	run("relation_empty_parents", func() (any, error) {
		c, err := gen.Battle().Seq(0).Relation(gen.User()).Using(db).Gets()
		if err != nil {
			return nil, err
		}
		return keys(c), nil
	})
	run("relation_off_join", func() (any, error) {
		b, err := gen.Battle().SelectNone().Seq(8).Join(gen.Service().Relations(gen.ServiceModule())).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return b.ToArray()
	})
	run("paginate_relations", func() (any, error) {
		p, err := gen.Battle().SelectNone().ServiceSeq(7).OrderBySeqAsc().Relation(gen.User()).Using(db).Paginate(1, 3)
		if err != nil {
			return nil, err
		}
		items := []any{}
		for _, b := range p.Items.All() {
			item, err := b.ToArray()
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return map[string]any{"total": p.Total, "items": items}, nil
	})
	run("key_by_column", func() (any, error) {
		s, err := gen.Service().Seq(7).Relations(gen.ServiceMember().OrderBySeqAsc().LimitPerParent(3).KeyByUserSeq()).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return s.ToArray()
	})
	run("key_by_unselected", func() (any, error) {
		// key_by on a column outside the projection: the planner selects it for keying
		s, err := gen.Service().Seq(7).Relations(gen.ServiceModule().SelectNone().KeyByName()).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return s.ToArray()
	})
	run("types_roundtrip", func() (any, error) {
		dt := time.Date(2026, 6, 1, 12, 34, 56, 123456000, time.UTC)
		created, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
			return gen.Battle().
				SetName("conf-types").
				SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
				SetStartDt(dt).SetEndDt(dt).SetDisplayStartDt(dt).SetIsDisplay(true).SetTargetTeamPlayerCount(2147483647).SetReadCount(4294967295).SetPrice(12345.678).
				SetJsonSetting(map[string]any{"k": []any{}}).SetJsonsTags([]any{}).SetSerializeData("").Using(tx).Insert()
		})
		if err != nil {
			return nil, err
		}
		maskRows(created.UpdatedTs, created.Seq)
		b, err := gen.Battle().SelectJsonSetting().SelectJsonsTags().SelectSerializeData().Seq(created.Seq).Using(db).Get()
		if err != nil {
			return nil, err
		}
		if err := b.Delete(); err != nil {
			return nil, err
		}
		return map[string]any{
			"display_start_dt": fmtTime(*b.DisplayStartDt), "is_display": b.IsDisplay, "is_close": b.IsClose,
			"target_team_player_count": b.TargetTeamPlayerCount, "read_count": b.ReadCount, "price": b.Price,
			"json_setting": b.JsonSetting, "jsons_tags": b.JsonsTags, "serialize_data": b.SerializeData,
		}, nil
	})
	run("key_by_fn_to_array", func() (any, error) {
		// root keyed by a function; flattened user columns merge into the member's array form
		c, err := gen.ServiceMember().ServiceSeq(7).OrderBySeqAsc().Limit(0, 2).
			Relation(gen.User().Flatten()).
			KeyByFn(func(m *gen.ServiceMemberRow) orm.Key { return orm.KeyOf(fmt.Sprintf("u%d", m.UserSeq)) }).Using(db).Gets()
		if err != nil {
			return nil, err
		}
		items := []any{}
		for k, m := range c.All() {
			item, err := m.ToArray()
			if err != nil {
				return nil, err
			}
			items = append(items, []any{k.String(), item})
		}
		return items, nil
	})
	run("drop_child_key_to_array", func() (any, error) {
		u, err := gen.User().Seq(5).Relations(gen.Battle().SelectNone().OrderBySeqAsc().LimitPerParent(2).DropChildKey()).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return u.ToArray()
	})
	// S3 write long tail. FKs and dates are the write_cycle fixtures.
	fks := func(q *gen.BattleQuery) *gen.BattleQuery {
		return q.SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
			SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC))
	}
	run("upsert", func() (any, error) {
		return orm.Transaction(ctx, db, func(tx *orm.Tx) (any, error) {
			a, err := fks(gen.Battle().SetUuid("conf-upsert").SetName("u1").SetReadCount(1)).Using(tx).Insert()
			if err != nil {
				return nil, err
			}
			maskRows(a.UpdatedTs, a.Seq)
			// the duplicate uuid turns the insert into an update; LAST_INSERT_ID(seq) makes the re-read find the existing row
			b, err := fks(gen.Battle().SetUuid("conf-upsert").SetName("u2").SetReadCount(1)).
				OnDuplicateSetName("u2").OnDuplicatePlusReadCount(5).Using(tx).Insert()
			if err != nil {
				return nil, err
			}
			if err := b.Delete(); err != nil {
				return nil, err
			}
			return map[string]any{"same_seq": a.Seq == b.Seq, "name": b.Name, "read_count": b.ReadCount}, nil
		})
	})
	run("upsert_set_all", func() (any, error) {
		return orm.Transaction(ctx, db, func(tx *orm.Tx) (any, error) {
			a, err := fks(gen.Battle().SetUuid("conf-upsert").SetName("u1").SetReadCount(1)).Using(tx).Insert()
			if err != nil {
				return nil, err
			}
			maskRows(a.UpdatedTs, a.Seq)
			b, err := fks(gen.Battle().SetUuid("conf-upsert").SetName("u3").SetReadCount(9)).OnDuplicateSetAll().Using(tx).Insert()
			if err != nil {
				return nil, err
			}
			if err := b.Delete(); err != nil {
				return nil, err
			}
			return map[string]any{"same_seq": a.Seq == b.Seq, "name": b.Name, "read_count": b.ReadCount}, nil
		})
	})
	run("save_branch", func() (any, error) {
		r, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
			return fks(gen.Battle().SetName("conf-save")).Using(tx).Insert()
		})
		if err != nil {
			return nil, err
		}
		maskRows(r.UpdatedTs, r.Seq)
		if _, err := gen.Battle().Seq(r.Seq).SetName("conf-save-2").Using(db).Update(); err != nil {
			return nil, err
		}
		after, err := gen.Battle().Seq(r.Seq).Using(db).Get()
		if err != nil {
			return nil, err
		}
		if err := after.Delete(); err != nil {
			return nil, err
		}
		return map[string]any{"inserted": r.Seq > 0, "after": after.Name}, nil
	})
	run("bulk_update_plus_minus", func() (any, error) {
		created, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
			return fks(gen.Battle().SetReadCount(3).SetName("conf-bulk")).Using(tx).Insert()
		})
		if err != nil {
			return nil, err
		}
		maskRows(created.UpdatedTs, created.Seq)
		readCount := func() (int64, error) {
			b, err := gen.Battle().Using(db).GetBySeq(created.Seq)
			if err != nil {
				return 0, err
			}
			return b.ReadCount, nil
		}
		if _, err := gen.Battle().Seq(created.Seq).PlusReadCount(2).Using(db).Update(); err != nil {
			return nil, err
		}
		afterPlus, err := readCount()
		if err != nil {
			return nil, err
		}
		// minus clamps at zero
		if _, err := gen.Battle().Seq(created.Seq).MinusReadCount(10).Using(db).Update(); err != nil {
			return nil, err
		}
		afterMinus, err := readCount()
		if err != nil {
			return nil, err
		}
		if _, err := gen.Battle().Seq(created.Seq).SetReadCountExpr("`read_count` * ? + 1", 2).Using(db).Update(); err != nil {
			return nil, err
		}
		afterExpr, err := readCount()
		if err != nil {
			return nil, err
		}
		deleted, err := gen.Battle().Seq(created.Seq).Using(db).Delete()
		if err != nil {
			return nil, err
		}
		return map[string]any{"after_plus": afterPlus, "after_minus": afterMinus, "after_expr": afterExpr, "deleted": deleted}, nil
	})
	run("delete_cascade_order", func() (any, error) {
		// a service owning two members and one module; the module relation opts out of the cascade
		type tree struct {
			service *gen.ServiceRow
			members [2]*gen.ServiceMemberRow
			module  *gen.ServiceModuleRow
		}
		made, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (tree, error) {
			var t tree
			var err error
			if t.service, err = gen.Service().SetName("conf-svc").Using(tx).Insert(); err != nil {
				return t, err
			}
			if t.members[0], err = gen.ServiceMember().SetServiceSeq(t.service.Seq).SetUserSeq(1).Using(tx).Insert(); err != nil {
				return t, err
			}
			if t.members[1], err = gen.ServiceMember().SetServiceSeq(t.service.Seq).SetUserSeq(2).Using(tx).Insert(); err != nil {
				return t, err
			}
			t.module, err = gen.ServiceModule().SetServiceSeq(t.service.Seq).SetName("conf-mod").Using(tx).Insert()
			return t, err
		})
		if err != nil {
			return nil, err
		}
		maskRows(time.Time{}, made.service.Seq, made.members[0].Seq, made.members[1].Seq, made.module.Seq)
		svc, err := gen.Service().Seq(made.service.Seq).
			Relations(gen.ServiceMember().OrderBySeqAsc()).
			Relations(gen.ServiceModule().NoCascadeDelete()).Using(db).Get()
		if err != nil {
			return nil, err
		}
		if err := svc.Using(db).DeleteCascade(); err != nil {
			return nil, err
		}
		membersLeft, err := gen.ServiceMember().ServiceSeq(made.service.Seq).Using(db).GetCount()
		if err != nil {
			return nil, err
		}
		modulesLeft, err := gen.ServiceModule().ServiceSeq(made.service.Seq).Using(db).GetCount()
		if err != nil {
			return nil, err
		}
		serviceLeft, err := gen.Service().Seq(made.service.Seq).Using(db).GetCount()
		if err != nil {
			return nil, err
		}
		if _, err := gen.ServiceModule().Seq(made.module.Seq).Using(db).Delete(); err != nil {
			return nil, err
		}
		return map[string]any{"members_left": membersLeft, "modules_left": modulesLeft, "service_left": serviceLeft}, nil
	})
	run("sql_dump", func() (any, error) {
		st, err := gen.Battle().ServiceSeq(7).SelectAesHexEmail().Limit(0, 1).Using(db).SQL()
		if err != nil {
			return nil, err
		}
		binds := make([]any, len(st.Binds))
		for i, b := range st.Binds {
			binds[i] = norm(b)
		}
		return map[string]any{"sql": st.SQL, "binds": binds}, nil
	})
	// S4: aggregates, group count + having, named predicates, raw root.
	run("agg_min_max", func() (any, error) {
		mn, err := gen.Battle().ServiceSeq(7).Using(db).MinSeq()
		if err != nil {
			return nil, err
		}
		mx, err := gen.Battle().ServiceSeq(7).Using(db).MaxSeq()
		if err != nil {
			return nil, err
		}
		users, err := gen.Battle().ServiceSeq(7).Using(db).CountDistinctUserSeq()
		if err != nil {
			return nil, err
		}
		return map[string]any{"min": mn, "max": mx, "distinct_users": users}, nil
	})
	run("group_count_having", func() (any, error) {
		return gen.Battle().ServiceSeq(7).GroupByUserSeq().
			Having(func(w *gen.BattleWhere) { w.Expr("COUNT(*) > ?", 1) }).Using(db).GetCount()
	})
	run("predicate_named", func() (any, error) {
		visible, err := gen.Battle().Visible().ServiceSeq(7).Using(db).GetCount()
		if err != nil {
			return nil, err
		}
		after, err := gen.Battle().StartedAfter("2026-01-01 00:00:00").ServiceSeq(7).Using(db).GetCount()
		if err != nil {
			return nil, err
		}
		return map[string]any{"visible": visible, "started_after": after}, nil
	})
	run("raw_root", func() (any, error) {
		return gen.Battle().
			Raw("SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?", 7, false).Using(db).RawAll()
	})
	run("join_fulltext_or", func() (any, error) {
		// R9 shape: a join whose child carries its own where, plus a root group mixing
		// a fulltext predicate with navigation into the joined entity
		return gen.Battle().
			Join(gen.Service().Where(func(w *gen.ServiceWhere) { w.Seq(7) })).
			IsClose(false).
			And(func(w *gen.BattleWhere) {
				w.NameWithDescriptionMatchBoolean("battle").Or().Service(func(s *gen.ServiceWhere) { s.Name("service-999") })
			}).Using(db).GetCount()
	})
	run("join_two_groups", func() (any, error) {
		// two joined entities, each with its own on() and where(), and an IN at the root
		return gen.Battle().
			Join(gen.Service().On(func(w *gen.ServiceWhere) { w.Name("service-7") }).Where(func(w *gen.ServiceWhere) { w.SeqGt(0) })).
			LeftJoin(gen.User().Where(func(w *gen.UserWhere) { w.NameContains("user-4") })).
			SeqIn([]int64{6, 106, 206, 406}).Using(db).GetCount()
	})
	run("join_multi_level", func() (any, error) {
		// two levels of joins off one child: aliases are path-derived and each keeps its own columns
		b, err := gen.Battle().SelectNone().Seq(6).
			Join(gen.ServiceMember().SelectNone().
				Join(gen.User().SelectNone()).
				Join(gen.Service().SelectNone())).Using(db).Get()
		if err != nil {
			return nil, err
		}
		return b.ToArray()
	})
	run("relation_predicates", func() (any, error) {
		exists, err := gen.Service().Seq(7).HasMembers(func(*gen.ServiceMemberWhere) {}).Using(db).GetCount()
		if err != nil {
			return nil, err
		}
		count, err := gen.Service().Seq(7).CountMembersEq(50, func(*gen.ServiceMemberWhere) {}).Using(db).GetCount()
		return map[string]any{"exists": exists, "count": count}, err
	})
	run("batch_insert_delete", func() (any, error) {
		names := []string{"conformance-batch-a", "conformance-batch-b"}
		if _, err := gen.Service().NameIn(names).Using(db).Delete(); err != nil {
			return nil, err
		}
		result, err := gen.Service().Using(db).BatchInsert([]*gen.ServiceQuery{
			gen.Service().SetName(names[0]), gen.Service().SetName(names[1]),
		}, orm.BatchOptions{ChunkSize: 1})
		if err != nil {
			return nil, err
		}
		deleted, err := gen.Service().NameIn(names).Using(db).Delete()
		return map[string]any{"attempted": result.Attempted, "affected": result.Affected, "inserted": result.Inserted, "deleted": deleted}, err
	})
	run("keyset_pages", func() (any, error) {
		first, err := gen.Service().OrderBySeqAsc().Using(db).GetsAfter("", 3)
		if err != nil {
			return nil, err
		}
		second, err := gen.Service().OrderBySeqAsc().Using(db).GetsAfter(first.NextCursor, 3)
		if err != nil {
			return nil, err
		}
		return map[string]any{"first": servicePageKeys(first), "second": servicePageKeys(second), "has_cursor": first.NextCursor != ""}, nil
	})
	run("aes_status", func() (any, error) {
		keyring, err := orm.NewAESKeyring(map[int32]string{1: "bench-salt", 2: "bench-salt-v2"}, 1)
		if err != nil {
			return nil, err
		}
		status, err := gen.Battle().Using(db).AESStatus(keyring)
		return map[string]any{"current": status.Current, "pending": status.Pending, "total": status.Total, "versions": status.Versions}, err
	})
	run("codec_roundtrip", func() (any, error) {
		value := map[string]any{"a": int64(1), "b": []any{int64(1), int64(2), map[string]any{"c": "한글/slash"}}, "d": nil, "e": true, "f": 1.5}
		ip := "10.1.2.3"
		created, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
			return gen.Battle().
				SetName("conf-codec").
				SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
				SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)).
				SetJsonSetting(value).SetJsonsTags([]any{"x", "y"}).SetBase64Extra(value).SetSerializeData(value).SetGzExtend(value).SetIp(ip).Using(tx).Insert()
		})
		if err != nil {
			return nil, err
		}
		maskRows(created.UpdatedTs, created.Seq)
		b, err := gen.Battle().SelectJsonSetting().SelectJsonsTags().SelectBase64Extra().SelectSerializeData().SelectGzExtend().Seq(created.Seq).Using(db).Get()
		if err != nil {
			return nil, err
		}
		if err := b.Delete(); err != nil {
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
