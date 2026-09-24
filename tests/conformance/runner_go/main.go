// Conformance runner (Go). Runs every vector against the bench database and
// prints {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}; the
// other runners print the same document for the same chains.
//
// Usage: runner_go [-driver mysql|postgres|sqlite] -dsn URI <schema.json>
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"
	"github.com/polyspec/orm/engine"
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
	maskTs   map[string]bool
)

const timeLayout = "2006-01-02 15:04:05.000000"

// mask hides the identity of rows a vector created: their keys and update
// times wherever they are bound, including statements logged earlier.
func mask(seqs []int64, times ...time.Time) {
	for _, s := range seqs {
		maskSeqs[s] = true
	}
	for _, t := range times {
		maskTs[t.Format(timeLayout)] = true
	}
	for i := range log {
		for j := range log[i].Binds {
			log[i].Binds[j] = norm(log[i].Binds[j])
		}
	}
}

// norm renders a bound value the way every runner does.
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
		return norm(x.Format(timeLayout))
	case string:
		if maskTs[x] {
			return "$TS"
		}
		// AES ciphertexts carry a random nonce: raw or hex-encoded.
		if strings.HasPrefix(x, "ORM-AES2") || strings.HasPrefix(strings.ToLower(x), "4f524d2d41455332") {
			return "$AES"
		}
		return x
	case []byte:
		return norm(string(x))
	}
	return v
}

func code(err error) any {
	if err == nil {
		return nil
	}
	if c := orm.ErrorCode(err); c != "" {
		return c
	}
	return err.Error()
}

var (
	driver = "mysql"
	dsn    = ""
)

// pick keeps the named values of a row.
func pick(m orm.Model, names ...string) map[string]any {
	if m == nil || m.Orm_() == nil {
		return nil
	}
	all := m.Orm_().ToArray()
	out := map[string]any{}
	for _, n := range names {
		out[n] = all[n]
	}
	return out
}

func picks[T orm.Model](c *orm.Collection[T], names ...string) []any {
	out := []any{}
	for _, m := range c.Slice() {
		out = append(out, pick(m, names...))
	}
	return out
}

func keysOf[T orm.Model](c *orm.Collection[T]) []any {
	out := []any{}
	for _, k := range c.Keys() {
		out = append(out, k.Value())
	}
	return out
}

func main() {
	args := os.Args[1:]
	var rest []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-driver":
			driver = args[i+1]
			i++
		case "-dsn":
			dsn = args[i+1]
			i++
		default:
			rest = append(rest, args[i])
		}
	}
	if len(rest) != 1 || dsn == "" {
		fmt.Fprintln(os.Stderr, "usage: runner_go [-driver mysql|postgres|sqlite] -dsn URI <schema.json>")
		os.Exit(2)
	}
	js, err := os.ReadFile(rest[0])
	check(err)
	m, err := schema.Load(js)
	check(err)
	eng, err := engine.New(m, driver)
	check(err)
	check(orm.CheckSchemaHash(eng, model.SchemaHash))
	db, err := orm.Open(dsn, eng, orm.Config{
		AESKey:        "bench-salt",
		BlindIndexKey: "bench-blind-index",
		OnQuery: func(e orm.Event) {
			binds := make([]any, len(e.Args))
			for i, a := range e.Args {
				binds[i] = norm(a)
			}
			log = append(log, stmt{SQL: e.SQL, Binds: binds})
		},
	})
	check(err)
	defer db.Close()

	out := map[string]vector{}
	run := func(name string, fn func() (any, error)) {
		log, maskSeqs, maskTs = nil, map[int64]bool{}, map[string]bool{}
		res, err := fn()
		if err != nil {
			res = map[string]any{"error": code(err)}
		}
		out[name] = vector{Statements: append([]stmt{}, log...), Result: res}
	}
	battle := func() *model.BattleModel { return model.Battle().Connect(db) }
	cols := []string{"seq", "name", "is_close", "is_display", "read_count"}

	run("conditions_connectors", func() (any, error) {
		rows, err := battle().ServiceSeq(7).AndIsClose(false).Or().ReadCount(6).OrderBySeqAsc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return picks(rows, cols...), nil
	})
	run("conditions_group", func() (any, error) {
		rows, err := battle().ServiceSeq(7).
			And(func(q *model.BattleModel) {
				q.IsDisplay(false).Or(func(q *model.BattleModel) { q.IsClose(true).AndGtReadCount(500) })
			}).
			OrderBySeqDesc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return picks(rows, cols...), nil
	})
	run("conditions_leading_group", func() (any, error) {
		rows, err := battle().
			And(func(q *model.BattleModel) { q.IsDisplay(false).OrIsClose(true) }).
			AndServiceSeq(7).
			OrderBySeqDesc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return picks(rows, cols...), nil
	})
	run("conditions_leading_prefix", func() (any, error) {
		rows, err := battle().AndServiceSeq(7).AndGtReadCount(990).OrderBySeqDesc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return picks(rows, cols...), nil
	})
	run("conditions_values", func() (any, error) {
		counts := []any{}
		for _, q := range []*model.BattleModel{
			battle().ServiceSeq([]int64{7, 8}).AndNeIsClose(true),
			battle().ServiceSeq(7).AndUuid(orm.Null),
			battle().ServiceSeq(7).AndNeCoverUrl(orm.Null),
			battle().ServiceSeq(7).AndNeReadCount([]int64{6, 106, 206}),
			battle().ServiceSeq(7).AndBetweenReadCount([2]int64{100, 200}),
			battle().ServiceSeq(7).AndLkName("attle-10"),
			battle().ServiceSeq(7).AndLbName("Battle-10"),
			battle().ServiceSeq(7).AndGeReadCount(990),
			battle().ServiceSeq(7).AndLeReadCount(10),
			battle().ServiceSeq(7).AndLtSeq(1000),
		} {
			n, err := q.GetCount()
			if err != nil {
				return nil, err
			}
			counts = append(counts, n)
		}
		return counts, nil
	})
	run("terminal_by", func() (any, error) {
		one, err := battle().GetBySeq(42)
		if err != nil {
			return nil, err
		}
		_, missing := battle().GetBySeq(-1)
		rows, err := battle().OrderBySeqAsc().Limit(0, 2).GetsByServiceSeqAndIsClose(7, false)
		if err != nil {
			return nil, err
		}
		count, err := battle().GetCountByServiceSeq(7)
		if err != nil {
			return nil, err
		}
		return map[string]any{"one": pick(one, cols...), "missing": code(missing), "rows": picks(rows, cols...), "count": count}, nil
	})
	run("terminal_reuse", func() (any, error) {
		q := battle().ServiceSeq(7).OrderBySeqAsc().Limit(0, 2)
		first, err := q.GetCountByIsClose(true)
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
	run("raw_forms", func() (any, error) {
		count, err := battle().ServiceSeq(7).AndRaw("{read_count} > ?", 990).GetCount()
		if err != nil {
			return nil, err
		}
		rows, err := battle().Raw("{seq} IN (?, ?)", 42, 43).
			RemoveAllColumns().AddRawColumnDoubled("({read_count} * ?)", 2).
			OrderByRaw("{seq} DESC").Gets()
		if err != nil {
			return nil, err
		}
		out := []any{}
		for _, r := range rows.Slice() {
			out = append(out, []any{r.GetSeq(), orm.AsInt64(r.GetDoubled())})
		}
		return map[string]any{"count": count, "rows": out}, nil
	})
	run("columns", func() (any, error) {
		none, err := model.Service().Connect(db).RemoveAllColumns().GetBySeq(7)
		if err != nil {
			return nil, err
		}
		added, err := battle().RemoveAllColumns().AddColumnName().AddColumnReadCountAliasReadText("CONCAT('r', %s)").GetBySeq(42)
		if err != nil {
			return nil, err
		}
		removed, err := model.Service().Connect(db).RemoveColumnName().GetBySeq(7)
		if err != nil {
			return nil, err
		}
		return []any{none.ToArray(), pick(added, "seq", "name", "read_text"), removed.ToArray()}, nil
	})
	run("joins", func() (any, error) {
		service := model.Service().
			On(func(s *model.ServiceModel) { s.GtSeq(0) }).
			Name("service-7")
		rows, err := battle().
			RemoveAllColumns().AddColumnName().
			JoinServiceSeqWithSeq(service).
			IsClose(false).
			And(func(q *model.BattleModel) { q.IsDisplay(true).Or(service) }).
			OrderBySeqAsc().Limit(0, 2).Gets()
		if err != nil {
			return nil, err
		}
		member := model.ServiceMember()
		compared, err := battle().
			JoinServiceMemberSeqWithSeq(member).
			ServiceSeq(7).
			AndSuccessCountLtSeq(member).
			GetCount()
		if err != nil {
			return nil, err
		}
		left, err := battle().LeftJoinServiceModuleSeqWithSeq(model.ServiceModule().AliasModule()).
			ServiceSeq(7).OrderBySeqAsc().Limit(0, 1).Gets()
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"rows":     rows.ToArray(),
			"compared": compared,
			"module":   pick(left.First().GetModule(), "seq", "name"),
		}, nil
	})
	run("relations", func() (any, error) {
		rows, err := battle().
			RemoveAllColumns().AddColumnName().AddColumnIsClose().
			Relation(model.User().MatchUserSeqWithSeq().AliasWriter().
				Relations(model.Battle().MatchSeqWithUserSeq().RemoveAllColumns().OrderBySeqDesc().GroupLimit(2))).
			Relation(model.Service().MatchServiceSeqWithSeq().
				Relations(model.ServiceMember().MatchSeqWithServiceSeq().RemoveAllColumns().OrderBySeqAsc().GroupLimit(2).KeyNameUserSeq())).
			Relation(model.ServiceModule().MatchServiceModuleSeqWithSeq().PossibleIsClose(true).ParentNode()).
			ServiceSeq(7).OrderBySeqAsc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return rows.ToArray(), nil
	})
	run("relation_empty", func() (any, error) {
		rows, err := battle().Relations(model.ServiceMember().MatchUserSeqWithUserSeq()).GetsBySeq(-1)
		if err != nil {
			return nil, err
		}
		return rows.Len(), nil
	})
	run("subqueries", func() (any, error) {
		users, err := model.User().Connect(db).
			AddColumnReadTotal(func(u *model.UserModel) orm.Model {
				return model.Battle().SumReadCount().UserSeqEqSeq(u).AndServiceSeq(7)
			}).
			Seq(model.Battle().AddColumnUserSeq().ServiceSeq(7).AndGeReadCount(906)).
			OrderBySeqAsc().Gets()
		if err != nil {
			return nil, err
		}
		out := []any{}
		for _, u := range users.Slice() {
			out = append(out, []any{u.GetSeq(), orm.AsInt64(u.GetReadTotal())})
		}
		return out, nil
	})
	run("aggregates", func() (any, error) {
		sum, err := battle().ServiceSeq(7).SumReadCount().GetSum()
		if err != nil {
			return nil, err
		}
		avg, err := battle().ServiceSeq(7).AvgLikeCount().GetAvg()
		if err != nil {
			return nil, err
		}
		groups, err := battle().ServiceSeq(7).GroupByIsClose().OrderByIsCloseAsc().GetsCount()
		if err != nil {
			return nil, err
		}
		page, err := battle().ServiceSeq(7).RemoveAllColumns().OrderBySeqAsc().GetsPage(3, 4)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"sum":    sum,
			"avg":    fmt.Sprintf("%.4f", avg),
			"groups": groups.ToArray(),
			"page":   map[string]any{"keys": keysOf(page.Items), "total": page.TotalCount, "pages": page.TotalPages, "page": page.Page, "per_page": page.PerPage},
		}, nil
	})
	run("functions", func() (any, error) {
		counts := []any{}
		for _, q := range []*model.BattleModel{
			battle().ServiceSeq(7).AndEqStartDt(orm.DayOfWeek(), 2),
			battle().ServiceSeq(7).AndStartDt(orm.Year(), 2026),
			battle().ServiceSeq(7).AndGtStartDt(orm.DaysAgo(36500)),
			battle().ServiceSeq(7).AndLtStartDt(orm.MonthsLater(1200)),
		} {
			n, err := q.GetCount()
			if err != nil {
				return nil, err
			}
			counts = append(counts, n)
		}
		rows, err := battle().RemoveAllColumns().AddColumnStartDtAliasStartMonth(orm.Month()).
			OrderByStartDtAsc(orm.Year()).OrderBySeqAsc().GetsBySeq([]int64{42, 43})
		if err != nil {
			return nil, err
		}
		months := []any{}
		for _, r := range rows.Slice() {
			months = append(months, orm.AsInt64(r.GetStartMonth()))
		}
		return map[string]any{"counts": counts, "months": months}, nil
	})
	run("errors", func() (any, error) {
		var errs []any
		_, err := battle().Name("a").IsClose(true).Gets()
		errs = append(errs, code(err))
		_, err = battle().Name("a").And().Gets()
		errs = append(errs, code(err))
		_, err = battle().Seq([]int64{}).Gets()
		errs = append(errs, code(err))
		_, err = model.Battle().Name("a").Gets()
		errs = append(errs, code(err))
		_, err = battle().ForUpdate().Gets()
		errs = append(errs, code(err))
		_, err = battle().JoinUserSeqWithSeq(model.User().Connect(db)).Gets()
		errs = append(errs, code(err))
		_, err = battle().Limit(0, 1).GetsPage(1, 10)
		errs = append(errs, code(err))
		_, err = battle().Relation(model.User().MatchUserSeqWithSeq().Limit(0, 1)).GetsBySeq(42)
		errs = append(errs, code(err))
		_, err = battle().Name("a").Or(model.User()).Gets()
		errs = append(errs, code(err))
		return errs, nil
	})
	run("get_query", func() (any, error) {
		st, err := battle().ServiceSeq(7).AndLkName("x").AndAesHexEmail("user7@example.com").OrderBySeqDesc().Limit(0, 5).GetQuery()
		if err != nil {
			return nil, err
		}
		binds := []any{}
		for _, b := range st.Binds {
			binds = append(binds, norm(b))
		}
		return map[string]any{"sql": st.SQL, "binds": binds}, nil
	})
	run("aes_values", func() (any, error) {
		row, err := battle().RemoveAllColumns().AddColumnAesHexEmail().AddColumnAesHexPhone().GetBySeq(42)
		if err != nil {
			return nil, err
		}
		found, err := battle().AesHexEmail("user42@example.com").GetCount()
		if err != nil {
			return nil, err
		}
		return map[string]any{"row": row.ToArray(), "found": found}, nil
	})
	run("write_cycle", func() (any, error) {
		start := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
		price := 12.5
		ip := "10.0.0.1"
		email := "cycle@example.com"
		created, err := battle().
			SetName("cycle").SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
			SetStartDt(start).SetEndDt(start).SetPrice(&price).SetIp(&ip).SetAesHexEmail(&email).
			SetJsonSetting(map[string]any{"a": 1}).SetSerializeData(map[string]any{"k": "v"}).
			NewLabel("created").
			Create()
		if err != nil {
			return nil, err
		}
		seq := created.GetSeq()
		mask([]int64{seq})
		createdArray := created.ToArray()
		createdArray["seq"] = "$SEQ"
		loaded, err := battle().AddAllColumns().GetBySeq(seq)
		if err != nil {
			return nil, err
		}
		mask(nil, loaded.GetUpdatedTs())
		if _, err := loaded.SetName("cycle-2").PlusReadCount(3).Update(true); err != nil {
			return nil, err
		}
		_, stale := loaded.SetName("stale").Update(true)
		again, err := battle().AddAllColumns().GetBySeq(seq)
		if err != nil {
			return nil, err
		}
		updated := pick(again, "name", "read_count", "price", "ip", "aes_hex_email", "json_setting", "serialize_data", "start_dt")
		if err := again.Delete(); err != nil {
			return nil, err
		}
		_, gone := battle().GetBySeq(seq)
		return map[string]any{"created": createdArray, "updated": updated, "stale": code(stale), "deleted": code(gone)}, nil
	})
	run("now_defaults", func() (any, error) {
		start := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
		before := time.Now()
		created, err := battle().
			SetName("clock").SetUserSeq(1).SetServiceSeq(999).SetServiceModuleSeq(1).SetServiceMemberSeq(1).
			SetStartDt(start).SetEndDt(start).
			Create()
		if err != nil {
			return nil, err
		}
		seq := created.GetSeq()
		mask([]int64{seq})
		loaded, err := battle().GetBySeq(seq)
		if err != nil {
			return nil, err
		}
		createdTs, updatedTs := loaded.GetCreatedTs(), loaded.GetUpdatedTs()
		near := createdTs.Sub(before).Abs() < time.Minute
		if err := loaded.Delete(); err != nil {
			return nil, err
		}
		return map[string]any{"created_near_clock": near, "created_equals_updated": createdTs.Equal(updatedTs)}, nil
	})
	run("creates_and_save", func() (any, error) {
		rows := []*model.CompositeAccountModel{
			model.CompositeAccount().SetTenantId(900).SetAccountId(1).SetName("a"),
			model.CompositeAccount().SetTenantId(900).SetAccountId(2).SetName("b"),
			model.CompositeAccount().SetTenantId(901).SetAccountId(1).SetName("c"),
		}
		inserted, err := model.CompositeAccount().Connect(db).Creates(rows)
		if err != nil {
			return nil, err
		}
		if _, err := model.CompositeAccount().Connect(db).SetTenantId(900).SetAccountId(1).SetName("dup").
			Duplication(model.CompositeAccount().SetName("updated")).Create(); err != nil {
			return nil, err
		}
		if _, err := model.CompositeAccount().Connect(db).SetTenantId(900).SetAccountId(2).SetName("saved").Save(); err != nil {
			return nil, err
		}
		pairs, err := model.CompositeAccount().Connect(db).
			TupleTenantIdWithAccountId([]model.CompositeAccountTenantIdWithAccountId{{TenantId: 900, AccountId: 1}, {TenantId: 900, AccountId: 2}}).
			OrderByAccountIdAsc().Gets()
		if err != nil {
			return nil, err
		}
		all, err := model.CompositeAccount().Connect(db).TenantId([]int64{900, 901}).OrderByTenantIdAsc().OrderByAccountIdAsc().Gets()
		if err != nil {
			return nil, err
		}
		if err := all.Delete(); err != nil {
			return nil, err
		}
		left, err := model.CompositeAccount().Connect(db).TenantId([]int64{900, 901}).GetCount()
		return map[string]any{"inserted": inserted, "pairs": pairs.ToArray(), "left": left}, err
	})
	run("delete_recursive", func() (any, error) {
		service, err := model.Service().Connect(db).SetName("recursive").Create()
		if err != nil {
			return nil, err
		}
		seq := service.GetSeq()
		seqs := []int64{seq}
		for i := 0; i < 2; i++ {
			member, err := model.ServiceMember().Connect(db).SetServiceSeq(seq).SetUserSeq(int64(i + 1)).Create()
			if err != nil {
				return nil, err
			}
			seqs = append(seqs, member.GetSeq())
		}
		loaded, err := model.Service().Connect(db).
			Relations(model.ServiceMember().MatchSeqWithServiceSeq()).
			GetBySeq(seq)
		if err != nil {
			return nil, err
		}
		members := loaded.GetServiceMemberModels().Len()
		mask(seqs)
		if err := loaded.Delete(true); err != nil {
			return nil, err
		}
		left, err := model.ServiceMember().Connect(db).GetCountByServiceSeq(seq)
		if err != nil {
			return nil, err
		}
		_, service2 := model.Service().Connect(db).GetBySeq(seq)
		return map[string]any{"members": members, "members_left": left, "service_left": code(service2)}, nil
	})
	run("transactions", func() (any, error) {
		boom := errors.New("boom")
		var events []any
		err := db.Transaction(func() error {
			if _, err := model.Service().SetName("tx-outer").Create(); err != nil {
				return err
			}
			inner := db.Transaction(func() error {
				if _, err := model.Service().SetName("tx-inner").Create(); err != nil {
					return err
				}
				return boom
			})
			events = append(events, errors.Is(inner, boom))
			count, err := model.Service().Name([]string{"tx-outer", "tx-inner"}).GetCount()
			if err != nil {
				return err
			}
			events = append(events, count)
			locked, err := model.Service().Name("tx-outer").ForUpdate().Gets()
			if err != nil {
				return err
			}
			events = append(events, locked.Len())
			if err := db.Utils().Lock("conformance"); err != nil {
				return err
			}
			if err := db.Utils().SetLocal("app.actor", "runner"); err != nil {
				return err
			}
			actor, err := db.Utils().Local("app.actor")
			if err != nil {
				return err
			}
			events = append(events, actor)
			return boom
		}, orm.Retry(0))
		events = append(events, errors.Is(err, boom))
		left, err := model.Service().Connect(db).Name([]string{"tx-outer", "tx-inner"}).GetCount()
		events = append(events, left)
		return events, err
	})
	run("aes_status", func() (any, error) {
		keyring, err := orm.NewAESKeyring(map[int32]string{1: "bench-salt"}, 1)
		if err != nil {
			return nil, err
		}
		status, err := db.Utils().Aes().Status(model.Battle(), keyring)
		if err != nil {
			return nil, err
		}
		versions := []string{}
		for v, n := range status.Versions {
			versions = append(versions, fmt.Sprintf("%d:%d", v, n))
		}
		sort.Strings(versions)
		return map[string]any{"current": status.Current, "pending": status.Pending, "versions": strings.Join(versions, ",")}, nil
	})

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	check(enc.Encode(out))
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner_go:", err)
		os.Exit(1)
	}
}
