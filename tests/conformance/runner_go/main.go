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
	"reflect"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
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

// clockVectors declares the vectors that fix the executor clock through the test
// entry point; clock_ormtest.go sets it in a build with the tag ormtest.
var clockVectors func(run func(string, func() (any, error)), db *orm.DB)

// affectedVectors declares the vectors that read the write result through the test
// entry point; affected_ormtest.go sets it in a build with the tag ormtest.
var affectedVectors func(run func(string, func() (any, error)), db *orm.DB)

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
	// A getter's nil model reaches pick as an interface that holds a typed nil, so the interface is not nil.
	if m == nil || reflect.ValueOf(m).IsNil() || m.Orm_() == nil {
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

// dateOnly writes a date cell as its YYYY-MM-DD text, whether the driver gave a time or the datetime text of it, the form every other runner returns for a date column.
func dateOnly(rows []any) []any {
	for _, r := range rows {
		m, ok := r.(map[string]any)
		if !ok || m == nil {
			continue
		}
		switch v := m["day"].(type) {
		case time.Time:
			m["day"] = v.Format("2006-01-02")
		case *time.Time:
			if v != nil {
				m["day"] = v.Format("2006-01-02")
			}
		case string:
			if len(v) > 10 && v[10] == ' ' {
				m["day"] = v[:10]
			}
		}
	}
	return rows
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

// containsVector는 tenant 902에 이름 Apple, apple, Évian, évian, x_y의 행을 만들고, 각 pattern이 cond로
// 고르는 account_id를 차례로 모은 뒤 행을 지운다.
func containsVector(db *orm.DB, cond func(*model.CompositeAccountModel, string) *model.CompositeAccountModel, patterns ...string) (any, error) {
	var rows []*model.CompositeAccountModel
	for i, name := range []string{"Apple", "apple", "Évian", "évian", "x_y"} {
		rows = append(rows, model.CompositeAccount().SetTenantId(902).SetAccountId(int64(i+1)).SetName(name))
	}
	if _, err := model.CompositeAccount().Connect(db).Creates(rows); err != nil {
		return nil, err
	}
	matches := []any{}
	for _, p := range patterns {
		found, err := cond(model.CompositeAccount().Connect(db).TenantId(902), p).OrderByAccountIdAsc().Gets()
		if err != nil {
			return nil, err
		}
		matches = append(matches, picks(found, "account_id"))
	}
	all, err := model.CompositeAccount().Connect(db).TenantId(902).OrderByAccountIdAsc().Gets()
	if err != nil {
		return nil, err
	}
	return matches, all.Delete()
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
	_, err = db.Subscribe(func(e orm.StatementEvent) error {
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
	check(err)

	out := map[string]vector{}
	writeVectors := map[string]bool{
		"write_cycle": true, "now_defaults": true, "required_columns": true,
		"creates_and_save": true, "delete_recursive": true, "contains_ascii_fold": true, "contains_binary_code_point": true,
		"datetime_p0_roundtrip": true, "time_p3_roundtrip": true, "date_roundtrip": true, "date_null": true, "upsert_one_key": true, "uuid_roundtrip": true, "affected_counts": true,
		"clock_truncate_write": true, "clock_compare_six_digits": true,
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
			SetStartDt(dateTimeText(start)).SetEndDt(dateTimeText(start)).SetPrice(&price)
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
			SetStartDt(dateTimeText(start)).SetEndDt(dateTimeText(start)).
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
	run("contains_ascii_fold", func() (any, error) {
		return containsVector(db, func(q *model.CompositeAccountModel, p string) *model.CompositeAccountModel { return q.AndLkName(p) }, "PPL", "ÉV", "_", "")
	})
	run("contains_binary_code_point", func() (any, error) {
		return containsVector(db, func(q *model.CompositeAccountModel, p string) *model.CompositeAccountModel { return q.AndLbName(p) }, "pp", "É", "PPL", "_")
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
			if _, err := created.SetDeletedAt(textPtr(dateTimeText(deletedAt))).Update(); err != nil {
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
	run("joins_soft_deleted", func() (any, error) {
		// A joined soft_record row that is soft deleted meets no parent: the inner join drops the
		// parent and the left join gives it a null child. The transaction rolls back at the end, so
		// the database is as it was.
		boom := errors.New("boom")
		names := []string{"soft-join-live", "soft-join-deleted"}
		result := map[string]any{}
		err := db.Transaction(func() error {
			for _, name := range names {
				service, err := model.Service().SetName(name).Create()
				if err != nil {
					return err
				}
				record, err := model.SoftRecord().SetName(name).Create()
				if err != nil {
					return err
				}
				mask([]int64{service.GetSeq(), record.GetSeq()})
				if name == "soft-join-deleted" {
					deletedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
					if _, err := record.SetDeletedAt(textPtr(dateTimeText(deletedAt))).Update(); err != nil {
						return err
					}
				}
			}
			inner, err := model.Service().JoinNameWithName(model.SoftRecord().AliasRecord()).
				Name(names).OrderByNameAsc().Gets()
			if err != nil {
				return err
			}
			result["inner"] = picks(inner, "name")
			left, err := model.Service().LeftJoinNameWithName(model.SoftRecord().AliasRecord()).
				Name(names).OrderByNameAsc().Gets()
			if err != nil {
				return err
			}
			rows := []any{}
			for _, row := range left.Slice() {
				record, err := row.GetRecord()
				if err != nil {
					return err
				}
				rows = append(rows, map[string]any{"name": row.GetName(), "record": pick(record, "name")})
			}
			result["left"] = rows
			return boom
		}, orm.Retry(0))
		if !errors.Is(err, boom) {
			return nil, err
		}
		return result, nil
	})
	run("column_pairs", func() (any, error) {
		// Two compared columns meet as dbspec check operands do (docs/dbspec.md "Checks"): a comparison of two
		// columns, a column in a subquery column, a join and a relation run when their columns meet, here i32 with i64
		// and text with varchar, and fail with OPERATOR_NOT_ALLOWED before any statement when they do not.
		result := map[string]any{}
		joined := func() *model.ServiceModel { return model.Service() }
		meets := []struct {
			name  string
			count func() (int64, error)
		}{
			{"col_i32_i64", func() (int64, error) {
				s := joined()
				return author().JoinServiceSeqWithSeq(s).ReadCountLtSeq(s).GetCount()
			}},
			{"col_text_varchar", func() (int64, error) {
				s := joined()
				return author().JoinServiceSeqWithSeq(s).DescriptionNeName(s).GetCount()
			}},
			{"in_i32_i64", func() (int64, error) {
				return author().LikeCount(model.User().AddColumnSeq()).GetCount()
			}},
			{"join_i32_i64", func() (int64, error) {
				return author().JoinReadCountWithSeq(joined()).GetCount()
			}},
			{"relation_i32_i64", func() (int64, error) {
				rows, err := author().Relation(model.Service().MatchLikeCountWithSeq()).OrderBySeqAsc().Limit(0, 2).Gets()
				if err != nil {
					return 0, err
				}
				return int64(len(rows.Slice())), nil
			}},
		}
		for _, m := range meets {
			n, err := m.count()
			if err != nil {
				return nil, err
			}
			result[m.name] = n
		}
		refused := []struct {
			name string
			run  func() error
		}{
			{"col_varchar_i64", func() error {
				s := joined()
				_, err := author().JoinServiceSeqWithSeq(s).NameEqSeq(s).GetCount()
				return err
			}},
			{"col_decimal_i64", func() error {
				s := joined()
				_, err := author().JoinServiceSeqWithSeq(s).PriceEqSeq(s).GetCount()
				return err
			}},
			{"in_varchar_i64", func() error {
				_, err := author().Name(model.User().AddColumnSeq()).GetCount()
				return err
			}},
			{"join_varchar_i64", func() error {
				_, err := author().JoinNameWithSeq(joined()).GetCount()
				return err
			}},
			{"relation_varchar_i64", func() error {
				_, err := author().Relation(model.Service().MatchNameWithSeq()).Limit(0, 1).Gets()
				return err
			}},
		}
		for _, r := range refused {
			result[r.name] = code(r.run())
		}
		return result, nil
	})
	run("relative_time_out_of_range", func() (any, error) {
		// A relative time function outside 0001-01-01 to 9999-12-31, or with an interval no database represents, is NULL, so
		// a comparison and its negation both match no row. secondsAgo takes an integer in every client, so 1e15 seconds
		// stands for an interval past every bound.
		counts := map[string]any{}
		for _, c := range []struct {
			name string
			f    orm.Func
		}{
			{"seconds_ago", orm.SecondsAgo(1000000000000000)},
			{"days_later", orm.DaysLater(4000000)},
			{"months_ago", orm.MonthsAgo(200000)},
		} {
			name, f := c.name, c.f
			gt, err := author().AndGtStartDt(f).GetCount()
			if err != nil {
				return nil, err
			}
			le, err := author().AndLeStartDt(f).GetCount()
			if err != nil {
				return nil, err
			}
			counts[name] = []any{gt, le}
		}
		return counts, nil
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
	// the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
	run("hex_malformed", func() (any, error) {
		_, whiteSpace := model.HexCell().Connect(db).GetBySeq(1)
		_, oddLength := model.HexCell().Connect(db).GetBySeq(2)
		return map[string]any{"white_space": code(whiteSpace), "odd_length": code(oddLength)}, nil
	})

	// A datetime(p) or time(p) value is bound with exactly p fraction digits, the
	// form the SQLite CHECK of the column requires (docs/dialects.md); zeros past p
	// are dropped. Each vector inserts, reads the row back by the same parameter and
	// deletes it.
	timeCell := func() *model.TimeCellModel { return model.TimeCell().Connect(db) }
	at := time.Date(2026, 6, 1, 12, 34, 56, 0, time.UTC)
	run("datetime_p0_roundtrip", func() (any, error) {
		row, err := timeCell().SetAt(dateTimeText(at)).SetClock("10:11:12")
		if err != nil {
			return nil, err
		}
		created, err := row.Create()
		if err != nil {
			return nil, err
		}
		mask([]int64{created.GetSeq()})
		rows, err := timeCell().At(dateTimeText(at)).Gets()
		if err != nil {
			return nil, err
		}
		if err := created.Delete(); err != nil {
			return nil, err
		}
		return picks(rows, "clock"), nil
	})
	run("time_p3_roundtrip", func() (any, error) {
		row, err := timeCell().SetAt(dateTimeText(at)).SetClock("10:11:12.345000")
		if err != nil {
			return nil, err
		}
		created, err := row.Create()
		if err != nil {
			return nil, err
		}
		mask([]int64{created.GetSeq()})
		rows, err := timeCell().Clock("10:11:12.345").Gets()
		if err != nil {
			return nil, err
		}
		if err := created.Delete(); err != nil {
			return nil, err
		}
		return picks(rows, "clock"), nil
	})

	// A date and a time(0) column read back as their text form (the driver's date and time values are the codec's input).
	dayCell := func() *model.DayCellModel { return model.DayCell().Connect(db) }
	run("date_roundtrip", func() (any, error) {
		day := "2026-06-01"
		atTime := "10:11:12"
		row, err := dayCell().SetLabel("date").SetDay(&day).SetAtTime(&atTime)
		if err != nil {
			return nil, err
		}
		created, err := row.Create()
		if err != nil {
			return nil, err
		}
		mask([]int64{created.GetSeq()})
		rows, err := dayCell().Label("date").Gets()
		if err != nil {
			return nil, err
		}
		if err := created.Delete(); err != nil {
			return nil, err
		}
		return dateOnly(picks(rows, "day", "at_time")), nil
	})
	run("date_null", func() (any, error) {
		created, err := dayCell().SetLabel("nil").Create()
		if err != nil {
			return nil, err
		}
		mask([]int64{created.GetSeq()})
		rows, err := dayCell().Label("nil").Gets()
		if err != nil {
			return nil, err
		}
		if err := created.Delete(); err != nil {
			return nil, err
		}
		return dateOnly(picks(rows, "day", "at_time")), nil
	})

	// An upsert has exactly one conflict key (docs/protocol.md 1): upsert_cell
	// leaves its identity primary key out, so the unique key on code is the one key
	// that can meet the row; an insert that does not assign code is IR_INVALID
	// before any statement.
	upsertCell := func() *model.UpsertCellModel { return model.UpsertCell().Connect(db) }
	run("upsert_one_key", func() (any, error) {
		created, err := upsertCell().SetCode("k1").SetLabel("first").
			Duplication(model.UpsertCell().SetLabel("second")).Create()
		if err != nil {
			return nil, err
		}
		mask([]int64{created.GetSeq()})
		inserted, err := upsertCell().Code("k1").Gets()
		if err != nil {
			return nil, err
		}
		if _, err := upsertCell().SetCode("k1").SetLabel("other").
			Duplication(model.UpsertCell().SetLabel("second")).Create(); err != nil {
			return nil, err
		}
		updated, err := upsertCell().Code("k1").Gets()
		if err != nil {
			return nil, err
		}
		_, unassigned := upsertCell().SetLabel("none").
			Duplication(model.UpsertCell().SetLabel("second")).Create()
		if err := updated.Delete(); err != nil {
			return nil, err
		}
		failure := map[string]any{"error": code(unassigned), "message": fmt.Sprint(unassigned)}
		return map[string]any{"inserted": picks(inserted, "label"), "updated": picks(updated, "label"), "unassigned": failure}, nil
	})

	// A PostgreSQL uuid column is read as its text and a uuid value is bound as
	// text cast to uuid, in one form in every planner (docs/dialects.md); the
	// vector inserts, reads the row back by the same value and deletes it.
	run("uuid_roundtrip", func() (any, error) {
		created, err := model.UuidCell().Connect(db).SetId("0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5").Create()
		if err != nil {
			return nil, err
		}
		mask([]int64{created.GetSeq()})
		rows, err := model.UuidCell().Connect(db).Id("0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5").Gets()
		if err != nil {
			return nil, err
		}
		if err := created.Delete(); err != nil {
			return nil, err
		}
		return picks(rows, "id"), nil
	})

	// A value outside the logical type of its slot is CODEC_ENCODE before any statement
	// (docs/protocol.md §5 "Parameters"). A create that the client lets through is deleted,
	// so the vector leaves the database as it found it.
	rejected := func(created interface {
		GetSeq() int64
		Delete(...bool) error
	}, err error) (any, error) {
		if err == nil {
			mask([]int64{created.GetSeq()})
			if err := created.Delete(); err != nil {
				return nil, err
			}
		}
		return map[string]any{"code": code(err)}, nil
	}
	bindCell := func() *model.BindCellModel { return model.BindCell().Connect(db) }
	run("datetime_precision_rejected", func() (any, error) {
		row, err := timeCell().SetAt(dateTimeText(at.Add(500 * time.Millisecond))).SetClock("10:11:12")
		if err != nil {
			return nil, err
		}
		return rejected(row.Create())
	})
	run("varchar_length_rejected", func() (any, error) {
		return rejected(bindCell().SetLabel("123456789").Create())
	})
	run("text_nul_rejected", func() (any, error) {
		body := "a\x00b"
		return rejected(bindCell().SetLabel("nul").SetBody(&body).Create())
	})
	run("uuid_form_rejected", func() (any, error) {
		token := "123E4567-E89B-12D3-A456-426614174000"
		return rejected(bindCell().SetLabel("uuid").SetToken(&token).Create())
	})

	// A contains value NULL binds NULL, so `col LIKE NULL` matches no row (docs/protocol.md §2).
	run("contains_null", func() (any, error) {
		q := author().ServiceSeq(7)
		q.Orm_().Where("and", []orm.ChainKey{{Op: "lk", Column: "name"}}, orm.Null)
		n, err := q.GetCount()
		if err != nil {
			return map[string]any{"code": code(err), "count": nil}, nil
		}
		return map[string]any{"code": nil, "count": n}, nil
	})

	// A parameter that assigns NULL to a non-null column is CODEC_ENCODE before any statement
	// (docs/protocol.md §5 "Parameters"); creates binds each row value as a parameter.
	run("null_into_not_null", func() (any, error) {
		null := model.BindCell()
		null.Orm_().SetNull("label")
		_, err := bindCell().Creates([]*model.BindCellModel{model.BindCell().SetLabel("a"), null})
		return map[string]any{"code": code(err)}, nil
	})

	// The clock vectors need the test entry point of the client, which only a build
	// with the tag ormtest has (clock_ormtest.go); conformance builds the runner with
	// it, and the checker refuses an output that lacks a declared vector.
	if affectedVectors != nil {
		affectedVectors(run, db)
	}
	if clockVectors != nil {
		clockVectors(run, db)
	}

	// the seed prices the authors of service 100 except a seq that is a multiple of 3 (benchmarks/sql/seed.*.sql)
	run("order_nulls", func() (any, error) {
		asc, err := author().RemoveAllColumns().AddColumnPrice().
			ServiceSeq(100).AndLtSeq(500).OrderByPriceAsc().OrderBySeqAsc().Gets()
		if err != nil {
			return nil, err
		}
		desc, err := author().RemoveAllColumns().AddColumnPrice().
			ServiceSeq(100).AndLtSeq(500).OrderByPriceDesc().OrderBySeqAsc().Gets()
		if err != nil {
			return nil, err
		}
		perParent := map[string]any{}
		for _, order := range []string{"asc", "desc"} {
			child := model.Author().MatchSeqWithUserSeq().RemoveAllColumns().AddColumnPrice()
			if order == "asc" {
				child.OrderByPriceAsc()
			} else {
				child.OrderByPriceDesc()
			}
			users, err := model.User().Connect(db).Relations(child.OrderBySeqAsc().GroupLimit(2)).Seq(100).Gets()
			if err != nil {
				return nil, err
			}
			perParent[order] = users.ToArray()
		}
		return map[string]any{"asc": asc.ToArray(), "desc": desc.ToArray(), "limit_per_parent": perParent}, nil
	})

	// user 100 has the authors 99 (price NULL) and 5099 (price 3.000) under seq 10000 (benchmarks/sql/seed.*.sql)
	run("scalar_column_subquery", func() (any, error) {
		out := map[string]any{}
		for _, order := range []string{"asc", "desc"} {
			users, err := model.User().Connect(db).
				AddColumnReadTotal(func(u *model.UserModel) orm.Model {
					sub := model.Author().RemoveAllColumns().AddColumnName().UserSeqEqSeq(u).AndLtSeq(10000)
					if order == "asc" {
						sub.OrderByPriceAsc()
					} else {
						sub.OrderByPriceDesc()
					}
					return sub.OrderBySeqAsc().Limit(0, 1)
				}).
				Seq(100).Gets()
			if err != nil {
				return nil, err
			}
			rows := []any{}
			for _, u := range users.Slice() {
				rows = append(rows, []any{u.GetSeq(), u.GetReadTotal()})
			}
			out[order] = rows
		}
		return out, nil
	})

	// a flattened region of a closed author (seq, name and service_seq collide with the parent; absent for an open author) that holds a flattened service (seq and name collide) with its service members
	run("relations_flatten", func() (any, error) {
		rows, err := author().
			RemoveAllColumns().AddColumnName().AddColumnIsClose().
			Relation(model.ServiceRegion().MatchServiceRegionSeqWithSeq().PossibleIsClose(true).ParentNode().
				Relation(model.Service().MatchServiceSeqWithSeq().ParentNode().
					Relations(model.ServiceMember().MatchSeqWithServiceSeq().RemoveAllColumns().OrderBySeqAsc().GroupLimit(2)))).
			ServiceSeq(7).OrderBySeqAsc().Limit(0, 8).Gets()
		if err != nil {
			return nil, err
		}
		return rows.ToArray(), nil
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

// dateTimeText is the text form of a datetime column, which the setters take (T189).
func dateTimeText(t time.Time) string { return t.Format("2006-01-02 15:04:05.999999") }

// textPtr returns the pointer to a text value, the form of a nullable setter.
func textPtr(s string) *string { return &s }
