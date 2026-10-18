//go:build ormtest

package orm_test

import (
	"encoding/json"
	"errors"
	"os"
	"sort"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// statementFaultFixture is contracts/fixtures/statement_fault.json. code and
// message are the error of the statement that fails, and cases are the case names this file must run.
type statementFaultFixture struct {
	Schema  int      `json:"schema"`
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Cases   []string `json:"cases"`
}

// statementFaultCases has one test function per case name of the fixture. If a name is missing,
// TestStatementFaultCases fails, and it also fails if there is a name that is not in the fixture.
var statementFaultCases = map[string]func(t *testing.T, db *orm.DB, model func() *orm.Core, f statementFaultFixture){
	"refused_insert":            statementRefusedInsert,
	"consumed_by_one_statement": statementConsumedByOneStatement,
	"refused_in_transaction":    statementRefusedInTransaction,
	"empty_argument_refused":    statementEmptyArgumentRefused,
}

// loadStatementFault reads contracts/fixtures/statement_fault.json.
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

// statementFault makes a new database for each case of the fixture and runs that case.
// rollbackFixture installs the rollback_probe table. All cases use the same table.
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

// requireStatementFault checks that err is an OrmException with the fixture's code and message.
func requireStatementFault(t *testing.T, err error, f statementFaultFixture) {
	t.Helper()
	var coded *orm.Error
	if !errors.As(err, &coded) || coded.Code != f.Code || coded.Msg != f.Message {
		t.Fatalf("statement error = %v, want %s with message %q", err, f.Code, f.Message)
	}
}

// requireStatementEvent checks that among the connection's statement events there is one
// carrying the fixture's error. The error must be attached to the event when the statement ends.
func requireStatementEvent(t *testing.T, db *orm.DB, f statementFaultFixture, run func()) {
	t.Helper()
	var events []orm.StatementEvent
	unsubscribe, err := db.Subscribe(func(e orm.StatementEvent) error {
		events = append(events, e)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
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

// requireRows checks that the model's row count is want.
func requireRows(t *testing.T, model func() *orm.Core, want int64, subject string) {
	t.Helper()
	n, err := model().GetCount()
	if err != nil || int64(n) != want {
		t.Fatalf("%s: %d rows, %v; want %d", subject, n, err, want)
	}
}

// refuseUsage checks that the call is refused with a panic.
func refuseUsage(t *testing.T, subject string, call func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Fatalf("%s was not refused", subject)
		}
	}()
	call()
}

// statementRefusedInsert makes the next insert fail with the fixture's error without sending it,
// and checks that the database is not changed.
func statementRefusedInsert(t *testing.T, db *orm.DB, model func() *orm.Core, f statementFaultFixture) {
	orm.FailNextStatement(db, f.Code, f.Message)
	requireStatementEvent(t, db, f, func() {
		requireStatementFault(t, probeCreate(model, "refused"), f)
	})
	requireRows(t, model, 0, "after the refused insert")
}

// statementConsumedByOneStatement checks that the fault consumes only one statement, so the next insert
// succeeds.
func statementConsumedByOneStatement(t *testing.T, db *orm.DB, model func() *orm.Core, f statementFaultFixture) {
	orm.FailNextStatement(db, f.Code, f.Message)
	requireStatementFault(t, probeCreate(model, "refused"), f)
	if err := probeCreate(model, "after the fault"); err != nil {
		t.Fatalf("the insert after the consumed fault: %v", err)
	}
	requireRows(t, model, 1, "after the consumed fault")
}

// statementRefusedInTransaction checks that BEGIN and COMMIT do not consume the fault, and that the next insert
// inside the transaction fails with the fixture's error, so the transaction returns that error.
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

// statementEmptyArgumentRefused checks that an empty code or empty message is refused and arms nothing,
// so that the next insert succeeds.
func statementEmptyArgumentRefused(t *testing.T, db *orm.DB, model func() *orm.Core, f statementFaultFixture) {
	refuseUsage(t, "an empty code", func() { orm.FailNextStatement(db, "", f.Message) })
	refuseUsage(t, "an empty message", func() { orm.FailNextStatement(db, f.Code, "") })
	if err := probeCreate(model, "after the refusal"); err != nil {
		t.Fatalf("the insert after the refused arming: %v", err)
	}
	requireRows(t, model, 1, "after the refused arming")
}

// TestStatementFaultCases checks that the case names of the fixture are the same as the names in statementFaultCases.
// If the two lists differ, a fixture case does not run, or a test that runs
// no fixture case remains.
func TestStatementFaultCases(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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
