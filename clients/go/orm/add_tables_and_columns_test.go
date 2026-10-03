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

// AddTablesAndColumns를 SQLite, MySQL, PostgreSQL에서 확인한다. case database는 다른
// set addcol_log의 table과 addcol set version 1의 table을 row와 함께 가진다. version 2로
// AddTablesAndColumns를 부르면 있는 table에 빠진 null이거나 default가 있는 column을
// 더하고, row를 지키며, 바뀐 audit table의 trigger가 새 column을 기록하고, 없는 table을
// index, foreign key, check, audit trigger와 함께 만들며, 다른 set의 table은 그대로
// 둔다. 다시 부르면 아무것도 더하지 않는다. 다른 차이가 있는 set은 아무것도 바꾸기
// 전에 SCHEMA_DIFFERS다. fixture는 contracts/fixtures/add_tables_and_columns/*.dbs다.

var (
	addTablesAndColumnsAdded = []string{
		"addcol_extra", "addcol_extra_history",
		"addcol_item.note", "addcol_item.priority", "addcol_item.archived", "addcol_item.status",
		"addcol_item_history.note", "addcol_item_history.priority", "addcol_item_history.archived", "addcol_item_history.status",
		"addcol_tag.color",
	}
	addTablesAndColumnsDiffers = []string{"required", "removed", "changed", "nullable", "default", "index", "unique", "reorder"}
)

func addTablesAndColumnsSchema(t *testing.T, name string) *orm.Schema {
	t.Helper()
	return fixtureSchema(t, "add_tables_and_columns/"+name)
}

// addTablesAndColumnsInstalled는 case database에 addcol_log와 version 1을 설치하고, log row
// 하나, audit 기록 1로 item 하나, 그 item의 tag와 그 tag의 자식 tag를 쓴 연결을
// 돌려준다. 연결의 pool은 연결 하나라 AddTablesAndColumns가 쓴 연결을 다음 요청이 다시 쓴다.
func addTablesAndColumnsInstalled(t *testing.T, driver string) (*orm.DB, string) {
	t.Helper()
	dsn := newDatabase(t, driver)
	v1 := addTablesAndColumnsSchema(t, "v1")
	logSet := addTablesAndColumnsSchema(t, "log")
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
	err = db.Audit(auditOf(v1, "setup")).Transaction(func() error {
		item := create(rowEntity("addcol_item", v1, "id", "ref", "label", "audit_seq"), map[string]any{"ref": "item-1", "label": "first"})
		tags := rowEntity("addcol_tag", v1, "id", "item_id", "parent_id", "name")
		parent := create(tags, map[string]any{"item_id": item, "name": "red"})
		create(tags, map[string]any{"item_id": item, "parent_id": parent, "name": "child"})
		return nil
	}, orm.Audit(nil), orm.Retry(0))
	if err != nil {
		t.Fatal(err)
	}
	return db, dsn
}

// addTablesAndColumnsNative는 case database의 native 연결이다.
func addTablesAndColumnsNative(t *testing.T, driver, dsn string) *sql.DB {
	t.Helper()
	if driver != "sqlite" {
		return openNative(t, driver, dsn)
	}
	raw, err := sql.Open("sqlite", strings.TrimPrefix(dsn, "sqlite://")+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// addTablesAndColumnsExec는 case database에서 statement를 native 연결로 실행한다.
func addTablesAndColumnsExec(t *testing.T, driver, dsn, statement string) error {
	t.Helper()
	raw := addTablesAndColumnsNative(t, driver, dsn)
	defer raw.Close()
	_, err := raw.Exec(statement)
	return err
}

// addTablesAndColumnsCount는 case database에서 query가 돌려주는 수를 native 연결로 읽는다.
func addTablesAndColumnsCount(t *testing.T, driver, dsn, query string) (int64, error) {
	t.Helper()
	raw := addTablesAndColumnsNative(t, driver, dsn)
	defer raw.Close()
	var n int64
	err := raw.QueryRow(query).Scan(&n)
	return n, err
}

func addTablesAndColumnsCase(t *testing.T, driver string) {
	start := time.Now()
	t.Logf("start %s", driver)
	defer func() { t.Logf("end %s in %s", driver, time.Since(start)) }()
	db, dsn := addTablesAndColumnsInstalled(t, driver)
	v2 := addTablesAndColumnsSchema(t, "v2")
	count := func(query string) int64 {
		t.Helper()
		n, err := addTablesAndColumnsCount(t, driver, dsn, query)
		if err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		return n
	}
	added, err := db.Utils().Schema().AddTablesAndColumns(v2)
	if err != nil || !slices.Equal(added, addTablesAndColumnsAdded) {
		t.Fatalf("AddTablesAndColumns = %v, %v; want %v", added, err, addTablesAndColumnsAdded)
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
	tags := rowEntity("addcol_tag", addTablesAndColumnsSchema(t, "v1"), "id", "item_id", "name")
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
	err = next.Audit(auditOf(v2, "update")).Transaction(func() error {
		c := orm.NewCore(rowEntity("addcol_item", v2, "id", "note", "priority", "audit_seq"))
		c.Connect(next)
		c.Set("id", int64(1))
		c.Set("note", "later")
		c.Set("priority", int32(4))
		return c.Update(nil)
	}, orm.Audit(nil), orm.Retry(0))
	if err != nil {
		t.Fatal(err)
	}
	if n := count("SELECT COUNT(*) FROM addcol_item_history WHERE history_action = 'update' AND previous_audit_seq = 1 AND audit_seq = 2 AND note = 'later' AND priority = 4 AND status = 'new'"); n != 1 {
		t.Fatalf("history rows of the update with the new columns = %d", n)
	}
	// 새 table은 index, foreign key, check, audit trigger와 함께 만들어졌다.
	err = next.Audit(auditOf(v2, "extra")).Transaction(func() error {
		c := orm.NewCore(rowEntity("addcol_extra", v2, "id", "item_id", "label", "audit_seq"))
		c.Connect(next)
		c.Set("item_id", int64(1))
		c.Set("label", "extra")
		_, err := c.Create()
		return err
	}, orm.Audit(nil), orm.Retry(0))
	if err != nil {
		t.Fatal(err)
	}
	if n := count("SELECT COUNT(*) FROM addcol_extra_history WHERE history_action = 'insert' AND previous_audit_seq IS NULL AND audit_seq = 3 AND item_id = 1 AND label = 'extra'"); n != 1 {
		t.Fatalf("history rows of the insert into the created table = %d", n)
	}
	for statement, want := range map[string]string{
		"INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (999, 'orphan', 3)": "foreign key",
		"INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, '', 3)":         "check",
		"DELETE FROM addcol_extra": "audit delete",
	} {
		if err := addTablesAndColumnsExec(t, driver, dsn, statement); err == nil {
			t.Fatalf("the %s of the created table accepted %s", want, statement)
		}
	}
	if n := count("SELECT COUNT(*) FROM addcol_extra"); n != 1 {
		t.Fatalf("rows of the created table = %d", n)
	}
	if again, err := db.Utils().Schema().AddTablesAndColumns(v2); err != nil || len(again) != 0 {
		t.Fatalf("repeated AddTablesAndColumns = %v, %v", again, err)
	}
	// 모든 table이 있으므로 install은 아무것도 바꾸지 않는다(docs/schema.md "Schema installation").
	if err := db.Utils().Schema().Install(v2); err != nil {
		t.Fatalf("install of version 2 over its tables = %v", err)
	}
}

func addTablesAndColumnsDiffersCase(t *testing.T, driver string) {
	db, _ := addTablesAndColumnsInstalled(t, driver)
	for _, name := range addTablesAndColumnsDiffers {
		if added, err := db.Utils().Schema().AddTablesAndColumns(addTablesAndColumnsSchema(t, name)); orm.ErrorCode(err) != orm.CodeSchemaDiffers {
			t.Errorf("%s = %v, %v; want SCHEMA_DIFFERS", name, added, err)
		} else {
			t.Logf("%s: %v", name, err)
		}
	}
	if added, err := db.Utils().Schema().AddTablesAndColumns(addTablesAndColumnsSchema(t, "v2")); err != nil || !slices.Equal(added, addTablesAndColumnsAdded) {
		t.Fatalf("AddTablesAndColumns after the differences = %v, %v", added, err)
	}
}

func addTablesAndColumnsTransactionCase(t *testing.T, driver string) {
	db, _ := addTablesAndColumnsInstalled(t, driver)
	v2 := addTablesAndColumnsSchema(t, "v2")
	if driver == "postgres" {
		rollback := errors.New("roll back")
		err := db.Transaction(func() error {
			if added, err := db.Utils().Schema().AddTablesAndColumns(v2); err != nil || !slices.Equal(added, addTablesAndColumnsAdded) {
				return fmt.Errorf("AddTablesAndColumns in the transaction = %v, %v", added, err)
			}
			return rollback
		}, orm.Retry(0))
		if !errors.Is(err, rollback) {
			t.Fatalf("transaction = %v", err)
		}
	} else {
		var inside error
		if err := db.Transaction(func() error {
			_, inside = db.Utils().Schema().AddTablesAndColumns(v2)
			return nil
		}, orm.Retry(0)); err != nil {
			t.Fatal(err)
		}
		if orm.ErrorCode(inside) != orm.CodeConfig {
			t.Fatalf("AddTablesAndColumns in a %s transaction = %v, want CONFIG", driver, inside)
		}
	}
	if added, err := db.Utils().Schema().AddTablesAndColumns(v2); err != nil || !slices.Equal(added, addTablesAndColumnsAdded) {
		t.Fatalf("AddTablesAndColumns after the transaction = %v, %v", added, err)
	}
}

func addTablesAndColumnsEditedManifestCase(t *testing.T, driver string) {
	db, _ := addTablesAndColumnsInstalled(t, driver)
	v2 := addTablesAndColumnsSchema(t, "v2")
	edited := &orm.Schema{Hash: v2.Hash, Text: strings.ReplaceAll(v2.Text, " note ", " memo ")}
	if _, err := db.Utils().Schema().AddTablesAndColumns(edited); orm.ErrorCode(err) != orm.CodeConfig {
		t.Fatalf("AddTablesAndColumns of an edited manifest = %v, want CONFIG", err)
	}
	if added, err := db.Utils().Schema().AddTablesAndColumns(v2); err != nil || !slices.Equal(added, addTablesAndColumnsAdded) {
		t.Fatalf("AddTablesAndColumns after the edited manifest = %v, %v", added, err)
	}
}

func TestAddTablesAndColumnsSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsCase(t, "sqlite")
}

func TestAddTablesAndColumnsMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsCase(t, "mysql")
}

func TestAddTablesAndColumnsPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsCase(t, "postgres")
}

func TestAddTablesAndColumnsDiffersSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsDiffersCase(t, "sqlite")
}

func TestAddTablesAndColumnsDiffersMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsDiffersCase(t, "mysql")
}

func TestAddTablesAndColumnsDiffersPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsDiffersCase(t, "postgres")
}

func TestAddTablesAndColumnsTransactionSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsTransactionCase(t, "sqlite")
}

func TestAddTablesAndColumnsTransactionMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsTransactionCase(t, "mysql")
}

func TestAddTablesAndColumnsTransactionPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsTransactionCase(t, "postgres")
}

func TestAddTablesAndColumnsEditedManifestSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsEditedManifestCase(t, "sqlite")
}

func TestAddTablesAndColumnsEditedManifestMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsEditedManifestCase(t, "mysql")
}

func TestAddTablesAndColumnsEditedManifestPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsEditedManifestCase(t, "postgres")
}
