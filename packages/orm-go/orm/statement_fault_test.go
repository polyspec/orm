//go:build ormtest

package orm_test

import (
	"encoding/json"
	"errors"
	"os"
	"sort"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

// statementFaultFixture는 contracts/fixtures/statement_fault.json이다. code와
// message는 실패할 statement의 오류이고 cases는 이 파일이 실행해야 하는 case 이름이다.
type statementFaultFixture struct {
	Schema  int      `json:"schema"`
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Cases   []string `json:"cases"`
}

// statementFaultCases는 fixture의 case 이름마다 test 함수 하나다. 이름이 없으면
// TestStatementFaultCases가 실패하고, fixture에 없는 이름이 있어도 실패한다.
var statementFaultCases = map[string]func(t *testing.T, db *orm.DB, model func() *orm.Core, f statementFaultFixture){
	"refused_insert":            statementRefusedInsert,
	"consumed_by_one_statement": statementConsumedByOneStatement,
	"refused_in_transaction":    statementRefusedInTransaction,
	"empty_argument_refused":    statementEmptyArgumentRefused,
}

// loadStatementFault는 contracts/fixtures/statement_fault.json을 읽는다.
func loadStatementFault(t *testing.T) statementFaultFixture {
	t.Helper()
	data, err := os.ReadFile("../../../contracts/fixtures/statement_fault.json")
	if err != nil {
		t.Fatal(err)
	}
	var f statementFaultFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if f.Schema != 1 {
		t.Fatalf("statement_fault.json schema = %d, want 1", f.Schema)
	}
	return f
}

// statementFault는 fixture의 case마다 새 database를 만들고 그 case를 실행한다.
// rollbackFixture는 rollback_probe table을 설치한다. 모든 case는 같은 table을 쓴다.
func statementFault(t *testing.T, driver string) {
	f := loadStatementFault(t)
	for _, name := range f.Cases {
		run, ok := statementFaultCases[name]
		if !ok {
			t.Fatalf("fixture case %q has no test function in statementFaultCases", name)
		}
		t.Run(name, func(t *testing.T) {
			db, model, _ := rollbackFixture(t, driver)
			run(t, db, model, f)
		})
	}
}

// requireStatementFault는 err가 fixture의 code와 message를 가진 OrmException인지 확인한다.
func requireStatementFault(t *testing.T, err error, f statementFaultFixture) {
	t.Helper()
	var coded *orm.Error
	if !errors.As(err, &coded) || coded.Code != f.Code || coded.Msg != f.Message {
		t.Fatalf("statement error = %v, want %s with message %q", err, f.Code, f.Message)
	}
}

// requireStatementEvent는 연결의 statement event 중 fixture의 오류를 가진 event가
// 있는지 확인한다. 오류는 statement가 끝날 때 event에 실려야 한다.
func requireStatementEvent(t *testing.T, db *orm.DB, f statementFaultFixture, run func()) {
	t.Helper()
	var events []orm.StatementEvent
	unsubscribe := db.Subscribe(func(e orm.StatementEvent) error {
		events = append(events, e)
		return nil
	})
	defer unsubscribe()
	run()
	for _, e := range events {
		var coded *orm.Error
		if errors.As(e.Err, &coded) && coded.Code == f.Code && coded.Msg == f.Message {
			return
		}
	}
	t.Fatalf("no statement event carries %s %q; %d events", f.Code, f.Message, len(events))
}

// requireRows는 model의 row 수가 want인지 확인한다.
func requireRows(t *testing.T, model func() *orm.Core, want int64, subject string) {
	t.Helper()
	n, err := model().GetCount()
	if err != nil || int64(n) != want {
		t.Fatalf("%s: %d rows, %v; want %d", subject, n, err, want)
	}
}

// refuseUsage는 call이 panic으로 거부되는지 확인한다.
func refuseUsage(t *testing.T, subject string, call func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Fatalf("%s was not refused", subject)
		}
	}()
	call()
}

// statementRefusedInsert는 다음 insert가 보내지지 않고 fixture의 오류로 실패하며
// 데이터베이스가 바뀌지 않는지 확인한다.
func statementRefusedInsert(t *testing.T, db *orm.DB, model func() *orm.Core, f statementFaultFixture) {
	orm.FailNextStatement(db, f.Code, f.Message)
	requireStatementEvent(t, db, f, func() {
		requireStatementFault(t, probeCreate(model, "refused"), f)
	})
	requireRows(t, model, 0, "after the refused insert")
}

// statementConsumedByOneStatement는 fault가 한 statement만 소비해서 다음 insert가
// 성공하는지 확인한다.
func statementConsumedByOneStatement(t *testing.T, db *orm.DB, model func() *orm.Core, f statementFaultFixture) {
	orm.FailNextStatement(db, f.Code, f.Message)
	requireStatementFault(t, probeCreate(model, "refused"), f)
	if err := probeCreate(model, "after the fault"); err != nil {
		t.Fatalf("the insert after the consumed fault: %v", err)
	}
	requireRows(t, model, 1, "after the consumed fault")
}

// statementRefusedInTransaction은 BEGIN과 COMMIT이 fault를 소비하지 않고, transaction
// 안의 다음 insert가 fixture의 오류로 실패해 transaction이 그 오류를 반환하는지 확인한다.
func statementRefusedInTransaction(t *testing.T, db *orm.DB, model func() *orm.Core, f statementFaultFixture) {
	orm.FailNextStatement(db, f.Code, f.Message)
	if err := db.Transaction(func() error { return nil }, orm.Retry(0)); err != nil {
		t.Fatalf("an empty transaction with an armed fault: %v", err)
	}
	err := db.Transaction(func() error {
		return probeCreate(model, "refused in transaction")
	}, orm.Retry(0))
	requireStatementFault(t, err, f)
	requireRows(t, model, 0, "after the refused insert in a transaction")
}

// statementEmptyArgumentRefused는 빈 code나 빈 message가 거부되고 아무것도 armed하지
// 않아서 다음 insert가 성공하는지 확인한다.
func statementEmptyArgumentRefused(t *testing.T, db *orm.DB, model func() *orm.Core, f statementFaultFixture) {
	refuseUsage(t, "an empty code", func() { orm.FailNextStatement(db, "", f.Message) })
	refuseUsage(t, "an empty message", func() { orm.FailNextStatement(db, f.Code, "") })
	if err := probeCreate(model, "after the refusal"); err != nil {
		t.Fatalf("the insert after the refused arming: %v", err)
	}
	requireRows(t, model, 1, "after the refused arming")
}

// TestStatementFaultCases는 fixture의 case 이름과 statementFaultCases의 이름이
// 같은지 확인한다. 두 목록이 다르면 fixture의 case가 실행되지 않거나 실행되지 않는
// test가 남는다.
func TestStatementFaultCases(t *testing.T) {
	f := loadStatementFault(t)
	named := make([]string, 0, len(statementFaultCases))
	for name := range statementFaultCases {
		named = append(named, name)
	}
	sort.Strings(named)
	fixture := append([]string(nil), f.Cases...)
	sort.Strings(fixture)
	if len(named) != len(fixture) {
		t.Fatalf("test cases %v, fixture cases %v", named, fixture)
	}
	for i := range named {
		if named[i] != fixture[i] {
			t.Fatalf("test cases %v, fixture cases %v", named, fixture)
		}
	}
}

func TestStatementFaultSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	statementFault(t, "sqlite")
}
func TestStatementFaultMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	statementFault(t, "mysql")
}
func TestStatementFaultPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	statementFault(t, "postgres")
}
