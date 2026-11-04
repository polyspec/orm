// Conformance runner (Go). Runs the bodies that no recipe step reaches, the generated-method and the fixed-clock
// bodies (tests/conformance/README.md), against a database and prints
// {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}; the other runners print the same document for the same chains.
//
// Usage: runner_go -dsn URI [-vector NAME]...
//
// -vector can be repeated; when given, only the vectors with matching names are run and printed.
// A name that is not declared ends with an error before any vector runs.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/polyspec/orm/packages/go/internal/stmtevent"
	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
)

// stmt is one statement event (docs/operations/usage.md "Statement events"). transaction is
// the number counted from 1 again in order of first appearance within the vector, and null outside one. error is
// the error code of the statement, or null.
type stmt = stmtevent.Record

type vector struct {
	Statements []stmt `json:"statements"`
	Result     any    `json:"result"`
}

var (
	log []stmt
	// transactions renumbers the transaction numbers in the vector in order of first appearance.
	transactions map[int64]int64
	maskSeqs     map[int64]bool
)

const timeLayout = "2006-01-02 15:04:05.000000"

// clockVectors declares the vectors that fix the executor clock through the test
// entry point; clock_ormtest.go sets it in a build with the tag ormtest.
var clockVectors func(run func(string, func() (any, error)), db *orm.DB)

// affectedVectors declares the vectors that read the write result through the test
// entry point; affected_ormtest.go sets it in a build with the tag ormtest.
var affectedVectors func(run func(string, func() (any, error)), db *orm.DB)

// mask hides the identity of rows a vector created: their keys wherever they are
// bound, including statements logged earlier.
func mask(seqs []int64) {
	for _, s := range seqs {
		maskSeqs[s] = true
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

func picks[T orm.Model](c *orm.Collection[T], names ...string) []any {
	out := []any{}
	for _, m := range c.Slice() {
		out = append(out, pick(m, names...))
	}
	return out
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
	check(db.Transaction(func() error { return nil }, orm.Retry(0)))
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
		"now_defaults": true, "delete_recursive": true, "affected_counts": true,
		"clock_truncate_write": true, "clock_compare_six_digits": true,
	}
	// vectors are collected in declaration order, then the selection is checked and they run in that order.
	var declared []declaredVector
	run := func(name string, fn func() (any, error)) {
		declared = append(declared, declaredVector{name: name, fn: fn})
	}
	execute := func(name string, fn func() (any, error)) {
		log, maskSeqs, transactions = nil, map[int64]bool{}, map[int64]int64{}
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
	run("relation_empty", func() (any, error) {
		rows, err := author().Relations(model.ServiceMember().MatchUserSeqWithUserSeq()).GetsBySeq(-1)
		if err != nil {
			return nil, err
		}
		return rows.Len(), nil
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
		seq, err := created.GetSeq()
		if err != nil {
			return nil, err
		}
		mask([]int64{seq})
		loaded, err := author().GetBySeq(seq)
		if err != nil {
			return nil, err
		}
		createdTs, err := loaded.GetCreatedTs()
		if err != nil {
			return nil, err
		}
		updatedTs, err := loaded.GetUpdatedTs()
		if err != nil {
			return nil, err
		}
		near := createdTs.Sub(before).Abs() < time.Minute
		if err := loaded.Delete(); err != nil {
			return nil, err
		}
		return map[string]any{"created_near_clock": near, "created_equals_updated": createdTs.Equal(updatedTs)}, nil
	})
	run("delete_recursive", func() (any, error) {
		service, err := model.Service().Connect(db).SetName("recursive").Create()
		if err != nil {
			return nil, err
		}
		seq, err := service.GetSeq()
		if err != nil {
			return nil, err
		}
		seqs := []int64{seq}
		for i := 0; i < 2; i++ {
			member, err := model.ServiceMember().Connect(db).SetServiceSeq(seq).SetUserSeq(int64(i + 1)).Create()
			if err != nil {
				return nil, err
			}
			memberSeq, err := member.GetSeq()
			if err != nil {
				return nil, err
			}
			seqs = append(seqs, memberSeq)
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
	// the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
	run("hex_malformed", func() (any, error) {
		_, whiteSpace := model.HexCell().Connect(db).GetBySeq(1)
		_, oddLength := model.HexCell().Connect(db).GetBySeq(2)
		return map[string]any{"white_space": code(whiteSpace), "odd_length": code(oddLength)}, nil
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
