package orm_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

var refusalColumns = []string{"seq", "amount"}

// refusalModels: an immutable trigger refuses every update, and a CHECK constraint
// refuses a non-positive amount. It installs refused_row in a new database and returns the connected
// model constructor.
func refusalModels(t *testing.T, driver string) func() *orm.Core {
	t.Helper()
	s := fixtureSchema(t, "refusal")
	db := openSchemaDB(t, newDatabase(t, driver), s)
	ent := rowEntity("refused_row", s, refusalColumns...)
	return coreFunc(db, ent)
}

// triggerRefused updates an immutable row. The trigger, which is not in the catalog,
// refuses the write with a database error, and the client reports it as DRIVER with the driver
// message and the driver error as its cause.
func triggerRefused(t *testing.T, driver string) {
	model := refusalModels(t, driver)
	c := model()
	c.Set("amount", 1)
	created, err := c.Create()
	if err != nil {
		t.Fatal(err)
	}
	seq := as[*keywordRow](t, created).vals["seq"]
	u := model()
	u.Set("seq", seq)
	u.Set("amount", 2)
	err = u.Update(nil)
	if got := orm.ErrorCode(err); got != orm.CodeDriver {
		t.Fatalf("refused update = %v (code %q), want DRIVER", err, got)
	}
	if !strings.Contains(err.Error(), "table refused_row is immutable") {
		t.Fatalf("refused update message: %v", err)
	}
	var coded *orm.Error
	if !errors.As(err, &coded) || errors.Unwrap(coded) == nil {
		t.Fatalf("refused update does not keep the driver error: %#v", err)
	}
	row := getBySeq(t, model, seq)
	if amount := as[*keywordRow](t, row).vals["amount"]; amount != int32(1) && amount != int64(1) {
		t.Fatalf("refused update changed the row: amount %#v", amount)
	}
}

// checkRefused inserts a row that the CHECK constraint refuses, and the client reports it
// as a CONSTRAINT.
func checkRefused(t *testing.T, driver string) {
	model := refusalModels(t, driver)
	c := model()
	c.Set("amount", 0)
	_, err := c.Create()
	if got := orm.ErrorCode(err); got != orm.CodeConstraint {
		t.Fatalf("refused insert = %v (code %q), want CONSTRAINT", err, got)
	}
	if !strings.Contains(err.Error(), "amount_positive") {
		t.Fatalf("refused insert message: %v", err)
	}
	var coded *orm.Error
	if !errors.As(err, &coded) || errors.Unwrap(coded) == nil {
		t.Fatalf("refused insert does not keep the driver error: %#v", err)
	}
	n, err := model().GetCount()
	if err != nil || n != 0 {
		t.Fatalf("refused insert wrote %d rows: %v", n, err)
	}
}

func TestTriggerRefusedSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	triggerRefused(t, "sqlite")
}
func TestTriggerRefusedMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	triggerRefused(t, "mysql")
}
func TestTriggerRefusedPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	triggerRefused(t, "postgres")
}
func TestCheckRefusedSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	checkRefused(t, "sqlite")
}
func TestCheckRefusedMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	checkRefused(t, "mysql")
}
func TestCheckRefusedPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	checkRefused(t, "postgres")
}
