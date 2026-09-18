package orm_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

// auditLogSchema declares the log tables in the app schema, and auditItemSchema
// is a second manifest whose audit writes into them. MySQL maps a schema to a
// database, so its variant uses plain table names.
const auditLogSchema = "er" + "Diagram\n" +
	"  audit_operation {\n" +
	"    bigint       seq            PK \"auto\"\n" +
	"    varchar(36)  operation_uuid UK\n" +
	"  }\n" +
	"  audit_change {\n" +
	"    bigint       seq            PK \"auto\"\n" +
	"    bigint       operation_seq\n" +
	"    varchar(16)  change_kind\n" +
	"    varchar(36)  site_ref       \"?\"\n" +
	"    varchar(191) table_label\n" +
	"    jsontext     entity_ref\n" +
	"    jsontext     before_value\n" +
	"    jsontext     after_value\n" +
	"  }\n" +
	"  %% orm:table entity=audit_operation name=app.audit_operation\n" +
	"  %% orm:table entity=audit_change name=app.audit_change\n"

const auditItemSchema = "er" + "Diagram\n" +
	"  audit_item {\n" +
	"    bigint       seq            PK \"auto\"\n" +
	"    varchar(36)  site_ref\n" +
	"    varchar(191) title\n" +
	"    text         json_detail    \"?\"\n" +
	"  }\n" +
	"  %% orm:table entity=audit_item name=app.audit_item\n" +
	"  %% orm:audit_log operation=app.audit_operation(seq, operation_uuid) context=app.operation_id change=app.audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n" +
	"  %% orm:audit entity=audit_item mode=changes site=site_ref redact=json_detail.secret\n"

// auditManifest builds a schema, without schema-qualified tables on MySQL.
func auditManifest(t *testing.T, source, driver string) (*schema.Manifest, []byte) {
	t.Helper()
	if driver == "mysql" {
		var lines []string
		for _, line := range strings.Split(strings.ReplaceAll(source, "app.audit_", "audit_"), "\n") {
			if !strings.Contains(line, "%% orm:table") {
				lines = append(lines, line)
			}
		}
		source = strings.Join(lines, "\n")
	}
	d, err := schema.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return m, manifest
}

func rowEntity(name, hash string, columns ...string) *orm.Entity {
	return &orm.Entity{
		Name:   name,
		Schema: &orm.Schema{Hash: hash},
		New: func(c *orm.Core) orm.Model {
			r := &keywordRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) bool {
			for _, c := range columns {
				if c == name {
					m.(*keywordRow).vals[name] = v
					return true
				}
			}
			return false
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

// TestAuditTriggers installs log tables and, from a second manifest, audited
// tables, and writes inside a transaction that names its operation with
// SetLocal.
func TestAuditTriggers(t *testing.T) {
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "audit.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			tables := []string{"app.audit_item", "app.audit_change", "app.audit_operation"}
			if driver == "mysql" {
				tables = []string{"audit_item", "audit_change", "audit_operation"}
			}
			logs, logManifest := auditManifest(t, auditLogSchema, driver)
			m, manifest := auditManifest(t, auditItemSchema, driver)
			dropAuditSchema(t, driver, dsn, tables)
			defer dropAuditSchema(t, driver, dsn, tables)
			eng, err := engine.New(logs, driver)
			if err != nil {
				t.Fatal(err)
			}
			db, err := orm.Open(dsn, eng, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			for _, text := range [][]byte{logManifest, manifest, manifest} {
				if err := db.Utils().Schema().Install(text); err != nil {
					t.Fatal(err)
				}
			}
			operations := rowEntity("audit_operation", logs.SchemaHash, "seq", "operation_uuid")
			changes := rowEntity("audit_change", logs.SchemaHash, "seq", "operation_seq", "change_kind", "site_ref", "table_label", "entity_ref", "before_value", "after_value")
			items := rowEntity("audit_item", m.SchemaHash, "seq", "site_ref", "title", "json_detail")
			model := func(ent *orm.Entity) (*orm.Core, *keywordRow) {
				c := orm.NewCore(ent)
				return c, ent.New(c).(*keywordRow)
			}
			err = db.Transaction(func() error {
				c, _ := model(items)
				c.Set("site_ref", "s1")
				c.Set("title", "a")
				_, err := c.Create()
				return err
			}, orm.Retry(0))
			if err == nil || !strings.Contains(err.Error(), "audit operation context is required") {
				t.Fatalf("write without an operation: %v", err)
			}
			var item any
			err = db.Transaction(func() error {
				op, _ := model(operations)
				op.Set("operation_uuid", "op-1")
				if _, err := op.Create(); err != nil {
					return err
				}
				if err := db.Utils().SetLocal("app.operation_id", "op-1"); err != nil {
					return err
				}
				c, _ := model(items)
				c.Set("site_ref", "s1")
				c.Set("title", "a")
				c.Set("json_detail", map[string]any{"secret": "s3cret", "kept": "v"})
				created, err := c.Create()
				if err != nil {
					return err
				}
				id := created.(*keywordRow).vals["seq"]
				item = id
				u, _ := model(items)
				u.Set("seq", id)
				u.Set("title", "b")
				return u.Update(nil)
			}, orm.Retry(0))
			if err != nil {
				t.Fatal(err)
			}
			q, _ := model(changes)
			q.Connect(db)
			q.AddAllColumns()
			q.OrderBy("seq", false, nil)
			rows, err := orm.Gets[*keywordRow](q)
			if err != nil {
				t.Fatal(err)
			}
			if rows.Len() != 2 {
				t.Fatalf("change rows: %d", rows.Len())
			}
			var got []string
			var all []*keywordRow
			for _, row := range rows.All() {
				all = append(all, row)
				v := row.vals
				if orm.AsInt64(v["operation_seq"]) != 1 || v["site_ref"] != "s1" || v["table_label"] != tables[0] {
					t.Fatalf("change row: %v", v)
				}
				key := jsonText(t, v["entity_ref"])
				if !reflect.DeepEqual(key, map[string]any{"seq": float64(orm.AsInt64(item))}) {
					t.Fatalf("entity key: %v", key)
				}
				got = append(got, v["change_kind"].(string))
			}
			if strings.Join(got, ",") != "INSERT,UPDATE" {
				t.Fatalf("change kinds: %v", got)
			}
			insert := jsonText(t, all[0].vals["after_value"]).(map[string]any)
			detail, ok := insert["json_detail"].(map[string]any)
			if !ok {
				t.Fatalf("inserted detail: %v", insert["json_detail"])
			}
			if !reflect.DeepEqual(detail["secret"], map[string]any{"redacted": true, "present": true}) {
				t.Fatalf("redacted path: %v", detail["secret"])
			}
			if detail["kept"] != "v" {
				t.Fatalf("kept value: %v", detail["kept"])
			}
			if strings.Contains(strings.ToLower(string(mustJSON(t, all[0].vals))), "s3cret") {
				t.Fatal("the secret is recorded in the change row")
			}
			update := all[1].vals
			if before, after := jsonText(t, update["before_value"]), jsonText(t, update["after_value"]); !reflect.DeepEqual(before, map[string]any{"title": "a"}) || !reflect.DeepEqual(after, map[string]any{"title": "b"}) {
				t.Fatalf("update values: %v %v", before, after)
			}
		})
	}
}

// jsonText decodes a JSON column value read through the JSON codec.
func jsonText(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func dropAuditSchema(t *testing.T, driver, dsn string, tables []string) {
	t.Helper()
	switch driver {
	case "mysql":
		for _, table := range tables {
			dropTable(t, driver, dsn, table)
		}
	case "postgres":
		raw, err := sql.Open("pgx", dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer raw.Close()
		if _, err := raw.Exec("DROP SCHEMA IF EXISTS app CASCADE"); err != nil {
			t.Fatal(err)
		}
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
