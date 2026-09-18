package ormgen

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/engine/schema"
	_ "modernc.org/sqlite"
)

const (
	auditLogTables = "er" + "Diagram\n" +
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
		"  }\n"
	auditItemStart = "  audit_item {\n" +
		"    bigint       seq            PK \"auto\"\n" +
		"    varchar(36)  site_ref\n" +
		"    varchar(191) title\n"
	auditItemRank = "    int          rank           \"=0\"\n"
	auditItemEnd  = "    jsontext     payload        \"?\"\n" +
		"  }\n" +
		"  audit_note {\n" +
		"    bigint       seq            PK \"auto\"\n" +
		"    varchar(191) body\n" +
		"  }\n"
	auditLogLine  = "  %% orm:audit_log operation=audit_operation(seq, operation_uuid) context=app.operation_id change=audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n"
	auditItemLine = "  %% orm:audit entity=audit_item mode=changes site=site_ref redact=payload.token,payload.card.number\n"
	auditNoteLine = "  %% orm:audit entity=audit_note mode=operations\n"
	auditHead     = auditLogTables + auditItemStart + auditItemEnd

	auditBase = auditHead + auditLogLine + auditItemLine + auditNoteLine
	// auditWithColumn declares a new column in the middle of the audited table.
	auditWithColumn = auditLogTables + auditItemStart + auditItemRank + auditItemEnd + auditLogLine + auditItemLine + auditNoteLine
	// auditWithoutItem removes the audit of audit_item.
	auditWithoutItem = auditLogTables + auditItemStart + auditItemRank + auditItemEnd + auditLogLine + auditNoteLine
	// auditNullableTitle forces a SQLite table rebuild.
	auditNullableTitle = auditLogTables + "  audit_item {\n" +
		"    bigint       seq            PK \"auto\"\n" +
		"    varchar(36)  site_ref\n" +
		"    varchar(191) title          \"?\"\n" +
		auditItemEnd + auditLogLine + auditItemLine + auditNoteLine
	// auditOperationsItem changes the audit mode of audit_item.
	auditOperationsItem = auditHead + auditLogLine + "  %% orm:audit entity=audit_item mode=operations\n" + auditNoteLine
)

var auditTables = []string{"audit_operation", "audit_change", "audit_item", "audit_note"}

func TestAuditDirectivesBuild(t *testing.T) {
	m := buildLiveDiffManifest(t, auditBase)
	want := &schema.AuditLog{
		Operation: schema.AuditTable{Table: "audit_operation", Columns: []string{"seq", "operation_uuid"}},
		Context:   "app.operation_id",
		Change:    schema.AuditTable{Table: "audit_change", Columns: []string{"operation_seq", "change_kind", "site_ref", "table_label", "entity_ref", "before_value", "after_value"}},
	}
	if !reflect.DeepEqual(m.AuditLog, want) {
		t.Fatalf("audit log = %+v", m.AuditLog)
	}
	audits := []schema.Audit{
		{Entity: "audit_item", Mode: "changes", Site: "site_ref", Redact: [][]string{{"payload", "token"}, {"payload", "card", "number"}}},
		{Entity: "audit_note", Mode: "operations"},
	}
	if !reflect.DeepEqual(m.Audits, audits) {
		t.Fatalf("audits = %+v", m.Audits)
	}
	if m.SchemaHash == buildLiveDiffManifest(t, auditOperationsItem).SchemaHash {
		t.Fatal("the audit mode does not change the schema hash")
	}
}

func TestAuditDirectiveErrors(t *testing.T) {
	cases := []struct{ want, source string }{
		{"%% orm:audit requires %% orm:audit_log", auditHead + "  %% orm:audit entity=audit_item mode=changes\n"},
		{"%% orm:audit_log: declared more than once", auditHead + auditLogLine + "  %% orm:audit_log operation=audit_operation(seq, operation_uuid) context=app.other_id change=audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n"},
		{"%% orm:audit: unknown entity missing", auditHead + auditLogLine + "  %% orm:audit entity=missing mode=changes\n"},
		{"%% orm:audit: mode must be changes or operations", auditHead + auditLogLine + "  %% orm:audit entity=audit_item mode=all\n"},
		{"%% orm:audit: unknown column audit_item.nope", auditHead + auditLogLine + "  %% orm:audit entity=audit_item mode=changes site=nope\n"},
		{"%% orm:audit: redact paths overlap: payload.token", auditHead + auditLogLine + "  %% orm:audit entity=audit_item mode=changes redact=payload,payload.token\n"},
		{"%% orm:audit: invalid redact path payload..token", auditHead + auditLogLine + "  %% orm:audit entity=audit_item mode=changes redact=payload..token\n"},
		{"%% orm:audit: unknown column audit_item.missing", auditHead + auditLogLine + "  %% orm:audit entity=audit_item mode=changes redact=missing.token\n"},
		{"%% orm:audit: entity audit_item is declared more than once", auditHead + auditLogLine + "  %% orm:audit entity=audit_item mode=changes\n  %% orm:audit entity=audit_item mode=operations\n"},
		{"%% orm:audit: the audit log table audit_change cannot be audited", auditHead + auditLogLine + "  %% orm:audit entity=audit_change mode=changes\n"},
		{"orm:audit: unknown option table", auditHead + auditLogLine + "  %% orm:audit table=audit_item mode=changes\n"},
		{"%% orm:audit_log: change needs 7 columns", auditHead + "  %% orm:audit_log operation=audit_operation(seq, operation_uuid) context=app.operation_id change=audit_change(operation_seq)\n"},
		{"%% orm:audit_log: operation has an invalid column seq-1", auditHead + "  %% orm:audit_log operation=audit_operation(seq-1, operation_uuid) context=app.operation_id change=audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n"},
		{"%% orm:audit_log: operation must be table(column, ...)", auditHead + "  %% orm:audit_log operation=core.log.operation(seq, operation_uuid) context=app.operation_id change=audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n"},
		{"%% orm:audit_log: invalid context bad-key", auditHead + "  %% orm:audit_log operation=audit_operation(seq, operation_uuid) context=bad-key change=audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n"},
		{"%% orm:audit_log: operation must be table(column, ...)", auditHead + "  %% orm:audit_log operation=audit_operation context=app.operation_id change=audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n"},
		{"%% orm:audit_log: operation and change must be different tables", auditHead + "  %% orm:audit_log operation=audit_change(seq, change_kind) context=app.operation_id change=audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n"},
		{"%% orm:audit_log: change repeats column operation_seq", auditHead + "  %% orm:audit_log operation=audit_operation(seq, operation_uuid) context=app.operation_id change=audit_change(operation_seq, operation_seq, site_ref, table_label, entity_ref, before_value, after_value)\n"},
		{"%% orm:audit_log: context is required", auditHead + "  %% orm:audit_log operation=audit_operation(seq, operation_uuid) change=audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n"},
	}
	for _, c := range cases {
		d, err := schema.Parse(c.source)
		if err == nil {
			_, err = schema.Build(d)
		}
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v", c.want, err)
		}
	}
}

// auditExternalLog audits into log tables that another manifest declares.
const auditExternalLog = "er" + "Diagram\n" +
	"  member_account {\n" +
	"    bigint       seq            PK \"auto\"\n" +
	"    varchar(191) email\n" +
	"  }\n" +
	"  %% orm:audit_log operation=core.operation(seq, operation_uuid) context=app.operation_id change=core.operation_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n" +
	"  %% orm:audit entity=member_account mode=changes\n"

func TestAuditLogTablesAreReferences(t *testing.T) {
	m := buildLiveDiffManifest(t, auditExternalLog)
	if m.AuditLog == nil || m.AuditLog.Operation.Table != "core.operation" || m.AuditLog.Change.Table != "core.operation_change" {
		t.Fatalf("audit log = %+v", m.AuditLog)
	}
	for _, dialect := range []string{"mysql", "postgres", "sqlite"} {
		ddl, err := renderDDL(m, dialect)
		if err != nil || !strings.Contains(ddl, triggerQuote(dialect)("core.operation_change")) {
			t.Fatalf("%s DDL = %v\n%s", dialect, err, ddl)
		}
	}
	got := triggerDirectives([]string{"BEGIN\n" + auditLogMarker(m.AuditLog) + "\n-- orm:audit table=member_account mode=changes\nEND"}, map[string]bool{"member_account": true})
	if len(got) != 2 || !strings.HasPrefix(got[0], "%% orm:audit_log operation=core.operation(") {
		t.Fatalf("directives = %q", got)
	}
}

func TestSplitSQLKeepsTriggerBodies(t *testing.T) {
	m := buildLiveDiffManifest(t, auditBase)
	for _, dialect := range []string{"mysql", "sqlite"} {
		text, err := renderDDL(m, dialect)
		if err != nil {
			t.Fatal(err)
		}
		creates := 0
		for _, statement := range splitSQL(text) {
			if strings.HasPrefix(statement, "CREATE TRIGGER") {
				creates++
				if !strings.HasSuffix(statement, "END") {
					t.Fatalf("%s trigger statement was cut:\n%s", dialect, statement)
				}
			}
		}
		if creates != 6 {
			t.Fatalf("%s: %d trigger statements, want 6", dialect, creates)
		}
	}
	statements := splitSQL("CREATE TRIGGER t AFTER INSERT ON x FOR EACH ROW BEGIN\n  IF a THEN SET b = CASE WHEN c THEN 1 ELSE 2 END; END IF;\n  SET d = 1;\nEND;\nSELECT 1;")
	if len(statements) != 2 || !strings.HasSuffix(statements[0], "END") {
		t.Fatalf("statements = %q", statements)
	}
}

func TestAuditDiff(t *testing.T) {
	base := buildLiveDiffManifest(t, auditBase)
	column := buildLiveDiffManifest(t, auditWithColumn)
	removed := buildLiveDiffManifest(t, auditWithoutItem)
	for _, dialect := range []string{"mysql", "postgres", "sqlite"} {
		same, err := renderDiff(base, base, dialect, false)
		if err != nil || !strings.Contains(same, "-- no changes") {
			t.Fatalf("%s unchanged diff = %v\n%s", dialect, err, same)
		}
		added, err := renderDiff(base, column, dialect, false)
		if err != nil {
			t.Fatal(err)
		}
		replaced := strings.Contains(added, "DROP TRIGGER IF EXISTS "+triggerQuote(dialect)(triggerName("audit_item", "audit_insert", dialect)))
		if dialect == "postgres" {
			if strings.Contains(added, "TRIGGER") {
				t.Fatalf("postgres replaced a column-independent audit trigger:\n%s", added)
			}
		} else if !replaced || strings.Index(added, "DROP TRIGGER") > strings.Index(added, "ADD COLUMN") || strings.LastIndex(added, "CREATE TRIGGER") < strings.Index(added, "ADD COLUMN") {
			t.Fatalf("%s did not replace the audit triggers around the column change:\n%s", dialect, added)
		}
		if strings.Contains(added, "audit_note_audit") {
			t.Fatalf("%s replaced an unchanged audit:\n%s", dialect, added)
		}
		dropped, err := renderDiff(column, removed, dialect, false)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(dropped, "DROP TRIGGER") || strings.Contains(dropped, "CREATE TRIGGER") {
			t.Fatalf("%s audit removal:\n%s", dialect, dropped)
		}
	}
	rebuilt, err := renderDiff(base, buildLiveDiffManifest(t, auditNullableTitle), "sqlite", true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Index(rebuilt, "DROP TRIGGER") > strings.Index(rebuilt, "orm-sqlite-rebuild") || strings.LastIndex(rebuilt, "CREATE TRIGGER \"audit_item_audit") < strings.Index(rebuilt, "RENAME TO") {
		t.Fatalf("sqlite rebuild does not recreate the audit triggers:\n%s", rebuilt)
	}
}

func TestTriggerDirectives(t *testing.T) {
	bodies := []string{
		"BEGIN\n-- orm:audit_log operation=op(seq, uuid) context=a.b change=ch(a, b, c, d, e, f, g)\n-- orm:audit table=item mode=changes site=s redact=p.q\nEND",
		"BEGIN\n-- orm:audit_log operation=op(seq, uuid) context=a.b change=ch(a, b, c, d, e, f, g)\n-- orm:audit table=gone mode=operations\nEND",
		"BEGIN\n-- orm:immutable table=item\nEND",
	}
	got := triggerDirectives(bodies, map[string]bool{"op": true, "ch": true, "item": true})
	want := []string{
		"%% orm:immutable entity=item",
		"%% orm:audit_log operation=op(seq, uuid) context=a.b change=ch(a, b, c, d, e, f, g)",
		"%% orm:audit entity=item mode=changes site=s redact=p.q",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("directives = %q", got)
	}
}

func TestSQLiteAudit(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "audit.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	assertAuditCycle(t, context.Background(), db, "sqlite")
}

// assertAuditCycle installs the audit schema, checks the trigger behavior,
// adds a column, and removes one audit, comparing the live schema each time.
func assertAuditCycle(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	dropAuditTables(t, ctx, db, driver)
	defer dropAuditTables(t, ctx, db, driver)
	base := buildLiveDiffManifest(t, auditBase)
	create, err := renderCreateDDL(base, driver)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, create); err != nil {
		t.Fatal(err)
	}
	assertAuditLive(t, ctx, db, driver, base)
	assertAuditWrites(t, ctx, db, driver, false)

	column := buildLiveDiffManifest(t, auditWithColumn)
	migrateAudit(t, ctx, db, driver, column)
	assertAuditWrites(t, ctx, db, driver, true)

	removed := buildLiveDiffManifest(t, auditWithoutItem)
	migrateAudit(t, ctx, db, driver, removed)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "INSERT INTO audit_item (site_ref, title) VALUES ('s', 'free')"); err != nil {
		t.Fatalf("insert after the audit was removed: %v", err)
	}
}

func migrateAudit(t *testing.T, ctx context.Context, db *sql.DB, driver string, want *schema.Manifest) {
	t.Helper()
	live := auditLive(t, db, driver)
	text, err := renderDiff(live, want, driver, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := executeMigration(ctx, db, driver, text); err != nil {
		t.Fatal(err)
	}
	assertAuditLive(t, ctx, db, driver, want)
}

func assertAuditLive(t *testing.T, ctx context.Context, db *sql.DB, driver string, want *schema.Manifest) {
	t.Helper()
	live := auditLive(t, db, driver)
	if !schemaMatches(want, live, driver) {
		t.Fatalf("%s live schema differs: %s; triggers equal=%v", driver, manifestMismatch(want, live, driver), sameTriggers(want, live))
	}
	again, err := renderDiff(live, want, driver, false)
	if err != nil || !strings.Contains(again, "-- no changes") {
		t.Fatalf("%s repeated diff = %v\n%s", driver, err, strings.Join(slices.DeleteFunc(strings.Split(again, "\n"), func(l string) bool { return strings.HasPrefix(l, "-- orm-schema") }), "\n"))
	}
}

// auditLive returns the live manifest restricted to the audit tables.
func auditLive(t *testing.T, db *sql.DB, driver string) *schema.Manifest {
	t.Helper()
	all, err := liveManifest(db, driver)
	if err != nil {
		t.Fatal(err)
	}
	live := &schema.Manifest{SchemaHash: all.SchemaHash, Entities: map[string]*schema.Entity{}, AuditLog: all.AuditLog}
	for _, name := range all.Order {
		if slices.Contains(auditTables, name) {
			live.Order = append(live.Order, name)
			live.Entities[name] = all.Entities[name]
		}
	}
	for _, a := range all.Audits {
		if slices.Contains(auditTables, a.Entity) {
			live.Audits = append(live.Audits, a)
		}
	}
	return live
}

func assertAuditWrites(t *testing.T, ctx context.Context, db *sql.DB, driver string, ranked bool) {
	t.Helper()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if driver == "mysql" {
		execAudit(t, ctx, tx, "SET @`orm.app.operation_id` = NULL")
	}
	expectAuditError(t, ctx, tx, driver, "INSERT INTO audit_item (site_ref, title) VALUES ('s1', 'a')", "audit operation context is required")
	setAuditContext(t, ctx, tx, driver, "op-missing")
	expectAuditError(t, ctx, tx, driver, "INSERT INTO audit_note (body) VALUES ('n')", "audit operation does not exist")
	uuid := "op-1"
	if ranked {
		uuid = "op-2"
	}
	execAudit(t, ctx, tx, "INSERT INTO audit_operation (operation_uuid) VALUES ('"+uuid+"')")
	setAuditContext(t, ctx, tx, driver, uuid)
	var operation int64
	if err := tx.QueryRowContext(ctx, "SELECT seq FROM audit_operation WHERE operation_uuid = '"+uuid+"'").Scan(&operation); err != nil {
		t.Fatalf("operation seq: %v", err)
	}
	execAudit(t, ctx, tx, "INSERT INTO audit_note (body) VALUES ('n')")
	execAudit(t, ctx, tx, `INSERT INTO audit_item (site_ref, title, payload) VALUES ('s1', 'a', '{"token":"t","card":{"number":"4111","brand":"v"},"k":1}')`)
	var item int64
	if err := tx.QueryRowContext(ctx, "SELECT max(seq) FROM audit_item").Scan(&item); err != nil {
		t.Fatalf("item seq: %v", err)
	}
	id := itoa(item)
	execAudit(t, ctx, tx, `UPDATE audit_item SET title = 'b', payload = '{"token":"u","card":{"number":"4111","brand":"v"},"k":1}' WHERE seq = `+id)
	execAudit(t, ctx, tx, `UPDATE audit_item SET title = 'b' WHERE seq = `+id)
	execAudit(t, ctx, tx, `DELETE FROM audit_item WHERE seq = `+id)
	query := "SELECT operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value FROM audit_change WHERE operation_seq = ? ORDER BY seq"
	if driver == "postgres" {
		query = "SELECT operation_seq, change_kind, site_ref, table_label, entity_ref::text, before_value::text, after_value::text FROM audit_change WHERE operation_seq = $1 ORDER BY seq"
	}
	rows, err := tx.QueryContext(ctx, query, operation)
	if err != nil {
		t.Fatalf("change rows: %v", err)
	}
	defer rows.Close()
	redacted := map[string]any{"redacted": true, "present": true}
	payload := map[string]any{"token": redacted, "card": map[string]any{"number": redacted, "brand": "v"}, "k": float64(1)}
	full := func(title string) map[string]any {
		row := map[string]any{"seq": float64(item), "site_ref": "s1", "title": title, "payload": payload}
		if ranked {
			row["rank"] = float64(0)
		}
		return row
	}
	want := [][]any{
		{"INSERT", map[string]any{}, full("a")},
		{"UPDATE", map[string]any{"title": "a", "payload": payload}, map[string]any{"title": "b", "payload": payload}},
		{"DELETE", full("b"), map[string]any{}},
	}
	var got [][]any
	for rows.Next() {
		var seq int64
		var kind, site, table, key, before, after string
		if err := rows.Scan(&seq, &kind, &site, &table, &key, &before, &after); err != nil {
			t.Fatal(err)
		}
		if seq != operation || site != "s1" || table != "audit_item" || !jsonEqual(t, key, map[string]any{"seq": float64(item)}) {
			t.Fatalf("%s change row: seq=%d site=%s table=%s key=%s", driver, seq, site, table, key)
		}
		got = append(got, []any{kind, decodeJSON(t, before), decodeJSON(t, after)})
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s change rows:\n got %v\nwant %v", driver, got, want)
	}
}

func execAudit(t *testing.T, ctx context.Context, tx *sql.Tx, statement string) {
	t.Helper()
	if _, err := tx.ExecContext(ctx, statement); err != nil {
		t.Fatalf("%s: %v", statement, err)
	}
}

func itoa(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// expectAuditError runs a statement that a trigger rejects inside a savepoint,
// so the transaction continues.
func expectAuditError(t *testing.T, ctx context.Context, tx *sql.Tx, driver, statement, message string) {
	t.Helper()
	if driver == "postgres" {
		execAudit(t, ctx, tx, "SAVEPOINT audit_check")
	}
	_, err := tx.ExecContext(ctx, statement)
	if err == nil || !strings.Contains(err.Error(), message) {
		t.Fatalf("%s: err = %v, want %q", statement, err, message)
	}
	if driver == "postgres" {
		execAudit(t, ctx, tx, "ROLLBACK TO SAVEPOINT audit_check")
	}
}

func setAuditContext(t *testing.T, ctx context.Context, tx *sql.Tx, driver, value string) {
	t.Helper()
	var err error
	switch driver {
	case "postgres":
		_, err = tx.ExecContext(ctx, "SELECT set_config('app.operation_id', $1, true)", value)
		if err != nil {
			t.Fatalf("set_config: %v", err)
		}
	case "mysql":
		_, err = tx.ExecContext(ctx, "SET @`orm.app.operation_id` = ?", value)
	default:
		_, err = tx.ExecContext(ctx, `INSERT INTO "orm__context" ("key", "value") VALUES ('app.operation_id', ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`, value)
	}
	if err != nil {
		t.Fatal(err)
	}
}

func decodeJSON(t *testing.T, text string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		t.Fatalf("%q: %v", text, err)
	}
	return v
}

func jsonEqual(t *testing.T, text string, want any) bool {
	return reflect.DeepEqual(decodeJSON(t, text), want)
}

func dropAuditTables(t *testing.T, ctx context.Context, db *sql.DB, driver string) {
	t.Helper()
	statements := []string{}
	for i := len(auditTables) - 1; i >= 0; i-- {
		statements = append(statements, "DROP TABLE IF EXISTS "+auditTables[i])
	}
	if driver == "postgres" {
		for _, table := range auditTables {
			statements = append(statements, "DROP FUNCTION IF EXISTS "+table+"_audit()")
		}
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
}

// TestAuditRejectsRedactionThatCannotApply checks the redaction declarations a
// schema cannot carry out: an unknown column, a key column that identifies the
// row, and a path into a column that holds no JSON.
func TestAuditRejectsRedactionThatCannotApply(t *testing.T) {
	for _, c := range []struct{ name, redact, want string }{
		{"unknown column", "missing", "unknown column audit_item.missing"},
		{"key column", "seq", "is a key column"},
		{"path into a plain column", "title.token", "holds no JSON"},
	} {
		t.Run(c.name, func(t *testing.T) {
			source := auditHead + auditLogLine +
				"  %% orm:audit entity=audit_item mode=changes site=site_ref redact=" + c.redact + "\n" +
				auditNoteLine
			d, err := schema.Parse(source)
			if err != nil {
				t.Fatal(err)
			}
			_, err = schema.Build(d)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("build error = %v, want one naming %q", err, c.want)
			}
		})
	}
}
