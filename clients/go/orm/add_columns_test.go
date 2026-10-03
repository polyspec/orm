package orm_test

import (
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// AddColumns를 SQLite, MySQL, PostgreSQL에서 확인한다. case database는 다른 set
// addcol_log의 table과 addcol set version 1의 table을 row와 함께 가진다. version 2로
// AddColumns를 부르면 있는 table에 빠진 null이거나 default가 있는 column을 더하고,
// row를 지키며, 바뀐 audit table의 trigger가 새 column을 기록하고, 없는 table을
// 만들지 않으며, 다른 set의 table은 그대로 둔다. 다시 부르면 아무것도 더하지 않는다.
// 다른 차이가 있는 set은 아무것도 바꾸기 전에 SCHEMA_DIFFERS다. fixture는
// contracts/fixtures/add_columns/*.dbs다.

var (
	addColumnsAdded = []string{
		"addcol_item.note", "addcol_item.priority", "addcol_item.archived", "addcol_item.status",
		"addcol_item_history.note", "addcol_item_history.priority", "addcol_item_history.archived", "addcol_item_history.status",
		"addcol_tag.color",
	}
	addColumnsDiffers = []string{"required", "removed", "changed", "nullable", "default", "index", "unique", "reorder"}
)

func addColumnsSchema(t *testing.T, name string) *orm.Schema {
	t.Helper()
	return fixtureSchema(t, "add_columns/"+name)
}

// addColumnsInstalled는 case database에 addcol_log와 version 1을 설치하고, log row
// 하나, operation 1로 item 하나, 그 item의 tag와 그 tag의 자식 tag를 쓴 연결을
// 돌려준다. 연결의 pool은 연결 하나라 AddColumns가 쓴 연결을 다음 요청이 다시 쓴다.
func addColumnsInstalled(t *testing.T, driver string) (*orm.DB, string) {
	t.Helper()
	dsn := newDatabase(t, driver)
	v1 := addColumnsSchema(t, "v1")
	logSet := addColumnsSchema(t, "log")
	db, err := orm.ConnectSchema(dsn, v1, orm.Config{PoolSize: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, s := range []*orm.Schema{logSet, v1} {
		if err := db.Utils().Schema().Install(s); err != nil {
			t.Fatal(err)
		}
	}
	create := func(entity *orm.Entity, values map[string]any) int64 {
		t.Helper()
		c := orm.NewCore(entity)
		c.Connect(db)
		for column, value := range values {
			c.Set(column, value)
		}
		row, err := c.Create()
		if err != nil {
			t.Fatal(err)
		}
		return row.(*keywordRow).vals["id"].(int64)
	}
	create(rowEntity("addcol_log_entry", logSet, "id", "message"), map[string]any{"message": "kept"})
	err = db.Transaction(func() error {
		item := create(rowEntity("addcol_item", v1, "id", "ref", "label", "operation_id"), map[string]any{"ref": "item-1", "label": "first"})
		tags := rowEntity("addcol_tag", v1, "id", "item_id", "parent_id", "name")
		parent := create(tags, map[string]any{"item_id": item, "name": "red"})
		create(tags, map[string]any{"item_id": item, "parent_id": parent, "name": "child"})
		return nil
	}, orm.Operation(int64(1)), orm.Retry(0))
	if err != nil {
		t.Fatal(err)
	}
	return db, dsn
}

// addColumnsCount는 case database에서 query가 돌려주는 수를 native 연결로 읽는다.
func addColumnsCount(t *testing.T, driver, dsn, query string) (int64, error) {
	t.Helper()
	var raw *sql.DB
	if driver == "sqlite" {
		var err error
		if raw, err = sql.Open("sqlite", strings.TrimPrefix(dsn, "sqlite://")); err != nil {
			t.Fatal(err)
		}
	} else {
		raw = openNative(t, driver, dsn)
	}
	defer raw.Close()
	var n int64
	err := raw.QueryRow(query).Scan(&n)
	return n, err
}

func addColumnsCase(t *testing.T, driver string) {
	start := time.Now()
	t.Logf("start %s", driver)
	defer func() { t.Logf("end %s in %s", driver, time.Since(start)) }()
	db, dsn := addColumnsInstalled(t, driver)
	v2 := addColumnsSchema(t, "v2")
	count := func(query string) int64 {
		t.Helper()
		n, err := addColumnsCount(t, driver, dsn, query)
		if err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		return n
	}
	added, err := db.Utils().Schema().AddColumns(v2)
	if err != nil || !slices.Equal(added, addColumnsAdded) {
		t.Fatalf("AddColumns = %v, %v; want %v", added, err, addColumnsAdded)
	}
	// row는 그대로이고 새 column은 NULL이거나 default다.
	if n := count("SELECT COUNT(*) FROM addcol_item WHERE ref = 'item-1' AND label = 'first' AND note IS NULL AND priority = 3 AND archived = false AND status = 'new'"); n != 1 {
		t.Fatalf("items with their values and the new defaults = %d", n)
	}
	if n := count("SELECT COUNT(*) FROM addcol_tag WHERE color IS NULL"); n != 2 {
		t.Fatalf("tags with a null color = %d", n)
	}
	if n := count("SELECT COUNT(*) FROM addcol_log_entry WHERE message = 'kept'"); n != 1 {
		t.Fatalf("log entries = %d", n)
	}
	// SQLite는 foreign key를 끄고 table을 다시 만들었다. 같은 연결이 다시 켰는지 본다.
	tags := rowEntity("addcol_tag", addColumnsSchema(t, "v1"), "id", "item_id", "name")
	orphan := orm.NewCore(tags)
	orphan.Connect(db)
	orphan.Set("item_id", int64(999))
	orphan.Set("name", "orphan")
	if _, err := orphan.Create(); orm.ErrorCode(err) != orm.CodeForeignKey {
		t.Fatalf("a tag of a missing item = %v, want FOREIGN_KEY", err)
	}
	// version 2의 model은 새 column을 쓰고, audit trigger는 새 column을 기록한다.
	next, err := orm.ConnectSchema(dsn, v2, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	err = next.Transaction(func() error {
		c := orm.NewCore(rowEntity("addcol_item", v2, "id", "note", "priority", "operation_id"))
		c.Connect(next)
		c.Set("id", int64(1))
		c.Set("note", "later")
		c.Set("priority", int32(4))
		return c.Update(nil)
	}, orm.Operation(int64(2)), orm.Retry(0))
	if err != nil {
		t.Fatal(err)
	}
	if n := count("SELECT COUNT(*) FROM addcol_item_history WHERE history_action = 'update' AND previous_operation_id = 1 AND operation_id = 2 AND note = 'later' AND priority = 4 AND status = 'new'"); n != 1 {
		t.Fatalf("history rows of the update with the new columns = %d", n)
	}
	if _, err := addColumnsCount(t, driver, dsn, "SELECT COUNT(*) FROM addcol_extra"); err == nil {
		t.Fatal("AddColumns created the missing table addcol_extra")
	}
	if again, err := db.Utils().Schema().AddColumns(v2); err != nil || len(again) != 0 {
		t.Fatalf("repeated AddColumns = %v, %v", again, err)
	}
	// install은 set을 통째로만 만든다(docs/schema.md "Schema installation").
	if err := db.Utils().Schema().Install(v2); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("install of version 2 over its existing tables = %v, want CONFIG", err)
	}
}

func addColumnsDiffersCase(t *testing.T, driver string) {
	db, _ := addColumnsInstalled(t, driver)
	for _, name := range addColumnsDiffers {
		if added, err := db.Utils().Schema().AddColumns(addColumnsSchema(t, name)); orm.ErrorCode(err) != orm.CodeSchemaDiffers {
			t.Errorf("%s = %v, %v; want SCHEMA_DIFFERS", name, added, err)
		} else {
			t.Logf("%s: %v", name, err)
		}
	}
	if added, err := db.Utils().Schema().AddColumns(addColumnsSchema(t, "v2")); err != nil || !slices.Equal(added, addColumnsAdded) {
		t.Fatalf("AddColumns after the differences = %v, %v", added, err)
	}
}

func addColumnsTransactionCase(t *testing.T, driver string) {
	db, _ := addColumnsInstalled(t, driver)
	v2 := addColumnsSchema(t, "v2")
	if driver == "postgres" {
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
	} else {
		var inside error
		if err := db.Transaction(func() error {
			_, inside = db.Utils().Schema().AddColumns(v2)
			return nil
		}, orm.Retry(0)); err != nil {
			t.Fatal(err)
		}
		if orm.ErrorCode(inside) != orm.CodeConfig {
			t.Fatalf("AddColumns in a %s transaction = %v, want CONFIG", driver, inside)
		}
	}
	if added, err := db.Utils().Schema().AddColumns(v2); err != nil || !slices.Equal(added, addColumnsAdded) {
		t.Fatalf("AddColumns after the transaction = %v, %v", added, err)
	}
}

func addColumnsEditedManifestCase(t *testing.T, driver string) {
	db, _ := addColumnsInstalled(t, driver)
	v2 := addColumnsSchema(t, "v2")
	edited := &orm.Schema{Hash: v2.Hash, Text: strings.ReplaceAll(v2.Text, " note ", " memo ")}
	if _, err := db.Utils().Schema().AddColumns(edited); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("AddColumns of an edited manifest = %v, want CONFIG", err)
	}
	if added, err := db.Utils().Schema().AddColumns(v2); err != nil || !slices.Equal(added, addColumnsAdded) {
		t.Fatalf("AddColumns after the edited manifest = %v, %v", added, err)
	}
}

func TestAddColumnsSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsCase(t, "sqlite")
}

func TestAddColumnsMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsCase(t, "mysql")
}

func TestAddColumnsPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsCase(t, "postgres")
}

func TestAddColumnsDiffersSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsDiffersCase(t, "sqlite")
}

func TestAddColumnsDiffersMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsDiffersCase(t, "mysql")
}

func TestAddColumnsDiffersPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsDiffersCase(t, "postgres")
}

func TestAddColumnsTransactionSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsTransactionCase(t, "sqlite")
}

func TestAddColumnsTransactionMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsTransactionCase(t, "mysql")
}

func TestAddColumnsTransactionPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsTransactionCase(t, "postgres")
}

func TestAddColumnsEditedManifestSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsEditedManifestCase(t, "sqlite")
}

func TestAddColumnsEditedManifestMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsEditedManifestCase(t, "mysql")
}

func TestAddColumnsEditedManifestPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addColumnsEditedManifestCase(t, "postgres")
}
