package orm_test

import (
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Checks AddTablesAndColumns on SQLite, MySQL, and PostgreSQL. The case database starts from a different
// set: the table of set addcol_log and the table of addcol set version 1, each with rows. Moving to version 2
// Calling AddTablesAndColumns adds the columns that are missing from existing tables and are nullable or have a default
// keeping rows; the audit table's trigger records the new column when the audit table changes, and a missing table
// is created with its index, foreign key, check, and audit trigger, and tables of other sets
// are left as they are. Calling it again adds nothing. A missing index on an existing table is added, and a missing
// unique key is SCHEMA_DIFFERS with the reason stated. A set with other differences changes nothing
// before SCHEMA_DIFFERS. The fixtures are contracts/fixtures/add_tables_and_columns/*.dbs.

var (
	addTablesAndColumnsAdded = []string{
		"addcol_extra", "addcol_extra_history",
		"addcol_item.note", "addcol_item.priority", "addcol_item.archived", "addcol_item.status",
		"addcol_item_history.note", "addcol_item_history.priority", "addcol_item_history.archived", "addcol_item_history.status",
		"addcol_tag.color",
	}
	addTablesAndColumnsDiffers = []string{"required", "removed", "changed", "nullable", "default", "unique", "reorder"}
	// The columns and index that index.dbs adds in version 1. The index comes after the columns.
	addTablesAndColumnsIndexAdded    = []string{"addcol_item.note", "addcol_item.ix_addcol_item_label", "addcol_item_history.note"}
	addTablesAndColumnsMissingUnique = "add_unique addcol_item.uq_addcol_item_label: a missing unique key can fail on the existing rows; add it with a plan"
)

func addTablesAndColumnsSchema(t *testing.T, name string) *orm.Schema {
	t.Helper()
	return fixtureSchema(t, "add_tables_and_columns/"+name)
}

// addTablesAndColumnsInstalled installs addcol_log and version 1 in the case database, and the log row
// one, the item with audit record 1, and the link that writes that item's tag and that tag's child tag
// are returned. The connection pool holds one connection, so the next request reuses the connection AddTablesAndColumns used.
func addTablesAndColumnsInstalled(t *testing.T, driver string) (*orm.DB, string) {
	t.Helper()
	dsn := newDatabase(t, driver)
	v1 := addTablesAndColumnsSchema(t, "v1")
	logSet := addTablesAndColumnsSchema(t, "log")
	db, err := orm.ConnectSchema(dsn, v1, orm.Config{PoolSize: 1, AuditSource: auditSource("setup")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, db) })
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

// addTablesAndColumnsNative is the native connection to the case database.
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

// addTablesAndColumnsExec runs a statement on the case database over the native connection.
func addTablesAndColumnsExec(t *testing.T, driver, dsn, statement string) error {
	t.Helper()
	raw := addTablesAndColumnsNative(t, driver, dsn)
	defer testcase.Close(t, raw)
	_, err := raw.Exec(statement)
	return err
}

// addTablesAndColumnsCount reads, over the native connection, the number the query returns on the case database.
func addTablesAndColumnsCount(t *testing.T, driver, dsn, query string) (int64, error) {
	t.Helper()
	raw := addTablesAndColumnsNative(t, driver, dsn)
	defer testcase.Close(t, raw)
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
	// Rows are unchanged, and the new column is NULL or the default.
	if n := count("SELECT COUNT(*) FROM addcol_item WHERE ref = 'item-1' AND label = 'first' AND note IS NULL AND priority = 3 AND archived = false AND status = 'new'"); n != 1 {
		t.Fatalf("items with their values and the new defaults = %d", n)
	}
	if n := count("SELECT COUNT(*) FROM addcol_tag WHERE color IS NULL"); n != 2 {
		t.Fatalf("tags with a null color = %d", n)
	}
	if n := count("SELECT COUNT(*) FROM addcol_log_entry WHERE message = 'kept'"); n != 1 {
		t.Fatalf("log entries = %d", n)
	}
	// SQLite turned off foreign keys and rebuilt the table. Checks whether the same connection turned them back on.
	tags := rowEntity("addcol_tag", addTablesAndColumnsSchema(t, "v1"), "id", "item_id", "name")
	orphan := orm.NewCore(tags)
	orphan.Connect(db)
	orphan.Set("item_id", int64(999))
	orphan.Set("name", "orphan")
	if _, err := orphan.Create(); orm.ErrorCode(err) != orm.CodeForeignKey {
		t.Fatalf("a tag of a missing item = %v, want FOREIGN_KEY", err)
	}
	// The version 2 model writes the new column, and the audit trigger records the new column.
	next, err := orm.ConnectSchema(dsn, v2, auditConfig("next"))
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, next)
	err = next.Transaction(func() error {
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
	// The new table was created with its index, foreign key, check, and audit trigger.
	err = next.Transaction(func() error {
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
	// All tables exist, so install changes nothing (docs/spec/schema.md "Schema installation").
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

// addTablesAndColumnsIndexCase adds a missing index to an existing table and checks that calling it again does nothing
// and that a missing unique key is SCHEMA_DIFFERS with the reason that it can fail on existing rows.
func addTablesAndColumnsIndexCase(t *testing.T, driver string) {
	db, _ := addTablesAndColumnsInstalled(t, driver)
	if _, err := db.Utils().Schema().AddTablesAndColumns(addTablesAndColumnsSchema(t, "unique")); orm.ErrorCode(err) != orm.CodeSchemaDiffers || !strings.Contains(err.Error(), addTablesAndColumnsMissingUnique) {
		t.Errorf("a missing unique key = %v; want SCHEMA_DIFFERS with %q", err, addTablesAndColumnsMissingUnique)
	}
	index := addTablesAndColumnsSchema(t, "index")
	if added, err := db.Utils().Schema().AddTablesAndColumns(index); err != nil || !slices.Equal(added, addTablesAndColumnsIndexAdded) {
		t.Fatalf("AddTablesAndColumns with a missing index = %v, %v", added, err)
	}
	if again, err := db.Utils().Schema().AddTablesAndColumns(index); err != nil || len(again) != 0 {
		t.Fatalf("repeated AddTablesAndColumns with the index = %v, %v", again, err)
	}
	// install changes nothing only when the database matches the set: the index exists as declared.
	if err := db.Utils().Schema().Install(index); err != nil {
		t.Fatalf("install of the set with the index = %v", err)
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

// Requirements: SCH-8, SCH-9, SCH-10.
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

func TestAddTablesAndColumnsIndexSQLite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsIndexCase(t, "sqlite")
}

func TestAddTablesAndColumnsIndexMySQL(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsIndexCase(t, "mysql")
}

func TestAddTablesAndColumnsIndexPostgres(t *testing.T) {
	testcase.Start(t, testcase.Database)
	addTablesAndColumnsIndexCase(t, "postgres")
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
