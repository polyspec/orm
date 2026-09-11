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
		maskRows(created.UpdatedTs, created.Seq)
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

	run("eq_col_where", func() (any, error) {
		// service.seq = a.service_module_seq → battles 1..9 only (seq 10 has service 11, module 1)
		c, err := gen.NewBattle().
			JoinService(gen.NewService().Where(func(w *gen.ServiceWhere) { w.SeqEqCol(gen.BattleCols.ServiceModuleSeq) })).
			SeqIn([]int64{1, 2, 10}).OrderBySeqAsc().All(ctx, db)
		if err != nil {
			return nil, err
		}
		return keys(c), nil
	})
	run("expr_where", func() (any, error) {
		return gen.NewBattle().ServiceSeqEq(7).Expr("DAYOFMONTH(`start_dt`) = ?", 1).Count(ctx, db)
	})
	run("select_expr", func() (any, error) {
		b, err := gen.NewBattle().SelectExpr("tag", "CONCAT(`name`, '!')").SeqEq(42).One(ctx, db)
		if err != nil {
			return nil, err
		}
		return map[string]any{"seq": b.Seq, "tag": b.Extra("tag")}, nil
	})
	run("relation_four_levels", func() (any, error) {
		// battle → service → members (2 per service) → user → battles (1 per user): four relation steps
		b, err := gen.NewBattle().SelectNone().SeqEq(7).
			RelationService(gen.NewService().
				RelationsMembers(gen.NewServiceMember().OrderBySeqAsc().LimitPerParent(2).
					RelationUser(gen.NewUser().
						RelationsBattles(gen.NewBattle().SelectNone().OrderBySeqAsc().LimitPerParent(1))))).
			One(ctx, db)
		if err != nil {
			return nil, err
		}
		return b.ToArray(), nil
	})
	run("relation_one_ordered", func() (any, error) {
		// a one-relation with an ORDER is fetched through a per-parent window of 1
		b, err := gen.NewBattle().SelectNone().SeqEq(7).RelationService(gen.NewService().OrderBySeqDesc()).One(ctx, db)
		if err != nil {
			return nil, err
		}
		return b.ToArray(), nil
	})
	run("relation_if_parent", func() (any, error) {
		c, err := gen.NewBattle().SelectNone().SeqIn([]int64{7, 8, 14}).OrderBySeqAsc().RelationUser(gen.NewUser().IfParentIsCloseEq(true)).All(ctx, db)
		if err != nil {
			return nil, err
		}
		items := []any{}
		for _, b := range c.All() {
			items = append(items, b.ToArray())
		}
		return items, nil
	})
	run("relation_empty_parents", func() (any, error) {
		c, err := gen.NewBattle().SeqEq(0).RelationUser(gen.NewUser()).All(ctx, db)
		if err != nil {
			return nil, err
		}
		return keys(c), nil
	})
	run("relation_off_join", func() (any, error) {
		b, err := gen.NewBattle().SelectNone().SeqEq(8).JoinService(gen.NewService().RelationsModules(gen.NewServiceModule())).One(ctx, db)
		if err != nil {
			return nil, err
		}
		return b.ToArray(), nil
	})
	run("paginate_relations", func() (any, error) {
		p, err := gen.NewBattle().SelectNone().ServiceSeqEq(7).OrderBySeqAsc().RelationUser(gen.NewUser()).Paginate(ctx, db, 1, 3)
		if err != nil {
			return nil, err
		}
		items := []any{}
		for _, b := range p.Items.All() {
			items = append(items, b.ToArray())
		}
		return map[string]any{"total": p.Total, "items": items}, nil
	})
	run("key_by_column", func() (any, error) {
		s, err := gen.NewService().SeqEq(7).RelationsMembers(gen.NewServiceMember().OrderBySeqAsc().LimitPerParent(3).KeyByUserSeq()).One(ctx, db)
		if err != nil {
			return nil, err
		}
		return s.ToArray(), nil
	})
	run("key_by_unselected", func() (any, error) {
		// key_by on a column outside the projection: the planner selects it for keying
		s, err := gen.NewService().SeqEq(7).RelationsModules(gen.NewServiceModule().SelectNone().KeyByName()).One(ctx, db)
		if err != nil {
			return nil, err
		}
		return s.ToArray(), nil
	})
	run("types_roundtrip", func() (any, error) {
		dt := time.Date(2026, 6, 1, 12, 34, 56, 123456000, time.UTC)
		created, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
			return gen.NewBattle().
				SetName("conf-types").
				SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
				SetStartDt(dt).SetEndDt(dt).SetDisplayStartDt(dt).SetIsDisplay(true).SetTargetTeamPlayerCount(2147483647).SetReadCount(4294967295).SetPrice(12345.678).
				SetJsonSetting(map[string]any{"k": []any{}}).SetJsonsTags([]any{}).SetSerializeData("").
				Insert(ctx, tx)
		})
		if err != nil {
			return nil, err
		}
		maskRows(created.UpdatedTs, created.Seq)
		b, err := gen.NewBattle().SelectJsonSetting().SelectJsonsTags().SelectSerializeData().SeqEq(created.Seq).One(ctx, db)
		if err != nil {
			return nil, err
		}
		if err := b.Delete(ctx, db); err != nil {
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
		c, err := gen.NewServiceMember().ServiceSeqEq(7).OrderBySeqAsc().Limit(0, 2).
			RelationUser(gen.NewUser().Flatten()).
			KeyByFn(func(m *gen.ServiceMemberRow) orm.Key { return orm.KeyOf(fmt.Sprintf("u%d", m.UserSeq)) }).
			All(ctx, db)
		if err != nil {
			return nil, err
		}
		items := []any{}
		for k, m := range c.All() {
			items = append(items, []any{k.String(), m.ToArray()})
		}
		return items, nil
	})
	run("drop_child_key_to_array", func() (any, error) {
		u, err := gen.NewUser().SeqEq(5).RelationsBattles(gen.NewBattle().SelectNone().OrderBySeqAsc().LimitPerParent(2).DropChildKey()).One(ctx, db)
		if err != nil {
			return nil, err
		}
		return u.ToArray(), nil
	})
	// S3 write long tail. FKs and dates are the write_cycle fixtures.
	fks := func(q *gen.Battle) *gen.Battle {
		return q.SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
			SetStartDt(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)).SetEndDt(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC))
	}
	run("upsert", func() (any, error) {
		return orm.Transaction(ctx, db, func(tx *orm.Tx) (any, error) {
			a, err := fks(gen.NewBattle().SetUuid("conf-upsert").SetName("u1").SetReadCount(1)).Insert(ctx, tx)
			if err != nil {
				return nil, err
			}
			maskRows(a.UpdatedTs, a.Seq)
			// the duplicate uuid turns the insert into an update; LAST_INSERT_ID(seq) makes the re-read find the existing row
			b, err := fks(gen.NewBattle().SetUuid("conf-upsert").SetName("u2").SetReadCount(1)).
				OnDuplicateSetName("u2").OnDuplicatePlusReadCount(5).
				Insert(ctx, tx)
			if err != nil {
				return nil, err
			}
			if err := b.Delete(ctx, tx); err != nil {
				return nil, err
			}
			return map[string]any{"same_seq": a.Seq == b.Seq, "name": b.Name, "read_count": b.ReadCount}, nil
		})
	})
	run("upsert_set_all", func() (any, error) {
		return orm.Transaction(ctx, db, func(tx *orm.Tx) (any, error) {
			a, err := fks(gen.NewBattle().SetUuid("conf-upsert").SetName("u1").SetReadCount(1)).Insert(ctx, tx)
			if err != nil {
				return nil, err
			}
			maskRows(a.UpdatedTs, a.Seq)
			b, err := fks(gen.NewBattle().SetUuid("conf-upsert").SetName("u3").SetReadCount(9)).OnDuplicateSetAll().Insert(ctx, tx)
			if err != nil {
				return nil, err
			}
			if err := b.Delete(ctx, tx); err != nil {
				return nil, err
			}
			return map[string]any{"same_seq": a.Seq == b.Seq, "name": b.Name, "read_count": b.ReadCount}, nil
		})
	})
	run("save_branch", func() (any, error) {
		// no PK in set[] → INSERT; PK set → UPDATE of the other columns and a re-read
		r, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
			return fks(gen.NewBattle().SetName("conf-save")).Save(ctx, tx)
		})
		if err != nil {
			return nil, err
		}
		maskRows(r.UpdatedTs, r.Seq)
		after, err := gen.NewBattle().SetSeq(r.Seq).SetName("conf-save-2").Save(ctx, db)
		if err != nil {
			return nil, err
		}
		if err := after.Delete(ctx, db); err != nil {
			return nil, err
		}
		return map[string]any{"inserted": r.Seq > 0, "after": after.Name}, nil
	})
	run("bulk_update_plus_minus", func() (any, error) {
		created, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.BattleRow, error) {
			return fks(gen.NewBattle().SetReadCount(3).SetName("conf-bulk")).Insert(ctx, tx)
		})
		if err != nil {
			return nil, err
		}
		maskRows(created.UpdatedTs, created.Seq)
		readCount := func() (int64, error) {
			b, err := gen.NewBattle().OneBySeq(ctx, db, created.Seq)
			if err != nil {
				return 0, err
			}
			return b.ReadCount, nil
		}
		if _, err := gen.NewBattle().SeqEq(created.Seq).PlusReadCount(2).Update(ctx, db); err != nil {
			return nil, err
		}
		afterPlus, err := readCount()
		if err != nil {
			return nil, err
		}
		// minus clamps at zero
		if _, err := gen.NewBattle().SeqEq(created.Seq).MinusReadCount(10).Update(ctx, db); err != nil {
			return nil, err
		}
		afterMinus, err := readCount()
		if err != nil {
			return nil, err
		}
		if _, err := gen.NewBattle().SeqEq(created.Seq).SetReadCountExpr("`read_count` * ? + 1", 2).Update(ctx, db); err != nil {
			return nil, err
		}
		afterExpr, err := readCount()
		if err != nil {
			return nil, err
		}
		deleted, err := gen.NewBattle().SeqEq(created.Seq).Delete(ctx, db)
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
			if t.service, err = gen.NewService().SetName("conf-svc").Insert(ctx, tx); err != nil {
				return t, err
			}
			if t.members[0], err = gen.NewServiceMember().SetServiceSeq(t.service.Seq).SetUserSeq(1).Insert(ctx, tx); err != nil {
				return t, err
			}
			if t.members[1], err = gen.NewServiceMember().SetServiceSeq(t.service.Seq).SetUserSeq(2).Insert(ctx, tx); err != nil {
				return t, err
			}
			t.module, err = gen.NewServiceModule().SetServiceSeq(t.service.Seq).SetName("conf-mod").Insert(ctx, tx)
			return t, err
		})
		if err != nil {
			return nil, err
		}
		maskRows(time.Time{}, made.service.Seq, made.members[0].Seq, made.members[1].Seq, made.module.Seq)
		svc, err := gen.NewService().SeqEq(made.service.Seq).
			RelationsMembers(gen.NewServiceMember().OrderBySeqAsc()).
			RelationsModules(gen.NewServiceModule().NoCascadeDelete()).
			One(ctx, db)
		if err != nil {
			return nil, err
		}
		if err := svc.DeleteCascade(ctx, db); err != nil {
			return nil, err
		}
		membersLeft, err := gen.NewServiceMember().ServiceSeqEq(made.service.Seq).Count(ctx, db)
		if err != nil {
			return nil, err
		}
		modulesLeft, err := gen.NewServiceModule().ServiceSeqEq(made.service.Seq).Count(ctx, db)
		if err != nil {
			return nil, err
		}
		serviceLeft, err := gen.NewService().SeqEq(made.service.Seq).Count(ctx, db)
		if err != nil {
			return nil, err
		}
		if _, err := gen.NewServiceModule().SeqEq(made.module.Seq).Delete(ctx, db); err != nil {
			return nil, err
		}
		return map[string]any{"members_left": membersLeft, "modules_left": modulesLeft, "service_left": serviceLeft}, nil
	})
	run("sql_dump", func() (any, error) {
		st, err := gen.NewBattle().ServiceSeqEq(7).SelectAesHexEmail().Limit(0, 1).SQL(ctx, db)
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
		mn, err := gen.NewBattle().ServiceSeqEq(7).MinSeq(ctx, db)
		if err != nil {
			return nil, err
		}
		mx, err := gen.NewBattle().ServiceSeqEq(7).MaxSeq(ctx, db)
		if err != nil {
			return nil, err
		}
		users, err := gen.NewBattle().ServiceSeqEq(7).CountDistinctUserSeq(ctx, db)
		if err != nil {
			return nil, err
		}
		return map[string]any{"min": mn, "max": mx, "distinct_users": users}, nil
	})
	run("group_count_having", func() (any, error) {
		return gen.NewBattle().ServiceSeqEq(7).GroupByUserSeq().
			Having(func(w *gen.BattleWhere) { w.Expr("COUNT(*) > ?", 1) }).
			Count(ctx, db)
	})
	run("predicate_named", func() (any, error) {
		visible, err := gen.NewBattle().Visible().ServiceSeqEq(7).Count(ctx, db)
		if err != nil {
			return nil, err
		}
		after, err := gen.NewBattle().StartedAfter("2026-01-01 00:00:00").ServiceSeqEq(7).Count(ctx, db)
		if err != nil {
			return nil, err
		}
		return map[string]any{"visible": visible, "started_after": after}, nil
	})
	run("raw_root", func() (any, error) {
		return gen.NewBattle().
			Raw("SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?", 7, 0).
			RawAll(ctx, db)
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
		maskRows(created.UpdatedTs, created.Seq)
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
