package orm_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
)

// auditLargeBudget bounds one audited write of a large value. A trigger that
// exceeds it holds its connection long enough to stall the database.
const auditLargeBudget = 3 * time.Second

// auditLargeSchema audits a jsontext column that holds a large document.
const auditLargeSchema = "er" + "Diagram\n" +
	"  audit_doc {\n" +
	"    bigint       seq            PK \"auto\"\n" +
	"    varchar(36)  site_ref\n" +
	"    jsontext     body\n" +
	"  }\n" +
	"  %% orm:table entity=audit_doc name=app.audit_doc\n" +
	"  %% orm:audit_log operation=app.audit_operation(seq, operation_uuid) context=app.operation_id change=app.audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n" +
	"  %% orm:audit entity=audit_doc mode=changes site=site_ref redact=body.secret\n"

// TestAuditLargeUnicodeValueStaysWithinBudget writes a document of more than
// 1 MiB whose text is mostly escaped characters, as Go's encoder writes <, >,
// & and newlines, and times each audited statement against the budget. The
// failure names the step, so a slow trigger is told apart from a lock wait.
func TestAuditLargeUnicodeValueStaysWithinBudget(t *testing.T) {
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "audit-large.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	type document struct {
		Body   string `json:"body"`
		Number string `json:"number"`
		Flag   bool   `json:"flag,omitempty"`
	}
	older, err := json.Marshal(document{Body: "이전 " + strings.Repeat("감사 원본 <>&\n", 60000), Number: "9007199254740993"})
	if err != nil {
		t.Fatal(err)
	}
	newer, err := json.Marshal(document{Body: "결과 " + strings.Repeat("감사 원본 <>&\n", 60000), Number: "9007199254740995", Flag: true})
	if err != nil {
		t.Fatal(err)
	}
	// decoded stores the document as a JSON object, so the trigger compares
	// its decoded strings, which carry the raw <, >, & and newlines.
	decoded := func(text []byte) map[string]any {
		var value map[string]any
		if err := json.Unmarshal(text, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	if len(older) <= 1<<20 {
		t.Fatalf("the document must exceed 1 MiB, got %d bytes", len(older))
	}
	for driver, dsn := range targets {
		if dsn == "" {
			continue
		}
		t.Run(driver, func(t *testing.T) {
			tables := []string{"app.audit_doc", "app.audit_change", "app.audit_operation"}
			if driver == "mysql" {
				tables = []string{"audit_doc", "audit_change", "audit_operation"}
			}
			logs, logManifest := auditManifest(t, auditLogSchema, driver)
			m, manifest := auditManifest(t, auditLargeSchema, driver)
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
			for _, text := range [][]byte{logManifest, manifest} {
				if err := db.Utils().Schema().Install(text); err != nil {
					t.Fatal(err)
				}
			}
			operations := rowEntity("audit_operation", logs.SchemaHash, "seq", "operation_uuid")
			docs := rowEntity("audit_doc", m.SchemaHash, "seq", "site_ref", "body")
			model := func(ent *orm.Entity) *orm.Core {
				c := orm.NewCore(ent)
				ent.New(c)
				return c
			}
			step := func(name string, run func() error) {
				t.Helper()
				start := time.Now()
				err := run()
				elapsed := time.Since(start)
				t.Logf("%s: %s", name, elapsed)
				if err != nil {
					t.Fatalf("%s after %s: %v", name, elapsed, err)
				}
				if elapsed > auditLargeBudget {
					t.Errorf("%s took %s, budget %s", name, elapsed, auditLargeBudget)
				}
			}
			// The deadline ends the wait on the client; a statement stuck in the
			// server keeps its backend, which is what the budget reports.
			ctx, cancel := context.WithTimeout(context.Background(), 4*auditLargeBudget)
			defer cancel()
			handle := db.WithContext(ctx)
			err = handle.Transaction(func() error {
				op := model(operations)
				op.Set("operation_uuid", "op-large")
				if _, err := op.Create(); err != nil {
					return err
				}
				if err := handle.Utils().SetLocal("app.operation_id", "op-large"); err != nil {
					return err
				}
				var id any
				step("insert", func() error {
					c := model(docs)
					c.Set("site_ref", "s1")
					c.Set("body", decoded(older))
					created, err := c.Create()
					if err == nil {
						id = created.(*keywordRow).vals["seq"]
					}
					return err
				})
				step("update", func() error {
					u := model(docs)
					u.Set("seq", id)
					u.Set("body", decoded(newer))
					return u.Update(nil)
				})
				step("unchanged update", func() error {
					u := model(docs)
					u.Set("seq", id)
					u.Set("body", decoded(newer))
					return u.Update(nil)
				})
				return nil
			}, orm.Retry(0))
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

// TestAuditLargeTextChangeStaysWithinBudget changes only the long string of a
// large document written straight into an audited PostgreSQL table, so the two
// versions have the same keys and finding the changed columns reaches the
// strings themselves. Compared under a glibc collation, long strings full of
// ignorable characters (<, >, & and newlines) take a path that ignores
// interrupts and outlives the budget; the trigger must compare bytes.
func TestAuditLargeTextChangeStaysWithinBudget(t *testing.T) {
	dsn := os.Getenv("ORM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ORM_TEST_POSTGRES_DSN is not set")
	}
	type document struct {
		Body   string `json:"body"`
		Number string `json:"number"`
	}
	older, err := json.Marshal(document{Body: "이전 " + strings.Repeat("감사 원본 <>&\n", 60000), Number: "9007199254740993"})
	if err != nil {
		t.Fatal(err)
	}
	newer, err := json.Marshal(document{Body: "결과 " + strings.Repeat("감사 원본 <>&\n", 60000), Number: "9007199254740993"})
	if err != nil {
		t.Fatal(err)
	}
	tables := []string{"app.audit_doc", "app.audit_change", "app.audit_operation"}
	logs, logManifest := auditManifest(t, auditLogSchema, "postgres")
	_, manifest := auditManifest(t, auditLargeSchema, "postgres")
	dropAuditSchema(t, "postgres", dsn, tables)
	defer dropAuditSchema(t, "postgres", dsn, tables)
	eng, err := engine.New(logs, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open(dsn, eng, orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, text := range [][]byte{logManifest, manifest} {
		if err := db.Utils().Schema().Install(text); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*auditLargeBudget)
	defer cancel()
	tx, err := raw.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	step := func(name, statement string, args ...any) {
		t.Helper()
		start := time.Now()
		_, err := tx.ExecContext(ctx, statement, args...)
		elapsed := time.Since(start)
		t.Logf("%s: %s", name, elapsed)
		if err != nil {
			t.Fatalf("%s after %s: %v", name, elapsed, err)
		}
		if elapsed > auditLargeBudget {
			t.Errorf("%s took %s, budget %s", name, elapsed, auditLargeBudget)
		}
	}
	step("record the operation", `INSERT INTO app.audit_operation (operation_uuid) VALUES ('op-large-text')`)
	step("name the operation", `SELECT set_config('app.operation_id', 'op-large-text', true)`)
	step("insert", `INSERT INTO app.audit_doc (site_ref, body) VALUES ('s1', $1)`, string(older))
	step("change only the string", `UPDATE app.audit_doc SET body = $1 WHERE site_ref = 's1'`, string(newer))
	var changes int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM app.audit_change WHERE change_kind = 'UPDATE'`).Scan(&changes); err != nil {
		t.Fatal(err)
	}
	if changes != 1 {
		t.Fatalf("UPDATE change rows = %d, want 1", changes)
	}
}
