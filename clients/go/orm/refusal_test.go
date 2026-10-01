package orm_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

var refusalColumns = []string{"seq", "amount"}

func refusalEntity(hash string) *orm.Entity {
	return &orm.Entity{
		Name:   "refused_row",
		Schema: &orm.Schema{Hash: hash},
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) (bool, error) {
			for _, c := range refusalColumns {
				if c == name {
					m.(*keywordRow).vals[name] = v
					return true, nil
				}
			}
			return false, nil
		},
		Value: func(m orm.Model, name string) (any, bool) {
			v, ok := m.(*keywordRow).vals[name]
			return v, ok
		},
		Collect: func(keys []orm.Key, items map[orm.Key]*orm.Core, fetched map[orm.Key]any) any {
			return orm.CollectOf[*keywordRow](keys, items, fetched)
		},
	}
}

// refusalModels installs refused_row, whose immutable triggers refuse every
// update and whose CHECK constraint refuses a nonpositive amount, and returns
// a constructor of connected models.
func refusalModels(t *testing.T, driver string) func() *orm.Core {
	t.Helper()
	manifest, err := os.ReadFile("../../../contracts/fixtures/refusal_schema.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Load(manifest)
	if err != nil {
		t.Fatal(err)
	}
	dsn := "sqlite://" + filepath.Join(t.TempDir(), "refusal.sqlite")
	if driver != "sqlite" {
		dsn = requireDSN(t, "ORM_TEST_"+strings.ToUpper(driver)+"_DSN")
	}
	drop := func() {
		dropTable(t, driver, dsn, "refused_row")
		if driver == "postgres" {
			raw := openNative(t, driver, dsn)
			defer raw.Close()
			if _, err := raw.Exec("DROP FUNCTION IF EXISTS refused_row_immutable_reject()"); err != nil {
				t.Fatal(err)
			}
		}
	}
	drop()
	t.Cleanup(drop)
	eng, err := engine.New(m, driver)
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open(dsn, eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Utils().Schema().Install(manifest); err != nil {
		t.Fatal(err)
	}
	ent := refusalEntity(m.SchemaHash)
	return func() *orm.Core {
		c := orm.NewCore(ent)
		ent.New(c)
		c.Connect(db)
		return c
	}
}

// triggerRefused updates an immutable row: the trigger refuses the write with
// a database error that the catalog does not list, which the client reports
// as DRIVER with the driver message and the driver error as its cause.
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
	if !strings.Contains(err.Error(), "immutable table: refused_row") {
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

// checkRefused inserts a row that the CHECK constraint refuses, which the
// client reports as CONSTRAINT.
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

func TestTriggerRefusedSQLite(t *testing.T)   { triggerRefused(t, "sqlite") }
func TestTriggerRefusedMySQL(t *testing.T)    { triggerRefused(t, "mysql") }
func TestTriggerRefusedPostgres(t *testing.T) { triggerRefused(t, "postgres") }
func TestCheckRefusedSQLite(t *testing.T)     { checkRefused(t, "sqlite") }
func TestCheckRefusedMySQL(t *testing.T)      { checkRefused(t, "mysql") }
func TestCheckRefusedPostgres(t *testing.T)   { checkRefused(t, "postgres") }
