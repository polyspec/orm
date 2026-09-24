package orm_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
)

// auditServiceSchema declares a change table whose service column is bigint,
// an audited table that names its bigint service column, and an audited table
// without a service column. The routed table has an enum column with a default.
const auditServiceSchema = "er" + "Diagram\n" +
	"  audit_operation {\n" +
	"    bigint       seq            PK \"auto\"\n" +
	"    varchar(36)  operation_uuid UK\n" +
	"  }\n" +
	"  audit_change {\n" +
	"    bigint       seq            PK \"auto\"\n" +
	"    bigint       operation_seq\n" +
	"    varchar(16)  change_kind\n" +
	"    bigint       service_seq       \"?\"\n" +
	"    varchar(191) table_label\n" +
	"    jsontext     entity_ref\n" +
	"    jsontext     before_value\n" +
	"    jsontext     after_value\n" +
	"  }\n" +
	"  routed {\n" +
	"    bigint       seq            PK \"auto\"\n" +
	"    bigint       service_seq\n" +
	"    enum(csr_ssr) render           \"=ssr\"\n" +
	"  }\n" +
	"  unowned {\n" +
	"    bigint       seq            PK \"auto\"\n" +
	"    varchar(32)  label\n" +
	"  }\n" +
	"  %% orm:table entity=audit_operation name=app.audit_operation\n" +
	"  %% orm:table entity=audit_change name=app.audit_change\n" +
	"  %% orm:table entity=routed name=app.routed\n" +
	"  %% orm:table entity=unowned name=app.unowned\n" +
	"  %% orm:audit_log operation=app.audit_operation(seq, operation_uuid) context=app.operation_id change=app.audit_change(operation_seq, change_kind, service_seq, table_label, entity_ref, before_value, after_value)\n" +
	"  %% orm:audit entity=routed mode=changes service=service_seq\n" +
	"  %% orm:audit entity=unowned mode=changes\n"

// TestAuditBigintService installs an enum column and audit triggers that write
// a bigint service value, and a NULL one for a table without a service column,
// on the three databases.
func TestAuditBigintService(t *testing.T) {
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "audit-service.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			tables := []string{"app.routed", "app.unowned", "app.audit_change", "app.audit_operation"}
			if driver == "mysql" {
				tables = []string{"routed", "unowned", "audit_change", "audit_operation"}
			}
			m, manifest := auditManifest(t, auditServiceSchema, driver)
			dropAuditSchema(t, driver, dsn, tables)
			defer dropAuditSchema(t, driver, dsn, tables)
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			db, err := orm.Open(dsn, eng, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifest); err != nil {
				t.Fatalf("install: %v", err)
			}
			operations := rowEntity("audit_operation", m.SchemaHash, "seq", "operation_uuid")
			changes := rowEntity("audit_change", m.SchemaHash, "seq", "operation_seq", "change_kind", "service_seq", "table_label", "entity_ref", "before_value", "after_value")
			routed := rowEntity("routed", m.SchemaHash, "seq", "service_seq", "render")
			unowned := rowEntity("unowned", m.SchemaHash, "seq", "label")
			err = db.Transaction(func() error {
				op := orm.NewCore(operations)
				operations.New(op)
				op.Set("operation_uuid", "op-1")
				if _, err := op.Create(); err != nil {
					return err
				}
				if err := db.Utils().SetLocal("app.operation_id", "op-1"); err != nil {
					return err
				}
				r := orm.NewCore(routed)
				routed.New(r)
				r.Set("service_seq", int64(42))
				if _, err := r.Create(); err != nil {
					return err
				}
				u := orm.NewCore(unowned)
				unowned.New(u)
				u.Set("label", "a")
				_, err := u.Create()
				return err
			}, orm.Retry(0))
			if err != nil {
				t.Fatalf("audited writes: %v", err)
			}
			q := orm.NewCore(changes)
			changes.New(q)
			q.Connect(db)
			q.AddAllColumns()
			q.OrderBy("seq", false, nil)
			rows, err := orm.Gets[*keywordRow](q)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, row := range rows.All() {
				label := row.vals["table_label"].(string)
				label = label[strings.LastIndex(label, ".")+1:]
				service := "null"
				if v := row.vals["service_seq"]; v != nil {
					service = "42"
					if orm.AsInt64(v) != 42 {
						t.Fatalf("service_seq %v", v)
					}
				}
				after := jsonText(t, row.vals["after_value"]).(map[string]any)
				if label == "routed" && after["render"] != "ssr" {
					t.Fatalf("render default: %v", after)
				}
				got = append(got, label+":"+service)
			}
			if strings.Join(got, ",") != "routed:42,unowned:null" {
				t.Fatalf("changes: %v", got)
			}
		})
	}
}
