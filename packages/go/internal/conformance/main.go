// Conformance runner (Go). Runs every vector against the bench database and
// prints {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}; the
// other runners print the same document for the same chains.
//
// Usage: runner_go -dsn URI [-vector NAME]...
//
// -vector can be repeated; when given, only the vectors with matching names are run and printed.
// A name that is not declared ends with an error before any vector runs.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"context"
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

// stmt is one statement event (docs/operations/usage.md "Statement events"). transaction is
// the number counted from 1 again in order of first appearance within the vector, and null outside one. error is
// the error code of the statement, or null.
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
	// transactions renumbers the transaction numbers in the vector in order of first appearance.
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

// containsVector creates rows in tenant 902 with the names Apple, apple, Évian, évian, x_y, and
// collects, in order, the account_id each pattern selects with cond, then deletes the rows.
func containsVector(db *orm.DB, cond func(*model.CompositeAccountModel, string) *model.CompositeAccountModel, patterns ...string) (any, error) {
	var rows []*model.CompositeAccountModel
	for i, name := range []string{"Apple", "apple", "Évian", "évian", "x_y"} {
		rows = append(rows, model.CompositeAccount().SetTenantId(902).SetAccountId(int64(i+1)).SetName(name))
	}
	if _, err := model.CompositeAccount().Connect(db).Creates(rows, len(rows)); err != nil {
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

// main ends with the exit code of run. os.Exit does not run defers, so it is not called inside run: a failed
// check is raised up to run as an exit panic, and the defers in between (closing connections) run.
func main() {
	os.Exit(run())
}

// exit is the panic by which check ends run; its value is the exit code.
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
		AuditSource:   func(context.Context) (map[string]any, error) { return map[string]any{}, nil },
	})
	check(err)
	defer func() { check(db.Close()) }()
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
	// vectors are collected in declaration order, then the selection is checked and they run in that order.
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
	run("relation_null_key", func() (any, error) {
		rows, err := model.User().Connect(db).
			Relations(model.Author().MatchSeqWithUserSeq().KeyNamePrice()).
			Seq(100).Gets()
		if err != nil {
			return map[string]any{"error": code(err), "message": err.Error()}, nil
		}
		return rows.Len(), nil
	})
	// shared_note is a table of the external document bench_shared: it is read through its entity, and a write
	// fails with CONFIG before any statement (docs/spec/dbspec.md "External documents").
	run("external_read", func() (any, error) {
		readers, err := model.NoteReader().Connect(db).
			Relation(model.SharedNote().MatchSharedNoteSeqWithSeq()).
			OrderBySeqAsc().Gets()
		if err != nil {
			return nil, err
		}
		related := []any{}
		for _, r := range readers.Slice() {
			note, err := r.GetSharedNoteModel()
			if err != nil {
				return nil, err
			}
			related = append(related, []any{r.GetSeq(), note.GetTitle()})
		}
		notes, err := model.SharedNote().Connect(db).
			Seq(model.NoteReader().AddColumnSharedNoteSeq()).
			OrderBySeqAsc().Gets()
		if err != nil {
			return nil, err
		}
		titles := []any{}
		for _, n := range notes.Slice() {
			titles = append(titles, n.GetTitle())
		}
		_, err = model.SharedNote().Connect(db).SetSeq(9).SetTitle("written").Create()
		return map[string]any{"relation": related, "subquery": titles, "write": code(err)}, nil
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
		if avg == nil || math.Float64bits(*avg) != 0x404805c28f5c28f6 {
			return nil, fmt.Errorf("aggregate average has unexpected binary64 value: %v", avg)
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
			"avg":    fmt.Sprintf("%.4f", *avg),
			"groups": groups.ToArray(),
			"page":   map[string]any{"keys": pageKeys, "total": page.TotalCount, "pages": page.TotalPages, "page": page.Page, "per_page": page.PerPage},
		}, nil
	})
	run("empty_reads", func() (any, error) {
		get, err := author().Seq(-1).Get()
		if err != nil {
			return nil, err
		}
		getBy, err := author().GetBySeq(-1)
		if err != nil {
			return nil, err
		}
		gets, err := author().Seq(-1).Gets()
		if err != nil {
			return nil, err
		}
		groups, err := author().Seq(-1).GroupByIsClose().GetsCount()
		if err != nil {
			return nil, err
		}
		page, err := author().Seq(-1).RemoveAllColumns().OrderBySeqAsc().GetsPage(1, 10)
		if err != nil {
			return nil, err
		}
		count, err := author().Seq(-1).GetCount()
		if err != nil {
			return nil, err
		}
		sum, err := author().Seq(-1).SumReadCount().GetSum()
		if err != nil {
			return nil, err
		}
		avg, err := author().Seq(-1).AvgLikeCount().GetAvg()
		if err != nil {
			return nil, err
		}
		nullRows, err := author().Price(orm.Null).GetCount()
		if err != nil {
			return nil, err
		}
		nullSum, err := author().Price(orm.Null).SumPrice().GetSum()
		if err != nil {
			return nil, err
		}
		nullAvg, err := author().Price(orm.Null).AvgPrice().GetAvg()
		if err != nil {
			return nil, err
		}
		var getOut, getByOut any
		if get != nil {
			getOut = get.ToArray()
		}
		if getBy != nil {
			getByOut = getBy.ToArray()
		}
		return map[string]any{
			"get":        getOut,
			"get_by":     getByOut,
			"gets":       gets.Len(),
			"gets_count": groups.ToArray(),
			"page":       map[string]any{"items": page.Items.Len(), "total_count": page.TotalCount, "total_pages": page.TotalPages, "page": page.Page, "per_page": page.PerPage},
			"count":      count,
			"sum":        sum,
			"avg":        avg,
			"null_rows":  nullRows,
			"null_sum":   nullSum,
			"null_avg":   nullAvg,
		}, nil
	})
	run("audit_lazy", func() (any, error) {
		// An audited transaction inserts its audit record right before its first write of an audited
		// table: reads and an update that matches no row leave no record, and the create inserts one.
		// The transaction is rolled back at the end, so the database is the same as at the start.
		boom := errors.New("boom")
		result := map[string]any{}
		err := db.Transaction(func() error {
			before, err := model.AuditRecord().GetCount()
			if err != nil {
				return err
			}
			result["before"] = before
			read, err := model.AuditedNote().Label("audit-lazy").GetCount()
			if err != nil {
				return err
			}
			result["read"] = read
			if _, err := model.AuditedNote().SetSeq(-1).SetLabel("audit-none").Update(); err != nil {
				return err
			}
			unchanged, err := model.AuditRecord().GetCount()
			if err != nil {
				return err
			}
			result["unchanged"] = unchanged
			created, err := model.AuditedNote().SetLabel("audit-lazy").Create()
			if err != nil {
				return err
			}
			mask([]int64{created.GetSeq()})
			written, err := model.AuditRecord().GetCount()
			if err != nil {
				return err
			}
			result["written"] = written
			return boom
		}, orm.Audit(map[string]any{"request_id": "audit-lazy"}), orm.Retry(0))
		result["rolled_back"] = errors.Is(err, boom)
		after, err := model.AuditRecord().Connect(db).GetCount()
		result["after"] = after
		return result, err
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
		inserted, err := model.CompositeAccount().Connect(db).Creates(rows, 2)
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
	// creates(rows, batch) runs each batch of batch rows as one multi-row INSERT in one transaction;
	// a batch that is not a positive integer is CONFIG before any statement (docs/spec/protocol.md).
	run("creates_batch", func() (any, error) {
		var rows []*model.CompositeAccountModel
		for i, name := range []string{"a", "b", "c", "d", "e"} {
			rows = append(rows, model.CompositeAccount().SetTenantId(903).SetAccountId(int64(i+1)).SetName(name))
		}
		inserted, err := model.CompositeAccount().Connect(db).Creates(rows, 2)
		if err != nil {
			return nil, err
		}
		_, zero := model.CompositeAccount().Connect(db).Creates(rows, 0)
		count, err := model.CompositeAccount().Connect(db).TenantId([]int64{903}).GetCount()
		if err != nil {
			return nil, err
		}
		all, err := model.CompositeAccount().Connect(db).TenantId([]int64{903}).OrderByAccountIdAsc().Gets()
		if err != nil {
			return nil, err
		}
		if err := all.Delete(); err != nil {
			return nil, err
		}
		return map[string]any{"inserted": inserted, "zero": code(zero), "count": count}, nil
	})
	// A batch whose binds exceed the bind limit is BATCH_TOO_LARGE before any statement: 21846 rows
	// of three columns bind 65538 parameters, over the limit of every dialect.
	run("creates_batch_too_large", func() (any, error) {
		rows := make([]*model.CompositeAccountModel, 21846)
		for i := range rows {
			rows[i] = model.CompositeAccount().SetTenantId(904).SetAccountId(int64(i + 1)).SetName("n")
		}
		_, err := model.CompositeAccount().Connect(db).Creates(rows, len(rows))
		count, cerr := model.CompositeAccount().Connect(db).TenantId([]int64{904}).GetCount()
		if cerr != nil {
			return nil, cerr
		}
		return map[string]any{"code": code(err), "count": count}, nil
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
		// Restores a soft-deleted row to its primary key. The deleted time is written as a fixed value so that all
		// the database and the runner's bind are the same. The transaction is rolled back at the end, so the database
		// is the same as at the start.
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
			// Values outside the key are used only when restoring a deleted row. The second restore
			// returns the row without changing a row that was not deleted.
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
	run("restore_or_create", func() (any, error) {
		// RestoreOrCreate restores the soft-deleted row of its key, refuses a live row with ROW_NOT_DELETED and
		// creates a missing key (docs/operations/usage.md "Restore or create a row"). The transaction rolls back at the end.
		boom := errors.New("boom")
		result := map[string]any{}
		err := db.Transaction(func() error {
			created, err := model.SoftLink().SetCode("roc-1").SetLabel("first").Create()
			if err != nil {
				return err
			}
			mask([]int64{created.GetSeq()})
			deletedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
			if _, err := created.SetDeletedAt(textPtr(dateTimeText(deletedAt))).Update(); err != nil {
				return err
			}
			restored, err := model.SoftLink().SetCode("roc-1").SetLabel("second").RestoreOrCreate()
			if err != nil {
				return err
			}
			restoredRow := restored.ToArray()
			restoredRow["seq"] = "$SEQ"
			result["restored"] = restoredRow
			_, live := model.SoftLink().SetCode("roc-1").SetLabel("third").RestoreOrCreate()
			result["live"] = code(live)
			made, err := model.SoftLink().SetCode("roc-2").SetLabel("new").RestoreOrCreate()
			if err != nil {
				return err
			}
			mask([]int64{made.GetSeq()})
			createdRow := made.ToArray()
			createdRow["seq"] = "$SEQ"
			result["created"] = createdRow
			return boom
		}, orm.Retry(0))
		if !errors.Is(err, boom) {
			return nil, err
		}
		left, err := model.SoftLink().Connect(db).GetCount()
		result["left"] = left
		return result, err
	})
	run("expect_revision", func() (any, error) {
		// ExpectRevision makes an update or a delete write only while author 42's like_count still holds the
		// expected revision; an update stores revision + 1, and a mismatch is REVISION_CHANGED and writes nothing
		// (docs/spec/dsl.md "Writes"). The transaction rolls back at the end, so the database is as it was.
		boom := errors.New("boom")
		result := map[string]any{}
		read := func() (map[string]any, error) {
			row, err := model.Author().GetBySeq(42)
			if err != nil {
				return nil, err
			}
			return map[string]any{"name": row.GetName(), "like_count": row.GetLikeCount()}, nil
		}
		err := db.Transaction(func() error {
			before, err := read()
			if err != nil {
				return err
			}
			result["before"] = before
			revision := int64(before["like_count"].(int32))
			if _, err := model.Author().SetSeq(42).SetName("revision-1").ExpectRevision("like_count", revision).Update(); err != nil {
				return err
			}
			if result["updated"], err = read(); err != nil {
				return err
			}
			_, mismatch := model.Author().SetSeq(42).SetName("revision-stale").ExpectRevision("like_count", revision).Update()
			result["update_mismatch"] = code(mismatch)
			if result["after_mismatch"], err = read(); err != nil {
				return err
			}
			result["delete_mismatch"] = code(model.Author().SetSeq(42).ExpectRevision("like_count", revision).Delete())
			if result["kept"], err = model.Author().Seq(42).GetCount(); err != nil {
				return err
			}
			result["delete_match"] = code(model.Author().SetSeq(42).ExpectRevision("like_count", revision+1).Delete())
			if result["deleted"], err = model.Author().Seq(42).GetCount(); err != nil {
				return err
			}
			return boom
		}, orm.Retry(0))
		if !errors.Is(err, boom) {
			return nil, err
		}
		left, err := model.Author().Connect(db).Seq(42).GetCount()
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
		// Two compared columns meet as dbspec check operands do (docs/spec/dbspec.md "Checks"): a comparison of two
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
	// form the SQLite CHECK of the column requires (docs/spec/dialects.md); zeros past p
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

	// An upsert has exactly one conflict key (docs/spec/protocol.md 1): upsert_cell
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
	// text cast to uuid, in one form in every planner (docs/spec/dialects.md); the
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
	// (docs/spec/protocol.md §5 "Parameters"). A create that the client lets through is deleted,
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

	// A contains value NULL binds NULL, so `col LIKE NULL` matches no row (docs/spec/protocol.md §2).
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
	// (docs/spec/protocol.md §5 "Parameters"); creates binds each row value as a parameter.
	run("null_into_not_null", func() (any, error) {
		null := model.BindCell()
		null.Orm_().SetNull("label")
		_, err := bindCell().Creates([]*model.BindCellModel{model.BindCell().SetLabel("a"), null}, 2)
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

// declaredVector is one vector declared by the runner.
type declaredVector struct {
	name string
	fn   func() (any, error)
}

// parseArgs reads one -dsn URI and the repeatable -vector NAME.
// If selected is nil, all vectors run.
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

// selectVectors returns the selected vectors in declaration order. If selected is nil,
// all vectors are selected, and a name that is not declared is an error.
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
