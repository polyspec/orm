package orm_test

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/go"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

// AddColumns on SQLite, MySQL and PostgreSQL. A database holds the audit log
// tables of one manifest and the tables of a module manifest at version 1,
// with rows. AddColumns with version 2 adds the missing nullable and
// defaulted columns to the existing module tables, keeps the rows, replaces
// the audit triggers of the changed table so that they record the new
// columns, creates no missing table and leaves the tables of the log manifest
// unchanged; a repeated call adds nothing. A manifest that differs from the
// tables in any other way fails with SCHEMA_DIFFERS before any change. The
// fixtures are contracts/fixtures/add_columns_*.json.

var (
	addColumnsAdded   = []string{"addcol_item.note", "addcol_item.rank", "addcol_item.archived", "addcol_item.status", "addcol_tag.color"}
	addColumnsDiffers = []string{"required", "removed", "changed", "nullable", "default", "index", "unique"}
	addColumnsTables  = []string{"addcol_extra", "addcol_tag", "addcol_item", "addcol_change", "addcol_operation"}
)

func addColumnsFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("../../../contracts/fixtures/add_columns_" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// addColumnsEntity is a model of one entity of a fixture manifest whose
// values are kept by column name.
func addColumnsEntity(t *testing.T, manifest []byte, name string) *orm.Entity {
	t.Helper()
	m, err := schema.Load(manifest)
	if err != nil {
		t.Fatal(err)
	}
	e := m.Entities[name]
	if e == nil {
		t.Fatalf("entity %s is missing", name)
	}
	columns := map[string]bool{}
	for _, c := range e.Columns {
		columns[c.Name] = true
	}
	return &orm.Entity{
		Name:   name,
		Schema: &orm.Schema{Hash: m.SchemaHash},
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, column string, v any) (bool, error) {
			if !columns[column] {
				return false, nil
			}
			m.(*keywordRow).vals[column] = v
			return true, nil
		},
		Value: func(m orm.Model, column string) (any, bool) {
			v, ok := m.(*keywordRow).vals[column]
			return v, ok
		},
		Collect: func(keys []orm.Key, items map[orm.Key]*orm.Core, fetched map[orm.Key]any) any {
			return orm.CollectOf[*keywordRow](keys, items, fetched)
		},
	}
}

func addColumnsModel(db *orm.DB, ent *orm.Entity, values map[string]any) *orm.Core {
	c := orm.NewCore(ent)
	ent.New(c)
	c.Connect(db)
	for column, value := range values {
		c.Set(column, value)
	}
	return c
}

// addColumnsRows reads every row of an entity in key order as column values.
func addColumnsRows(t *testing.T, db *orm.DB, ent *orm.Entity) []map[string]any {
	t.Helper()
	c := addColumnsModel(db, ent, nil)
	c.AddAllColumns()
	c.OrderBy("seq", false, nil)
	got, err := orm.Gets[*keywordRow](c)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, row := range got.Slice() {
		out = append(out, row.vals)
	}
	return out
}

func addColumnsDrop(t *testing.T, driver, dsn string) {
	t.Helper()
	if driver == "sqlite" {
		return
	}
	for _, table := range addColumnsTables {
		dropTable(t, driver, dsn, table)
	}
	if driver == "postgres" {
		raw := openNative(t, driver, dsn)
		defer raw.Close()
		if _, err := raw.Exec(`DROP FUNCTION IF EXISTS addcol_item_audit()`); err != nil {
			t.Fatal(err)
		}
	}
}

// addColumnsInstalled opens a connection with the log manifest and installs
// the log and version 1 with one item and one tag.
func addColumnsInstalled(t *testing.T, driver string) *orm.DB {
	t.Helper()
	dsn := "sqlite://" + filepath.Join(t.TempDir(), "add-columns.sqlite")
	if driver != "sqlite" {
		dsn = requireDSN(t, "ORM_TEST_"+strings.ToUpper(driver)+"_DSN")
	}
	addColumnsDrop(t, driver, dsn)
	t.Cleanup(func() { addColumnsDrop(t, driver, dsn) })
	logJSON := addColumnsFixture(t, "log")
	m, err := schema.Load(logJSON)
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.New(m, driver)
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open(dsn, eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	v1 := addColumnsFixture(t, "v1")
	for _, manifest := range [][]byte{logJSON, v1} {
		if err := db.Utils().Schema().Install(manifest); err != nil {
			t.Fatal(err)
		}
	}
	operation := addColumnsEntity(t, logJSON, "addcol_operation")
	err = db.Transaction(func() error {
		if _, err := addColumnsModel(db, operation, map[string]any{"operation_uuid": "op-1"}).Create(); err != nil {
			return err
		}
		if err := db.Utils().SetLocal("addcol.operation", "op-1"); err != nil {
			return err
		}
		item, err := addColumnsModel(db, addColumnsEntity(t, v1, "addcol_item"), map[string]any{"uuid": "item-1", "label": "first", "enabled": true, "price": "2.50"}).Create()
		if err != nil {
			return err
		}
		_, err = addColumnsModel(db, addColumnsEntity(t, v1, "addcol_tag"), map[string]any{"addcol_item_seq": item.(*keywordRow).vals["seq"], "name": "red"}).Create()
		return err
	}, orm.Retry(0))
	if err != nil {
		t.Fatal(err)
	}
	return db
}

// addColumnsChanges returns the kind and after value of each audit change in order.
func addColumnsChanges(t *testing.T, db *orm.DB) []string {
	t.Helper()
	var out []string
	for _, row := range addColumnsRows(t, db, addColumnsEntity(t, addColumnsFixture(t, "log"), "addcol_change")) {
		styled, ok := row["after_value"].(orm.StyledValue)
		if !ok || styled.Kind() != "value" {
			t.Fatalf("after_value is %T (%v)", row["after_value"], row["after_value"])
		}
		data, _ := styled.Data()
		value, ok := data.(*orderedjson.Value)
		if !ok {
			t.Fatalf("after_value holds %T", data)
		}
		after, err := orderedjson.Stringify(value)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%v %s", row["change_kind"], after))
	}
	return out
}

func addColumnsCase(t *testing.T, driver string) {
	db := addColumnsInstalled(t, driver)
	v2 := addColumnsFixture(t, "v2")
	before := addColumnsChanges(t, db)
	if len(before) != 1 {
		t.Fatalf("changes before = %v", before)
	}
	added, err := db.Utils().Schema().AddColumns(v2)
	if err != nil || !slices.Equal(added, addColumnsAdded) {
		t.Fatalf("AddColumns = %v, %v", added, err)
	}
	if err := db.Utils().Schema().Register(v2); err != nil {
		t.Fatal(err)
	}
	items := addColumnsRows(t, db, addColumnsEntity(t, v2, "addcol_item"))
	if len(items) != 1 {
		t.Fatalf("items = %v", items)
	}
	item := items[0]
	// The rows of this model hold the stored values, so the typed values are
	// compared through conditions that the client encodes by column type.
	itemEntity := addColumnsEntity(t, v2, "addcol_item")
	count := func(columns []string, values ...any) int64 {
		c := addColumnsModel(db, itemEntity, nil)
		keys := make([]orm.ChainKey, len(columns))
		for i, column := range columns {
			keys[i] = orm.ChainKey{Column: column}
			if i > 0 {
				keys[i].Conn = "and"
			}
		}
		c.Where("", keys, values...)
		n, err := c.GetCount()
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count([]string{"label", "enabled", "price"}, "first", true, "2.50"); n != 1 {
		t.Fatalf("item values kept: %d rows, %v", n, item)
	}
	if n := count([]string{"rank", "archived", "status"}, 3, false, "new"); n != 1 || item["note"] != nil {
		t.Fatalf("item defaults: %d rows, %v", n, item)
	}
	tags := addColumnsRows(t, db, addColumnsEntity(t, v2, "addcol_tag"))
	if len(tags) != 1 || tags[0]["name"] != "red" || tags[0]["color"] != nil {
		t.Fatalf("tags = %v", tags)
	}
	if got := addColumnsChanges(t, db); !slices.Equal(got, before) {
		t.Fatalf("log rows = %v, want %v", got, before)
	}
	err = db.Transaction(func() error {
		if _, err := addColumnsModel(db, addColumnsEntity(t, addColumnsFixture(t, "log"), "addcol_operation"), map[string]any{"operation_uuid": "op-2"}).Create(); err != nil {
			return err
		}
		if err := db.Utils().SetLocal("addcol.operation", "op-2"); err != nil {
			return err
		}
		c := addColumnsModel(db, addColumnsEntity(t, v2, "addcol_item"), map[string]any{"seq": item["seq"]})
		c.Set("note", "later")
		c.Set("rank", 4)
		return c.Update(nil)
	}, orm.Retry(0))
	if err != nil {
		t.Fatal(err)
	}
	after := addColumnsChanges(t, db)
	if len(after) != 2 || after[1] != `UPDATE {"note":"later","rank":4}` {
		t.Fatalf("changes after the update = %v", after)
	}
	extra := addColumnsEntity(t, v2, "addcol_extra")
	if _, err := addColumnsModel(db, extra, nil).GetCount(); orm.ErrorCode(err) != orm.CodeDriver {
		t.Fatalf("the missing table was created: %v", err)
	}
	if again, err := db.Utils().Schema().AddColumns(v2); err != nil || len(again) != 0 {
		t.Fatalf("repeated AddColumns = %v, %v", again, err)
	}
	if err := db.Utils().Schema().Install(v2); err != nil {
		t.Fatal(err)
	}
	if n, err := addColumnsModel(db, extra, nil).GetCount(); err != nil || n != 0 {
		t.Fatalf("install of the missing table = %d, %v", n, err)
	}
	if again, err := db.Utils().Schema().AddColumns(v2); err != nil || len(again) != 0 {
		t.Fatalf("AddColumns after install = %v, %v", again, err)
	}
}

func addColumnsDiffersCase(t *testing.T, driver string) {
	db := addColumnsInstalled(t, driver)
	for _, name := range addColumnsDiffers {
		if _, err := db.Utils().Schema().AddColumns(addColumnsFixture(t, name)); orm.ErrorCode(err) != orm.CodeSchemaDiffers {
			t.Errorf("%s = %v, want SCHEMA_DIFFERS", name, err)
		}
	}
	if added, err := db.Utils().Schema().AddColumns(addColumnsFixture(t, "v2")); err != nil || !slices.Equal(added, addColumnsAdded) {
		t.Fatalf("AddColumns after the differences = %v, %v", added, err)
	}
}

func addColumnsTransactionCase(t *testing.T, driver string) {
	db := addColumnsInstalled(t, driver)
	v2 := addColumnsFixture(t, "v2")
	if driver == "mysql" {
		var inside error
		if err := db.Transaction(func() error {
			_, inside = db.Utils().Schema().AddColumns(v2)
			return nil
		}, orm.Retry(0)); err != nil {
			t.Fatal(err)
		}
		if orm.ErrorCode(inside) != orm.CodeConfig {
			t.Fatalf("AddColumns in a MySQL transaction = %v, want CONFIG", inside)
		}
	} else {
		rollback := errors.New("roll back")
		err := db.Transaction(func() error {
			if added, err := db.Utils().Schema().AddColumns(v2); err != nil || !slices.Equal(added, addColumnsAdded) {
				return fmt.Errorf("AddColumns in the transaction = %v, %v", added, err)
			}
			return rollback
		}, orm.Retry(0))
		if !errors.Is(err, rollback) {
			t.Fatalf("transaction = %v", err)
		}
	}
	if added, err := db.Utils().Schema().AddColumns(v2); err != nil || !slices.Equal(added, addColumnsAdded) {
		t.Fatalf("AddColumns after the transaction = %v, %v", added, err)
	}
}

func addColumnsEditedManifestCase(t *testing.T, driver string) {
	db := addColumnsInstalled(t, driver)
	v2 := addColumnsFixture(t, "v2")
	edited := []byte(strings.ReplaceAll(string(v2), `"note"`, `"memo"`))
	if _, err := db.Utils().Schema().AddColumns(edited); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("AddColumns of an edited manifest = %v, want CONFIG", err)
	}
	if added, err := db.Utils().Schema().AddColumns(v2); err != nil || !slices.Equal(added, addColumnsAdded) {
		t.Fatalf("AddColumns after the edited manifest = %v, %v", added, err)
	}
}

func TestAddColumnsSQLite(t *testing.T)                 { addColumnsCase(t, "sqlite") }
func TestAddColumnsMySQL(t *testing.T)                  { addColumnsCase(t, "mysql") }
func TestAddColumnsPostgres(t *testing.T)               { addColumnsCase(t, "postgres") }
func TestAddColumnsDiffersSQLite(t *testing.T)          { addColumnsDiffersCase(t, "sqlite") }
func TestAddColumnsDiffersMySQL(t *testing.T)           { addColumnsDiffersCase(t, "mysql") }
func TestAddColumnsDiffersPostgres(t *testing.T)        { addColumnsDiffersCase(t, "postgres") }
func TestAddColumnsTransactionSQLite(t *testing.T)      { addColumnsTransactionCase(t, "sqlite") }
func TestAddColumnsTransactionMySQL(t *testing.T)       { addColumnsTransactionCase(t, "mysql") }
func TestAddColumnsTransactionPostgres(t *testing.T)    { addColumnsTransactionCase(t, "postgres") }
func TestAddColumnsEditedManifestSQLite(t *testing.T)   { addColumnsEditedManifestCase(t, "sqlite") }
func TestAddColumnsEditedManifestMySQL(t *testing.T)    { addColumnsEditedManifestCase(t, "mysql") }
func TestAddColumnsEditedManifestPostgres(t *testing.T) { addColumnsEditedManifestCase(t, "postgres") }
