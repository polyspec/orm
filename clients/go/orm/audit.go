package orm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/polyspec/orm/engine/ir"
)

// AuditMode selects whether an audited mutation records row values or only
// requires an operation context.
type AuditMode string

const (
	AuditChanges    AuditMode = "changes"
	AuditOperations AuditMode = "operations"
)

// AuditSpec declares the database-independent audit relationship for one
// table. The adapter owns the trigger implementation; callers provide names
// because the ORM does not know an application's audit schema.
type AuditSpec struct {
	Table                    string
	Mode                     AuditMode
	SiteColumn               string
	EntityKeyColumns         []string
	RedactedPaths            [][]string
	OperationTable           string
	OperationSeqColumn       string
	OperationUUIDColumn      string
	OperationContextKey      string
	ChangeTable              string
	ChangeOperationSeqColumn string
	ChangeOperationColumn    string
	ChangeSiteColumn         string
	ChangeTableColumn        string
	ChangeEntityKeyColumn    string
	ChangeOldValueColumn     string
	ChangeNewValueColumn     string
}

// InstallAudit installs the adapter-owned audit trigger for one table in the
// caller-owned transaction. PostgreSQL uses transaction-local settings;
// SQLite uses a transaction-local context table because it has no session
// settings. Other adapters return an explicit capability error.
func (t *Tx) InstallAudit(ctx context.Context, spec AuditSpec) error {
	if t == nil || t.finished.Load() {
		return configAuditError("transaction already finished")
	}
	if t.d == nil || t.d.driver != "postgres" {
		if t.d != nil && t.d.driver == "sqlite" {
			return t.installAuditSQLite(ctx, spec)
		}
		return &ir.Error{Code: CodeCapabilityUnsupported, Msg: "audit triggers are supported only by postgres and sqlite"}
	}
	if err := validateAuditSpec(spec); err != nil {
		return err
	}
	tableSchema, tableName := strings.Split(spec.Table, ".")[0], strings.Split(spec.Table, ".")[1]
	if len(spec.EntityKeyColumns) == 0 {
		keys, err := t.auditPrimaryKeyColumns(ctx, tableSchema, tableName)
		if err != nil {
			return err
		}
		spec.EntityKeyColumns = keys
	}
	if len(spec.EntityKeyColumns) == 0 {
		return configAuditError("audited table must have a primary key")
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("%#v", spec)))
	name := "orm_audit_" + hex.EncodeToString(digest[:])[:20]
	fn := quoteIdentifier(t.d.driver, tableSchema) + "." + quoteIdentifier(t.d.driver, name)
	table := quoteIdentifier(t.d.driver, tableSchema) + "." + quoteIdentifier(t.d.driver, tableName)
	trigger := quoteIdentifier(t.d.driver, name)
	truncateTrigger := quoteIdentifier(t.d.driver, name+"_truncate")
	body := auditFunctionBody(spec)
	statements := []string{
		"CREATE OR REPLACE FUNCTION " + fn + "() RETURNS trigger LANGUAGE plpgsql AS $$\n" + body + "\n$$",
		"DROP TRIGGER IF EXISTS " + trigger + " ON " + table,
		"CREATE TRIGGER " + trigger + " BEFORE INSERT OR UPDATE OR DELETE ON " + table + " FOR EACH ROW EXECUTE FUNCTION " + fn + "()",
		"DROP TRIGGER IF EXISTS " + truncateTrigger + " ON " + table,
		"CREATE TRIGGER " + truncateTrigger + " BEFORE TRUNCATE ON " + table + " FOR EACH STATEMENT EXECUTE FUNCTION " + fn + "()",
	}
	for _, statement := range statements {
		if _, err := t.tx.ExecContext(ctx, statement); err != nil {
			return mapDriverErr(err)
		}
	}
	return nil
}

func (t *Tx) installAuditSQLite(ctx context.Context, spec AuditSpec) error {
	if err := validateAuditSpec(spec); err != nil {
		return err
	}
	_, tableName := splitAuditIdentifierMust(spec.Table)
	_, operationName := splitAuditIdentifierMust(spec.OperationTable)
	_, changeName := splitAuditIdentifierMust(spec.ChangeTable)
	columns, keys, err := t.auditSQLiteColumns(ctx, tableName)
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return configAuditError("audited table must have a primary key")
	}
	if len(spec.EntityKeyColumns) == 0 {
		spec.EntityKeyColumns = keys
	}
	for _, key := range append(append([]string{}, spec.EntityKeyColumns...), spec.SiteColumn) {
		if key != "" && !containsString(columns, key) {
			return configAuditError("audit column does not exist")
		}
	}
	if _, err := t.tx.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS orm_audit_context (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); err != nil {
		return mapDriverErr(err)
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("sqlite:%#v", spec)))
	triggerName := "orm_audit_" + hex.EncodeToString(digest[:])[:20]
	for _, event := range []string{"INSERT", "UPDATE", "DELETE"} {
		body := sqliteAuditTrigger(spec, event, tableName, operationName, changeName, columns, triggerName)
		if _, err := t.tx.ExecContext(ctx, "DROP TRIGGER IF EXISTS "+quoteIdentifier("sqlite", triggerName+"_"+strings.ToLower(event))); err != nil {
			return mapDriverErr(err)
		}
		if _, err := t.tx.ExecContext(ctx, body); err != nil {
			return mapDriverErr(err)
		}
	}
	t.auditContext = true
	return nil
}

func sqliteAuditTrigger(spec AuditSpec, event, tableName, operationName, changeName string, columns []string, triggerName string) string {
	table := quoteIdentifier("sqlite", tableName)
	trigger := quoteIdentifier("sqlite", triggerName+"_"+strings.ToLower(event))
	contextValue := "(SELECT value FROM orm_audit_context WHERE key=" + quoteLiteral(spec.OperationContextKey) + ")"
	operationSeq := "(SELECT " + quoteIdentifier("sqlite", spec.OperationSeqColumn) + " FROM " + quoteIdentifier("sqlite", operationName) + " WHERE " + quoteIdentifier("sqlite", spec.OperationUUIDColumn) + "=" + contextValue + ")"
	newValue, oldValue := "'{}'", "'{}'"
	if event == "INSERT" || event == "UPDATE" {
		newValue = sqliteJSONExpr("NEW", columns)
	}
	if event == "UPDATE" || event == "DELETE" {
		oldValue = sqliteJSONExpr("OLD", columns)
	}
	newValue, oldValue = sqliteRedactExpr(newValue, oldValue, spec.RedactedPaths)
	if event == "UPDATE" {
		newValue, oldValue = sqliteChangedExpr(newValue, oldValue, columns)
	}
	keyPrefix := "OLD"
	if event != "DELETE" {
		keyPrefix = "NEW"
	}
	keyExpr := sqliteEntityKeyExpr(event, keyPrefix, spec.EntityKeyColumns)
	siteExpr := "NULL"
	if spec.SiteColumn != "" {
		if event == "INSERT" {
			siteExpr = "NEW." + quoteIdentifier("sqlite", spec.SiteColumn)
		} else if event == "DELETE" {
			siteExpr = "OLD." + quoteIdentifier("sqlite", spec.SiteColumn)
		} else {
			siteExpr = "COALESCE(NEW." + quoteIdentifier("sqlite", spec.SiteColumn) + ",OLD." + quoteIdentifier("sqlite", spec.SiteColumn) + ")"
		}
	}
	var body strings.Builder
	body.WriteString("CREATE TRIGGER ")
	body.WriteString(trigger)
	body.WriteString(" BEFORE ")
	body.WriteString(event)
	body.WriteString(" ON ")
	body.WriteString(table)
	body.WriteString(" FOR EACH ROW BEGIN\nSELECT RAISE(ABORT,'audit operation context is required') WHERE COALESCE(")
	body.WriteString(contextValue)
	body.WriteString(",'')='';\nSELECT RAISE(ABORT,'audit operation does not exist') WHERE ")
	body.WriteString(operationSeq)
	body.WriteString(" IS NULL;\n")
	if spec.Mode == AuditChanges {
		q := func(value string) string { return quoteIdentifier("sqlite", value) }
		body.WriteString("INSERT INTO ")
		body.WriteString(q(changeName))
		body.WriteString(" (")
		body.WriteString(strings.Join([]string{q(spec.ChangeOperationSeqColumn), q(spec.ChangeSiteColumn), q(spec.ChangeTableColumn), q(spec.ChangeEntityKeyColumn), q(spec.ChangeOperationColumn), q(spec.ChangeOldValueColumn), q(spec.ChangeNewValueColumn)}, ","))
		body.WriteString(") VALUES (")
		body.WriteString(strings.Join([]string{operationSeq, siteExpr, quoteLiteral(tableName), keyExpr, quoteLiteral(event), oldValue, newValue}, ","))
		body.WriteString(");\n")
	}
	body.WriteString("END")
	return body.String()
}

func (t *Tx) auditSQLiteColumns(ctx context.Context, table string) ([]string, []string, error) {
	rows, err := t.tx.QueryContext(ctx, "PRAGMA table_info("+quoteIdentifier("sqlite", table)+")")
	if err != nil {
		return nil, nil, mapDriverErr(err)
	}
	defer rows.Close()
	columns, keys := []string{}, []string{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, primary int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &primary); err != nil {
			return nil, nil, mapDriverErr(err)
		}
		columns = append(columns, name)
		if primary > 0 {
			keys = append(keys, name)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, mapDriverErr(err)
	}
	return columns, keys, nil
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func sqliteJSONExpr(prefix string, columns []string) string {
	args := make([]string, 0, len(columns)*2)
	for _, column := range columns {
		args = append(args, quoteLiteral(column), prefix+"."+quoteIdentifier("sqlite", column))
	}
	return "json_object(" + strings.Join(args, ",") + ")"
}

func sqliteRedactExpr(newValue, oldValue string, paths [][]string) (string, string) {
	for _, path := range paths {
		segments := make([]string, len(path))
		for i, segment := range path {
			segments[i] = `."` + strings.ReplaceAll(segment, `"`, `""`) + `"`
		}
		jsonPath := "$" + strings.Join(segments, "")
		newValue = "json_set(" + newValue + "," + quoteLiteral(jsonPath) + ",json_object('redacted',1,'present',json_type(" + newValue + "," + quoteLiteral(jsonPath) + ") IS NOT NULL))"
		oldValue = "json_set(" + oldValue + "," + quoteLiteral(jsonPath) + ",json_object('redacted',1,'present',json_type(" + oldValue + "," + quoteLiteral(jsonPath) + ") IS NOT NULL))"
	}
	return newValue, oldValue
}

func sqliteChangedExpr(newValue, oldValue string, columns []string) (string, string) {
	newArgs, oldArgs := []string{}, []string{}
	for _, column := range columns {
		path := quoteLiteral("$." + column)
		newArgs = append(newArgs, "CASE WHEN NEW."+quoteIdentifier("sqlite", column)+" IS OLD."+quoteIdentifier("sqlite", column)+" THEN "+path+" ELSE '$.__unchanged' END")
		oldArgs = append(oldArgs, "CASE WHEN NEW."+quoteIdentifier("sqlite", column)+" IS OLD."+quoteIdentifier("sqlite", column)+" THEN "+path+" ELSE '$.__unchanged' END")
	}
	return "json_remove(" + newValue + "," + strings.Join(newArgs, ",") + ")", "json_remove(" + oldValue + "," + strings.Join(oldArgs, ",") + ")"
}

func sqliteEntityKeyExpr(event, newPrefix string, keys []string) string {
	args := make([]string, 0, len(keys)*2)
	for _, key := range keys {
		value := newPrefix + "." + quoteIdentifier("sqlite", key)
		if event == "UPDATE" {
			value = "COALESCE(NEW." + quoteIdentifier("sqlite", key) + ",OLD." + quoteIdentifier("sqlite", key) + ")"
		}
		args = append(args, quoteLiteral(key), value)
	}
	return "json_object(" + strings.Join(args, ",") + ")"
}

func (t *Tx) auditPrimaryKeyColumns(ctx context.Context, schema, table string) ([]string, error) {
	rows, err := t.tx.QueryContext(ctx, `SELECT a.attname
FROM pg_index i
JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
JOIN pg_class c ON c.oid=i.indrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE i.indisprimary AND n.nspname=$1 AND c.relname=$2
ORDER BY array_position(i.indkey,a.attnum)`, schema, table)
	if err != nil {
		return nil, mapDriverErr(err)
	}
	defer rows.Close()
	keys := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, mapDriverErr(err)
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDriverErr(err)
	}
	return keys, nil
}

func validateAuditSpec(spec AuditSpec) error {
	if _, _, ok := splitAuditIdentifier(spec.Table); !ok || spec.Mode != AuditChanges && spec.Mode != AuditOperations {
		return configAuditError("valid audit table and mode are required")
	}
	for _, value := range []string{spec.OperationTable, spec.ChangeTable, spec.OperationSeqColumn, spec.OperationUUIDColumn, spec.OperationContextKey, spec.ChangeOperationSeqColumn, spec.ChangeOperationColumn, spec.ChangeSiteColumn, spec.ChangeTableColumn, spec.ChangeEntityKeyColumn, spec.ChangeOldValueColumn, spec.ChangeNewValueColumn} {
		if value == "" {
			return configAuditError("audit identifiers are required")
		}
	}
	if _, _, ok := splitAuditIdentifier(spec.OperationTable); !ok {
		return configAuditError("operation table must be qualified")
	}
	if _, _, ok := splitAuditIdentifier(spec.ChangeTable); !ok {
		return configAuditError("change table must be qualified")
	}
	for _, identifier := range append(append([]string{}, spec.EntityKeyColumns...), spec.SiteColumn) {
		if identifier != "" && !validAuditIdentifier(identifier) {
			return configAuditError("invalid audit column")
		}
	}
	for _, path := range spec.RedactedPaths {
		if len(path) == 0 {
			return configAuditError("redacted path must not be empty")
		}
		for _, segment := range path {
			if !validAuditIdentifier(segment) {
				return configAuditError("invalid redacted path")
			}
		}
	}
	return nil
}

func auditFunctionBody(spec AuditSpec) string {
	operationSchema, operationTable := splitAuditIdentifierMust(spec.OperationTable)
	changeSchema, changeTable := splitAuditIdentifierMust(spec.ChangeTable)
	operation := quoteIdentifier("postgres", operationSchema) + "." + quoteIdentifier("postgres", operationTable)
	change := quoteIdentifier("postgres", changeSchema) + "." + quoteIdentifier("postgres", changeTable)
	q := func(s string) string { return quoteIdentifier("postgres", s) }
	var b strings.Builder
	b.WriteString("DECLARE\n  operation_id text;\n  operation_seq bigint;\n  old_value jsonb := '{}'::jsonb;\n  new_value jsonb := '{}'::jsonb;\n  old_full jsonb := '{}'::jsonb;\n  new_full jsonb := '{}'::jsonb;\n  entity_key jsonb := '{}'::jsonb;\n  site_id text;\nBEGIN\n")
	b.WriteString("  operation_id := current_setting(")
	b.WriteString(quoteLiteral(spec.OperationContextKey))
	b.WriteString(", true);\n  IF operation_id IS NULL OR operation_id = '' THEN\n    RAISE EXCEPTION 'audit operation context is required';\n  END IF;\n")
	b.WriteString("  SELECT ")
	b.WriteString(q(spec.OperationSeqColumn))
	b.WriteString(" INTO operation_seq FROM ")
	b.WriteString(operation)
	b.WriteString(" WHERE ")
	b.WriteString(q(spec.OperationUUIDColumn))
	b.WriteString(" = operation_id;\n  IF operation_seq IS NULL THEN\n    RAISE EXCEPTION 'audit operation does not exist';\n  END IF;\n")
	b.WriteString("  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;\n")
	b.WriteString("  IF TG_OP = 'INSERT' THEN new_value := to_jsonb(NEW); ELSIF TG_OP = 'UPDATE' THEN old_value := to_jsonb(OLD); new_value := to_jsonb(NEW); ELSE old_value := to_jsonb(OLD); END IF;\n")
	if spec.SiteColumn != "" {
		b.WriteString("  site_id := COALESCE(new_value ->> ")
		b.WriteString(quoteLiteral(spec.SiteColumn))
		b.WriteString(", old_value ->> ")
		b.WriteString(quoteLiteral(spec.SiteColumn))
		b.WriteString(");\n")
	}
	for _, path := range spec.EntityKeyColumns {
		b.WriteString("  entity_key := jsonb_set(entity_key, ")
		b.WriteString(quotePath([]string{path}))
		b.WriteString(", to_jsonb(COALESCE(new_value #> ")
		b.WriteString(quotePath([]string{path}))
		b.WriteString(", old_value #> ")
		b.WriteString(quotePath([]string{path}))
		b.WriteString(")), true);\n")
	}
	if spec.Mode == AuditChanges {
		for _, path := range spec.RedactedPaths {
			b.WriteString("  new_value := jsonb_set(new_value, ")
			b.WriteString(quotePath(path))
			b.WriteString(", jsonb_build_object('redacted', true, 'present', (new_value #> ")
			b.WriteString(quotePath(path))
			b.WriteString(") IS NOT NULL), true);\n")
			b.WriteString("  old_value := jsonb_set(old_value, ")
			b.WriteString(quotePath(path))
			b.WriteString(", jsonb_build_object('redacted', true, 'present', (old_value #> ")
			b.WriteString(quotePath(path))
			b.WriteString(") IS NOT NULL), true);\n")
		}
		b.WriteString("  IF TG_OP = 'UPDATE' THEN\n    old_full := old_value;\n    new_full := new_value;\n    old_value := COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(old_full) WHERE new_full -> key IS DISTINCT FROM value), '{}'::jsonb);\n    new_value := COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(new_full) WHERE old_full -> key IS DISTINCT FROM value), '{}'::jsonb);\n  END IF;\n")
		b.WriteString("  INSERT INTO ")
		b.WriteString(change)
		b.WriteString(" (")
		b.WriteString(q(spec.ChangeOperationSeqColumn))
		b.WriteString(", ")
		b.WriteString(q(spec.ChangeSiteColumn))
		b.WriteString(", ")
		b.WriteString(q(spec.ChangeTableColumn))
		b.WriteString(", ")
		b.WriteString(q(spec.ChangeEntityKeyColumn))
		b.WriteString(", ")
		b.WriteString(q(spec.ChangeOperationColumn))
		b.WriteString(", ")
		b.WriteString(q(spec.ChangeOldValueColumn))
		b.WriteString(", ")
		b.WriteString(q(spec.ChangeNewValueColumn))
		b.WriteString(") VALUES (operation_seq, site_id, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, entity_key, TG_OP, old_value, new_value);\n")
	}
	b.WriteString("  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;\nEND")
	return b.String()
}

func splitAuditIdentifier(value string) (string, string, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 || !validAuditIdentifier(parts[0]) || !validAuditIdentifier(parts[1]) {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func splitAuditIdentifierMust(value string) (string, string) {
	a, b, ok := splitAuditIdentifier(value)
	if !ok {
		panic("invalid validated audit identifier")
	}
	return a, b
}

func validAuditIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for i, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' {
			return false
		}
		if i == 0 && r >= '0' && r <= '9' {
			return false
		}
	}
	return true
}

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func quotePath(path []string) string {
	parts := make([]string, len(path))
	for i, segment := range path {
		parts[i] = quoteLiteral(segment)
	}
	return "ARRAY[" + strings.Join(parts, ",") + "]"
}

func configAuditError(message string) error {
	return &ir.Error{Code: CodeConfig, Msg: fmt.Sprintf("audit: %s", message)}
}
