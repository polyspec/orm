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
// caller-owned transaction. PostgreSQL is the initial implementation; other
// adapters return an explicit capability error until they implement the same
// logical contract.
func (t *Tx) InstallAudit(ctx context.Context, spec AuditSpec) error {
	if t == nil || t.finished.Load() {
		return configAuditError("transaction already finished")
	}
	if t.d == nil || t.d.driver != "postgres" {
		return &ir.Error{Code: CodeCapabilityUnsupported, Msg: "audit triggers are supported only by postgres"}
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
	body := auditFunctionBody(spec)
	statements := []string{
		"CREATE OR REPLACE FUNCTION " + fn + "() RETURNS trigger LANGUAGE plpgsql AS $$\n" + body + "\n$$",
		"DROP TRIGGER IF EXISTS " + trigger + " ON " + table,
		"CREATE TRIGGER " + trigger + " BEFORE INSERT OR UPDATE OR DELETE ON " + table + " FOR EACH ROW EXECUTE FUNCTION " + fn + "()",
	}
	for _, statement := range statements {
		if _, err := t.tx.ExecContext(ctx, statement); err != nil {
			return mapDriverErr(err)
		}
	}
	return nil
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
