// Conformance runner (Go). Runs every vector against the bench database and
// prints {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}; the
// other runners print the same document for the same chains.
//
// Usage: runner_go -dsn URI [-vector NAME]...
//
// -vector는 반복할 수 있고, 주어지면 이름이 같은 vector만 실행해 출력한다.
// 선언되지 않은 이름은 아무 vector도 실행하기 전에 error로 끝난다.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"
)

// stmt는 statement event 하나다(docs/usage.md "Statement events"). transaction은
// vector 안에서 처음 나온 순서로 1부터 다시 센 번호이고 밖이면 null이다. error는
// statement의 오류 code이거나 null이다.
type stmt struct {
	SQL         string   `json:"sql"`
	Binds       []any    `json:"binds"`
	Kind        string   `json:"kind"`
	Tables      []string `json:"tables"`
	Transaction *int64   `json:"transaction"`
	Error       *string  `json:"error"`
}

type vector struct {
	Statements []stmt `json:"statements"`
	Result     any    `json:"result"`
}

var (
	log []stmt
	// transactions는 vector 안의 transaction 번호를 처음 나온 순서의 번호로 바꾼다.
	transactions map[int64]int64
	maskSeqs     map[int64]bool
	maskTs       map[string]bool
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
		if strings.HasPrefix(x, "ORM-AES2\x00") {
			if len(x) < 9+12+16 {
				panic("invalid AES ciphertext bind")
			}
			return "$AES"
		}
		if !utf8.ValidString(x) {
			panic("invalid UTF-8 query bind")
		}
		if maskTs[x] {
			return "$TS"
		}
		if strings.HasPrefix(x, "ORM-AES2") {
			panic("invalid AES ciphertext bind")
		}
		if strings.HasPrefix(strings.ToLower(x), "4f524d2d41455332") {
			decoded, err := hex.DecodeString(x)
			if err != nil || !bytes.HasPrefix(decoded, []byte("ORM-AES2\x00")) || len(decoded) < 9+12+16 {
				panic("invalid hex AES ciphertext bind")
			}
			return "$AES"
		}
		return x
	case []byte:
		if bytes.HasPrefix(x, []byte("ORM-AES2\x00")) {
			if len(x) < 9+12+16 {
				panic("invalid AES ciphertext bind")
			}
			return "$AES"
		}
		if !utf8.Valid(x) {
			panic("invalid UTF-8 query bind")
		}
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

var dsn = ""

// pick keeps the named values of a row.
func pick(m orm.Model, names ...string) map[string]any {
	if m == nil || m.Orm_() == nil {
		return nil
	}
	all := m.Orm_().ToArray()
	out := map[string]any{}
	for _, n := range names {
		value, ok := all[n]
		if !ok {
			panic("missing selected field: " + n)
		}
		out[n] = value
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

func keysOf[T orm.Model](c *orm.Collection[T]) ([]any, error) {
	out := []any{}
	for _, k := range c.Keys() {
		value, err := k.Value()
		if err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, nil
}

func executeVector(name string, fn func() (any, error), transaction func(func() error) error) (any, error) {
	var result any
	var err error
	if transaction == nil {
		result, err = fn()
	} else {
		err = transaction(func() error {
			result, err = fn()
			return err
		})
	}
	if err != nil {
		return nil, fmt.Errorf("conformance vector %s failed: %w", name, err)
	}
	return result, nil
}

// main은 run의 종료 코드로 끝난다. os.Exit는 defer를 실행하지 않으므로 run 안에서는 부르지 않는다: 실패한
// check는 exit panic으로 run까지 올라오고, 그 사이의 defer(연결 닫기)가 실행된다.
func main() {
	os.Exit(run())
}

// exit는 check가 run을 끝내는 panic이고, 값은 종료 코드다.
type exit int

func run() (status int) {
	defer func() {
		if recovered := recover(); recovered != nil {
			value, ok := recovered.(exit)
			if !ok {
				panic(recovered)
			}
			status = int(value)
		}
	}()
	var err error
	var selected map[string]bool
	dsn, selected, err = parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner_go:", err)
		fmt.Fprintln(os.Stderr, "usage: runner_go -dsn URI [-vector NAME]...")
		return 2
	}
	db, err := model.Connect(dsn, orm.Config{
		AESKey:        "bench-salt",
		BlindIndexKey: "bench-blind-index",
	})
	check(err)
	defer db.Close()
	db.Subscribe(func(e orm.StatementEvent) error {
		binds := make([]any, len(e.Binds))
		for i, a := range e.Binds {
			binds[i] = norm(a)
		}
		record := stmt{SQL: e.SQL, Binds: binds, Kind: e.Kind, Tables: e.Tables}
		if e.Transaction != 0 {
			n, ok := transactions[e.Transaction]
			if !ok {
				n = int64(len(transactions) + 1)
				transactions[e.Transaction] = n
			}
			record.Transaction = &n
		}
		if e.Err != nil {
			code := orm.ErrorCode(e.Err)
			record.Error = &code
		}
		log = append(log, record)
		return nil
	})

	out := map[string]vector{}
	writeVectors := map[string]bool{
		"write_cycle": true, "now_defaults": true, "required_columns": true,
		"creates_and_save": true, "delete_recursive": true,
	}
	// vector는 선언 순서대로 모은 뒤, 선택을 검사하고 그 순서로 실행한다.
	var declared []declaredVector
	run := func(name string, fn func() (any, error)) {
		declared = append(declared, declaredVector{name: name, fn: fn})
	}
	execute := func(name string, fn func() (any, error)) {
		log, maskSeqs, maskTs, transactions = nil, map[int64]bool{}, map[string]bool{}, map[int64]int64{}
		var transaction func(func() error) error
		if writeVectors[name] {
			transaction = func(task func() error) error { return db.Transaction(task, orm.Retry(0)) }
		}
		res, err := executeVector(name, fn, transaction)
		if err != nil {
			panic(err)
		}
		out[name] = vector{Statements: append([]stmt{}, log...), Result: res}
	}
	author := func() *model.AuthorModel { return model.Author().Connect(db) }
	cols := []string{"seq", "name", "is_close", "is_display", "read_count"}

	run("conditions_connectors", func() (any, error) {
		rows, err := author().ServiceSeq(7).AndIsClose(false).Or().ReadCount(6).OrderBySeqAsc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return picks(rows, cols...), nil
	})
	run("conditions_group", func() (any, error) {
		rows, err := author().ServiceSeq(7).
			And(func(q *model.AuthorModel) {
				q.IsDisplay(false).Or(func(q *model.AuthorModel) { q.IsClose(true).AndGtReadCount(500) })
			}).
			OrderBySeqDesc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return picks(rows, cols...), nil
	})
	run("conditions_leading_group", func() (any, error) {
		rows, err := author().
			And(func(q *model.AuthorModel) { q.IsDisplay(false).OrIsClose(true) }).
			AndServiceSeq(7).
			OrderBySeqDesc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return picks(rows, cols...), nil
	})
	run("conditions_leading_prefix", func() (any, error) {
		rows, err := author().AndServiceSeq(7).AndGtReadCount(990).OrderBySeqDesc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return picks(rows, cols...), nil
	})
	run("conditions_values", func() (any, error) {
		counts := []any{}
		for _, q := range []*model.AuthorModel{
			author().ServiceSeq([]int64{7, 8}).AndNeIsClose(true),
			author().ServiceSeq(7).AndUuid(orm.Null),
			author().ServiceSeq(7).AndNePhotoUrl(orm.Null),
			author().ServiceSeq(7).AndNeReadCount([]int64{6, 106, 206}),
			author().ServiceSeq(7).AndBetweenReadCount([2]int64{100, 200}),
			author().ServiceSeq(7).AndLkName("uthor-10"),
			author().ServiceSeq(7).AndLbName("Author-10"),
			author().ServiceSeq(7).AndGeReadCount(990),
			author().ServiceSeq(7).AndLeReadCount(10),
			author().ServiceSeq(7).AndLtSeq(1000),
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
		one, err := author().GetBySeq(42)
		if err != nil {
			return nil, err
		}
		_, missing := author().GetBySeq(-1)
		rows, err := author().OrderBySeqAsc().Limit(0, 2).GetsByServiceSeqAndIsClose(7, false)
		if err != nil {
			return nil, err
		}
		count, err := author().GetCountByServiceSeq(7)
		if err != nil {
			return nil, err
		}
		return map[string]any{"one": pick(one, cols...), "missing": code(missing), "rows": picks(rows, cols...), "count": count}, nil
	})
	run("terminal_reuse", func() (any, error) {
		q := author().ServiceSeq(7).OrderBySeqAsc().Limit(0, 2)
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
	run("expression_forms", func() (any, error) {
		count, err := author().ServiceSeq(7).AndNot(func(q *model.AuthorModel) { q.IsClose(true).OrGtReadCount(500) }).GetCount()
		if err != nil {
			return nil, err
		}
		rows, err := author().Not(func(q *model.AuthorModel) { q.IsDisplay(false) }).AndServiceSeq(7).OrderBySeqDesc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		orCount, err := author().ServiceSeq(7).OrNot(func(q *model.AuthorModel) { q.LtReadCount(990) }).GetCount()
		if err != nil {
			return nil, err
		}
		return map[string]any{"count": count, "rows": picks(rows, "seq", "is_display"), "or_count": orCount}, nil
	})
	run("columns", func() (any, error) {
		none, err := model.Service().Connect(db).RemoveAllColumns().GetBySeq(7)
		if err != nil {
			return nil, err
		}
		added, err := author().RemoveAllColumns().AddColumnName().AddColumnStartDtAliasStartYear(orm.Year()).GetBySeq(42)
		if err != nil {
			return nil, err
		}
		removed, err := model.Service().Connect(db).RemoveColumnName().GetBySeq(7)
		if err != nil {
			return nil, err
		}
		return []any{none.ToArray(), pick(added, "seq", "name", "start_year"), removed.ToArray()}, nil
	})
	run("joins", func() (any, error) {
		service := model.Service().
			On(func(s *model.ServiceModel) { s.GtSeq(0) }).
			Name("service-7")
		rows, err := author().
			RemoveAllColumns().AddColumnName().
			JoinServiceSeqWithSeq(service).
			IsClose(false).
			And(func(q *model.AuthorModel) { q.IsDisplay(true).Or(service) }).
			OrderBySeqAsc().Limit(0, 2).Gets()
		if err != nil {
			return nil, err
		}
		member := model.ServiceMember()
		compared, err := author().
			JoinServiceMemberSeqWithSeq(member).
			ServiceSeq(7).
			AndSuccessCountLtSeq(member).
			GetCount()
		if err != nil {
			return nil, err
		}
		left, err := author().LeftJoinServiceRegionSeqWithSeq(model.ServiceRegion().AliasModule()).
			ServiceSeq(7).OrderBySeqAsc().Limit(0, 1).Gets()
		if err != nil {
			return nil, err
		}
		module, err := left.First().GetModule()
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"rows":     rows.ToArray(),
			"compared": compared,
			"module":   pick(module, "seq", "name"),
		}, nil
	})
	run("relations", func() (any, error) {
		rows, err := author().
			RemoveAllColumns().AddColumnName().AddColumnIsClose().
			Relation(model.User().MatchUserSeqWithSeq().AliasWriter().
				Relations(model.Author().MatchSeqWithUserSeq().RemoveAllColumns().OrderBySeqDesc().GroupLimit(2))).
			Relation(model.Service().MatchServiceSeqWithSeq().
				Relations(model.ServiceMember().MatchSeqWithServiceSeq().RemoveAllColumns().OrderBySeqAsc().GroupLimit(2).KeyNameUserSeq())).
			Relation(model.ServiceRegion().MatchServiceRegionSeqWithSeq().PossibleIsClose(true).ParentNode()).
			ServiceSeq(7).OrderBySeqAsc().Limit(0, 3).Gets()
		if err != nil {
			return nil, err
		}
		return rows.ToArray(), nil
	})
	run("relation_empty", func() (any, error) {
		rows, err := author().Relations(model.ServiceMember().MatchUserSeqWithUserSeq()).GetsBySeq(-1)
		if err != nil {
			return nil, err
		}
		return rows.Len(), nil
	})
	run("subqueries", func() (any, error) {
		users, err := model.User().Connect(db).
			AddColumnReadTotal(func(u *model.UserModel) orm.Model {
				return model.Author().SumReadCount().UserSeqEqSeq(u).AndServiceSeq(7)
			}).
			Seq(model.Author().AddColumnUserSeq().ServiceSeq(7).AndGeReadCount(906)).
			OrderBySeqAsc().Gets()
		if err != nil {
			return nil, err
		}
		out := []any{}
		for _, u := range users.Slice() {
			readTotal, err := orm.AsInt64(u.GetReadTotal())
			if err != nil {
				return nil, err
			}
			out = append(out, []any{u.GetSeq(), readTotal})
		}
		return out, nil
	})
	run("aggregates", func() (any, error) {
		sum, err := author().ServiceSeq(7).SumReadCount().GetSum()
		if err != nil {
			return nil, err
		}
		avg, err := author().ServiceSeq(7).AvgLikeCount().GetAvg()
		if err != nil {
			return nil, err
		}
		if math.Float64bits(avg) != 0x404805c28f5c28f6 {
			return nil, fmt.Errorf("aggregate average has unexpected binary64 value: %.17g", avg)
		}
		groups, err := author().ServiceSeq(7).GroupByIsClose().OrderByIsCloseAsc().GetsCount()
		if err != nil {
			return nil, err
		}
		page, err := author().ServiceSeq(7).RemoveAllColumns().OrderBySeqAsc().GetsPage(3, 4)
		if err != nil {
			return nil, err
		}
		pageKeys, err := keysOf(page.Items)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"sum":    sum,
			"avg":    fmt.Sprintf("%.4f", avg),
			"groups": groups.ToArray(),
			"page":   map[string]any{"keys": pageKeys, "total": page.TotalCount, "pages": page.TotalPages, "page": page.Page, "per_page": page.PerPage},
		}, nil
	})
	run("functions", func() (any, error) {
		counts := []any{}
		for _, q := range []*model.AuthorModel{
			author().ServiceSeq(7).AndEqStartDt(orm.DayOfWeek(), 2),
			author().ServiceSeq(7).AndStartDt(orm.Year(), 2026),
			author().ServiceSeq(7).AndGtStartDt(orm.DaysAgo(36500)),
			author().ServiceSeq(7).AndLtStartDt(orm.MonthsLater(1200)),
		} {
			n, err := q.GetCount()
			if err != nil {
				return nil, err
			}
			counts = append(counts, n)
		}
		rows, err := author().RemoveAllColumns().AddColumnStartDtAliasStartMonth(orm.Month()).
			OrderByStartDtAsc(orm.Year()).OrderBySeqAsc().GetsBySeq([]int64{42, 43})
		if err != nil {
			return nil, err
		}
		months := []any{}
		for _, r := range rows.Slice() {
			month, err := orm.AsInt64(r.GetStartMonth())
			if err != nil {
				return nil, err
			}
			months = append(months, month)
		}
		return map[string]any{"counts": counts, "months": months}, nil
	})
	run("errors", func() (any, error) {
		var errs []any
		_, err := author().Name("a").IsClose(true).Gets()
		errs = append(errs, code(err))
		_, err = author().Name("a").And().Gets()
		errs = append(errs, code(err))
		_, err = author().Seq([]int64{}).Gets()
		errs = append(errs, code(err))
		_, err = model.Author().Name("a").Gets()
		errs = append(errs, code(err))
		_, err = author().ForUpdate().Gets()
		errs = append(errs, code(err))
		_, err = author().JoinUserSeqWithSeq(model.User().Connect(db)).Gets()
		errs = append(errs, code(err))
		_, err = author().Limit(0, 1).GetsPage(1, 10)
		errs = append(errs, code(err))
		_, err = author().Relation(model.User().MatchUserSeqWithSeq().Limit(0, 1)).GetsBySeq(42)
		errs = append(errs, code(err))
		_, err = author().Name("a").Or(model.User()).Gets()
		errs = append(errs, code(err))
		return errs, nil
	})
	run("get_query", func() (any, error) {
		st, err := author().ServiceSeq(7).AndLkName("x").AndAesHexEmail("user7@example.com").OrderBySeqDesc().Limit(0, 5).GetQuery()
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
		row, err := author().RemoveAllColumns().AddColumnAesHexEmail().AddColumnAesHexPhone().GetBySeq(42)
		if err != nil {
			return nil, err
		}
		found, err := author().AesHexEmail("user42@example.com").GetCount()
		if err != nil {
			return nil, err
		}
		return map[string]any{"row": row.ToArray(), "found": found}, nil
	})
	run("write_cycle", func() (any, error) {
		start := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
		price := "12.500"
		ip := "10.0.0.1"
		email := "cycle@example.com"
		row, err := author().
			SetName("cycle").SetUserSeq(1).SetServiceSeq(999).SetServiceRegionSeq(1).SetServiceMemberSeq(1).
			SetStartDt(start).SetEndDt(start).SetPrice(&price)
		if err != nil {
			return nil, err
		}
		row = row.SetIp(&ip).SetAesHexEmail(&email)
		row, err = row.SetJsonSetting(orm.Value(map[string]any{"a": 1}))
		if err != nil {
			return nil, err
		}
		row, err = row.SetSerializeData(orm.Value(map[string]any{"k": "v"}))
		if err != nil {
			return nil, err
		}
		created, err := row.NewLabel("created").Create()
		if err != nil {
			return nil, err
		}
		seq := created.GetSeq()
		mask([]int64{seq})
		createdArray := created.ToArray()
		createdArray["seq"] = "$SEQ"
		loaded, err := author().AddAllColumns().GetBySeq(seq)
		if err != nil {
			return nil, err
		}
		mask(nil, loaded.GetUpdatedTs())
		if _, err := loaded.SetName("cycle-2").PlusReadCount(3).Update(true); err != nil {
			return nil, err
		}
		_, stale := loaded.SetName("stale").Update(true)
		again, err := author().AddAllColumns().GetBySeq(seq)
		if err != nil {
			return nil, err
		}
		updated := pick(again, "name", "read_count", "price", "ip", "aes_hex_email", "json_setting", "serialize_data", "start_dt")
		if err := again.Delete(); err != nil {
			return nil, err
		}
		_, gone := author().GetBySeq(seq)
		return map[string]any{"created": createdArray, "updated": updated, "stale": code(stale), "deleted": code(gone)}, nil
	})
	run("now_defaults", func() (any, error) {
		start := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
		before := time.Now()
		created, err := author().
			SetName("clock").SetUserSeq(1).SetServiceSeq(999).SetServiceRegionSeq(1).SetServiceMemberSeq(1).
			SetStartDt(start).SetEndDt(start).
			Create()
		if err != nil {
			return nil, err
		}
		seq := created.GetSeq()
		mask([]int64{seq})
		loaded, err := author().GetBySeq(seq)
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
	run("required_columns", func() (any, error) {
		task := func() *model.TaskModel { return model.Task().Connect(db) }
		failure := func(err error) any {
			if err == nil {
				return nil
			}
			return map[string]any{"error": code(err), "message": err.Error()}
		}
		_, missingState := task().SetTitle("draft").Create()
		_, missingTitle := task().SetState("open").Create()
		created, err := task().SetTitle("draft").SetState("open").Create()
		if err != nil {
			return nil, err
		}
		mask([]int64{created.GetSeq()})
		if err := created.Delete(); err != nil {
			return nil, err
		}
		return map[string]any{"missing_state": failure(missingState), "missing_title": failure(missingTitle)}, nil
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
		related, err := loaded.GetServiceMemberModels()
		if err != nil {
			return nil, err
		}
		members := related.Len()
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
			if err := db.Utils().SetLocal("ormtest.actor", "runner"); err != nil {
				return err
			}
			actor, err := db.Utils().Local("ormtest.actor")
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
	run("restore", func() (any, error) {
		// soft delete한 행을 primary key로 되돌린다. 지운 시각은 고정한 값으로 써서 모든
		// database와 runner의 bind가 같다. transaction은 끝에 rollback하므로 database는 처음과
		// 같다.
		boom := errors.New("boom")
		result := map[string]any{}
		err := db.Transaction(func() error {
			created, err := model.SoftRecord().SetName("restore").Create()
			if err != nil {
				return err
			}
			seq := created.GetSeq()
			mask([]int64{seq})
			deletedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
			if _, err := created.SetDeletedAt(&deletedAt).Update(); err != nil {
				return err
			}
			_, hidden := model.SoftRecord().GetBySeq(seq)
			result["hidden"] = code(hidden)
			// key 밖의 값은 지워진 행을 되돌릴 때만 쓴다. 두 번째 restore는 지워지지 않은
			// 행을 바꾸지 않고 돌려준다.
			for _, step := range [][2]string{{"restored", "restore-2"}, {"again", "ignored"}} {
				name := step[0]
				row, err := model.SoftRecord().SetSeq(seq).SetName(step[1]).Restore()
				if err != nil {
					return err
				}
				array := row.ToArray()
				array["seq"] = "$SEQ"
				result[name] = array
			}
			_, missing := model.SoftRecord().SetSeq(0).Restore()
			result["missing"] = code(missing)
			return boom
		}, orm.Retry(0))
		if !errors.Is(err, boom) {
			return nil, err
		}
		left, err := model.SoftRecord().Connect(db).Name("restore").GetCount()
		result["left"] = left
		return result, err
	})
	run("aes_status", func() (any, error) {
		keyring, err := orm.NewAESKeyring(map[int32]string{1: "bench-salt"}, 1)
		if err != nil {
			return nil, err
		}
		status, err := db.Utils().Aes().Status(model.Author(), keyring)
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

	vectors, err := selectVectors(declared, selected)
	check(err)
	for _, v := range vectors {
		execute(v.name, v.fn)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	check(enc.Encode(out))
	return 0
}

// declaredVector는 runner가 선언한 vector 하나다.
type declaredVector struct {
	name string
	fn   func() (any, error)
}

// parseArgs는 -dsn URI 한 번과 반복할 수 있는 -vector NAME을 읽는다.
// selected가 nil이면 모든 vector를 실행한다.
func parseArgs(args []string) (string, map[string]bool, error) {
	uri := ""
	var selected map[string]bool
	for i := 0; i < len(args); i += 2 {
		if i+1 >= len(args) || args[i+1] == "" {
			return "", nil, fmt.Errorf("flag %s requires a value", args[i])
		}
		switch value := args[i+1]; args[i] {
		case "-dsn":
			if uri != "" {
				return "", nil, errors.New("flag -dsn is given twice")
			}
			uri = value
		case "-vector":
			if selected == nil {
				selected = map[string]bool{}
			}
			if selected[value] {
				return "", nil, fmt.Errorf("vector %s is selected twice", value)
			}
			selected[value] = true
		default:
			return "", nil, fmt.Errorf("unknown flag %s", args[i])
		}
	}
	if uri == "" {
		return "", nil, errors.New("flag -dsn is required; give the DSN of the bench database with -dsn")
	}
	return uri, selected, nil
}

// selectVectors는 선택된 vector를 선언 순서로 반환한다. selected가 nil이면
// 모든 vector이고, 선언되지 않은 이름은 error다.
func selectVectors(declared []declaredVector, selected map[string]bool) ([]declaredVector, error) {
	if selected == nil {
		return declared, nil
	}
	known := map[string]bool{}
	var out []declaredVector
	for _, v := range declared {
		known[v.name] = true
		if selected[v.name] {
			out = append(out, v)
		}
	}
	var unknown []string
	for name := range selected {
		if !known[name] {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, fmt.Errorf("unknown vector %s", strings.Join(unknown, ", "))
	}
	return out, nil
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner_go:", err)
		panic(exit(1))
	}
}
