package orm_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

var refusalColumns = []string{"seq", "amount"}

// refusalModels는 immutable trigger가 모든 update를 거절하고 CHECK constraint가
// 양수가 아닌 amount를 거절하는 refused_row를 새 database에 설치하고, 연결된
// model 생성 함수를 돌려준다.
func refusalModels(t *testing.T, driver string) func() *orm.Core {
	t.Helper()
	s := fixtureSchema(t, "refusal")
	db, err := orm.ConnectSchema(newDatabase(t, driver), s, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Utils().Schema().Install(s); err != nil {
		t.Fatal(err)
	}
	ent := rowEntity("refused_row", s, refusalColumns...)
	return func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
}

// triggerRefused는 immutable row를 update한다. trigger가 catalog에 없는
// database 오류로 write를 거절하고, client는 그것을 driver message와 driver
// 오류를 cause로 가진 DRIVER로 보고한다.
func triggerRefused(t *testing.T, driver string) {
	model := refusalModels(t, driver)
	c := model()
	c.Set("amount", 1)
	created, err := c.Create()
	if err != nil {
		t.Fatal(err)
	}
	seq := created.(*keywordRow).vals["seq"]
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
	q := model()
	q.AddAllColumns()
	q.Where("", []orm.ChainKey{{Column: "seq"}}, seq)
	row, err := q.Get()
	if err != nil {
		t.Fatal(err)
	}
	if amount := row.(*keywordRow).vals["amount"]; amount != int32(1) && amount != int64(1) {
		t.Fatalf("refused update changed the row: amount %#v", amount)
	}
}

// checkRefused는 CHECK constraint가 거절하는 row를 insert하고, client는 그것을
// CONSTRAINT로 보고한다.
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
