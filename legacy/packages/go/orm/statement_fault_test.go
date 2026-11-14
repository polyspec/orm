//go:build ormtest

package orm_test

import (
	"encoding/json"
	"os"
	"sort"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
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
	"empty_argument_refused": statementEmptyArgumentRefused,
}

// loadStatementFault reads contracts/fixtures/statement_fault.json.
func loadStatementFault(t *testing.T) statementFaultFixture {
	t.Helper()
	data, err := os.ReadFile(testcase.LegacyPath("contracts/fixtures/statement_fault.json"))
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

var rollbackColumns = []string{"seq", "label"}

// rollbackFixture installs rollback_probe in a new database and returns the connected model constructor.
func rollbackFixture(t *testing.T, driver string) (*orm.DB, func() *orm.Core) {
	t.Helper()
	s := fixtureSchema(t, "rollback")
	db := openSchemaDB(t, newDatabase(t, driver), s)
	ent := rowEntity("rollback_probe", s, rollbackColumns...)
	return db, coreFunc(db, ent)
}

func probeCreate(model func() *orm.Core, label string) error {
	c := model()
	c.Set("label", label)
	_, err := c.Create()
	return err
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
			db, model := rollbackFixture(t, driver)
			run(t, db, model, f)
		})
	}
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
	testcase.Start(t)
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
	testcase.Start(t)
	statementFault(t, "sqlite")
}
func TestStatementFaultMySQL(t *testing.T) {
	testcase.Start(t)
	statementFault(t, "mysql")
}
func TestStatementFaultPostgres(t *testing.T) {
	testcase.Start(t)
	statementFault(t, "postgres")
}
