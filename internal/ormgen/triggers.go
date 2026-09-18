package ormgen

import (
	"database/sql"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

// A triggerObject is one table's set of ORM-owned triggers (audit or
// immutable guard). DDL creates it after the tables; diff replaces it when its
// rendered form changes and drops it before any table change.
type triggerObject struct {
	table  string
	kind   string
	drop   []string
	create []string
}

func (o triggerObject) key() string { return o.table + "\x00" + o.kind }

func (o triggerObject) text() string { return strings.Join(o.create, "\n") }

// triggerMarker is the comment line each trigger body carries, so import can
// rebuild the directive from a live database.
const triggerMarker = "-- orm:"

func auditLogMarker(l *schema.AuditLog) string {
	return fmt.Sprintf("%saudit_log operation=%s(%s) context=%s change=%s(%s)", triggerMarker, l.Operation.Table, strings.Join(l.Operation.Columns, ", "), l.Context, l.Change.Table, strings.Join(l.Change.Columns, ", "))
}

func auditMarker(table string, a *schema.Audit) string {
	s := triggerMarker + "audit table=" + table + " mode=" + a.Mode
	if a.Site != "" {
		s += " site=" + a.Site
	}
	if len(a.Redact) > 0 {
		paths := make([]string, len(a.Redact))
		for i, path := range a.Redact {
			paths[i] = strings.Join(path, ".")
		}
		s += " redact=" + strings.Join(paths, ",")
	}
	return s
}

func triggerQuote(dialect string) func(string) string {
	if dialect == "mysql" {
		return func(s string) string { return quoteQualified("`", s) }
	}
	return func(s string) string { return quoteQualified(`"`, ddlTable(s, dialect)) }
}

func sqlLiteral(s string) string { return "'" + sqlQuote(s) + "'" }

// triggerName places a trigger name next to its table: PostgreSQL and MySQL
// keep triggers in the table's schema, SQLite uses the physical table name.
func triggerName(table, suffix, dialect string) string {
	if dialect == "sqlite" {
		return ddlTable(table, dialect) + "_" + suffix
	}
	return table + "_" + suffix
}

func triggerObjects(m *schema.Manifest, dialect string) ([]triggerObject, error) {
	immutable := map[string]bool{}
	for _, name := range m.Immutable {
		immutable[name] = true
	}
	var out []triggerObject
	for _, name := range m.Order {
		e := m.Entities[name]
		if a := m.AuditEntity(name); a != nil {
			o, err := auditObject(m, e, a, dialect)
			if err != nil {
				return nil, err
			}
			out = append(out, o)
		}
		if immutable[name] {
			o, err := immutableObject(e, dialect)
			if err != nil {
				return nil, err
			}
			out = append(out, o)
		}
	}
	return out, nil
}

func immutableObject(e *schema.Entity, dialect string) (triggerObject, error) {
	q := triggerQuote(dialect)
	o := triggerObject{table: e.Table, kind: "immutable"}
	marker := triggerMarker + "immutable table=" + e.Table
	message := sqlLiteral("immutable table: " + e.Table)
	switch dialect {
	case "postgres":
		function := q(e.Table + "_immutable_reject")
		trigger := `"` + ddlBase(e.Table) + `_immutable"`
		o.drop = []string{
			"DROP TRIGGER IF EXISTS " + trigger + " ON " + q(e.Table) + ";",
			"DROP FUNCTION IF EXISTS " + function + "();",
		}
		o.create = []string{
			"CREATE OR REPLACE FUNCTION " + function + "() RETURNS trigger LANGUAGE plpgsql AS $$\n" + marker + "\nBEGIN RAISE EXCEPTION " + message + "; END;\n$$;",
			"DROP TRIGGER IF EXISTS " + trigger + " ON " + q(e.Table) + ";",
			"CREATE TRIGGER " + trigger + " BEFORE UPDATE OR DELETE OR TRUNCATE ON " + q(e.Table) + " FOR EACH STATEMENT EXECUTE FUNCTION " + function + "();",
		}
	case "sqlite":
		for _, event := range []string{"update", "delete"} {
			trigger := q(triggerName(e.Table, "immutable_"+event, dialect))
			o.drop = append(o.drop, "DROP TRIGGER IF EXISTS "+trigger+";")
			o.create = append(o.create,
				"DROP TRIGGER IF EXISTS "+trigger+";",
				"CREATE TRIGGER "+trigger+" BEFORE "+strings.ToUpper(event)+" ON "+q(e.Table)+" FOR EACH ROW BEGIN\n"+marker+"\nSELECT RAISE(ABORT, "+message+");\nEND;")
		}
	case "mysql":
		// MySQL has no TRUNCATE trigger; the guards cover UPDATE and DELETE.
		for _, event := range []string{"update", "delete"} {
			trigger := q(triggerName(e.Table, "immutable_"+event, dialect))
			o.drop = append(o.drop, "DROP TRIGGER IF EXISTS "+trigger+";")
			o.create = append(o.create,
				"DROP TRIGGER IF EXISTS "+trigger+";",
				"CREATE TRIGGER "+trigger+" BEFORE "+strings.ToUpper(event)+" ON "+q(e.Table)+" FOR EACH ROW\nBEGIN\n"+marker+"\n  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = "+message+";\nEND;")
		}
	default:
		return o, fmt.Errorf("unknown dialect %q", dialect)
	}
	return o, nil
}

func auditObject(m *schema.Manifest, e *schema.Entity, a *schema.Audit, dialect string) (triggerObject, error) {
	l := m.AuditLog
	markers := auditLogMarker(l) + "\n" + auditMarker(e.Table, a)
	switch dialect {
	case "postgres":
		return postgresAudit(m, e, a, markers), nil
	case "mysql":
		return mysqlAudit(m, e, a, markers), nil
	case "sqlite":
		return sqliteAudit(m, e, a, markers), nil
	}
	return triggerObject{}, fmt.Errorf("unknown dialect %q", dialect)
}

const (
	auditContextMessage   = "'audit operation context is required'"
	auditOperationMessage = "'audit operation does not exist'"
)

func auditChangeColumns(l *schema.AuditLog, q func(string) string) string {
	columns := make([]string, len(l.Change.Columns))
	for i, c := range l.Change.Columns {
		columns[i] = q(c)
	}
	return strings.Join(columns, ", ")
}

func postgresAudit(m *schema.Manifest, e *schema.Entity, a *schema.Audit, markers string) triggerObject {
	q := triggerQuote("postgres")
	l := m.AuditLog
	function := q(e.Table + "_audit")
	trigger := `"` + ddlBase(e.Table) + `_audit"`
	truncate := `"` + ddlBase(e.Table) + `_audit_truncate"`
	var b strings.Builder
	b.WriteString("CREATE OR REPLACE FUNCTION " + function + "() RETURNS trigger LANGUAGE plpgsql AS $$\n")
	b.WriteString(markers + "\n")
	b.WriteString("DECLARE\n  audit_operation_id text := current_setting(" + sqlLiteral(l.Context) + ", true);\n  audit_operation_seq bigint;\n")
	if a.Mode == "changes" {
		b.WriteString("  audit_old jsonb := '{}'::jsonb;\n  audit_new jsonb := '{}'::jsonb;\n  audit_site text;\n  audit_key jsonb;\n")
	}
	b.WriteString("BEGIN\n")
	b.WriteString("  IF audit_operation_id IS NULL OR audit_operation_id = '' THEN RAISE EXCEPTION " + auditContextMessage + "; END IF;\n")
	b.WriteString("  SELECT " + q(l.Operation.Columns[schema.AuditOperationSeq]) + " INTO audit_operation_seq FROM " + q(l.Operation.Table) + " WHERE " + q(l.Operation.Columns[schema.AuditOperationUUID]) + "::text = audit_operation_id;\n")
	b.WriteString("  IF audit_operation_seq IS NULL THEN RAISE EXCEPTION " + auditOperationMessage + "; END IF;\n")
	if a.Mode == "changes" {
		b.WriteString("  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;\n")
		// An insert and a delete record every column. An update compares each
		// column's stored bytes and records only the changed columns, so an
		// unchanged large value is neither parsed nor compared under a
		// collation.
		b.WriteString("  IF TG_OP = 'INSERT' THEN\n")
		b.WriteString("    audit_new := " + postgresRowObject(e, "NEW", q) + ";\n")
		b.WriteString("  ELSIF TG_OP = 'DELETE' THEN\n")
		b.WriteString("    audit_old := " + postgresRowObject(e, "OLD", q) + ";\n")
		b.WriteString("  ELSE\n")
		for _, c := range auditColumns(e) {
			name := sqlLiteral(c.Name)
			b.WriteString("    IF OLD." + q(c.Name) + "::text IS DISTINCT FROM NEW." + q(c.Name) + "::text THEN\n")
			b.WriteString("      audit_old := audit_old || jsonb_build_object(" + name + ", " + postgresAuditValue(c, "OLD."+q(c.Name)) + ");\n")
			b.WriteString("      audit_new := audit_new || jsonb_build_object(" + name + ", " + postgresAuditValue(c, "NEW."+q(c.Name)) + ");\n")
			b.WriteString("    END IF;\n")
		}
		b.WriteString("    IF audit_old::text = '{}' AND audit_new::text = '{}' THEN RETURN NULL; END IF;\n")
		b.WriteString("  END IF;\n")
		if a.Site != "" {
			b.WriteString("  audit_site := CASE TG_OP WHEN 'DELETE' THEN OLD." + q(a.Site) + "::text ELSE NEW." + q(a.Site) + "::text END;\n")
		}
		keys := make([]string, 0, len(e.PK)*2)
		for _, k := range e.PK {
			keys = append(keys, sqlLiteral(k), "to_jsonb(CASE TG_OP WHEN 'DELETE' THEN OLD."+q(k)+" ELSE NEW."+q(k)+" END)")
		}
		b.WriteString("  audit_key := jsonb_build_object(" + strings.Join(keys, ", ") + ");\n")
		for _, path := range a.Redact {
			p := sqlLiteral("{" + strings.Join(path, ",") + "}")
			for _, v := range []string{"audit_new", "audit_old"} {
				b.WriteString("  IF " + v + " #> " + p + " IS NOT NULL THEN " + v + " := jsonb_set(" + v + ", " + p + ", '{\"redacted\": true, \"present\": true}'::jsonb); END IF;\n")
			}
		}
		b.WriteString("  INSERT INTO " + q(l.Change.Table) + " (" + auditChangeColumns(l, q) + ") VALUES (audit_operation_seq, TG_OP, audit_site, " + sqlLiteral(e.Table) + ", audit_key, audit_old, audit_new);\n")
	}
	b.WriteString("  RETURN NULL;\nEND\n$$;")
	o := triggerObject{table: e.Table, kind: "audit"}
	o.drop = []string{
		"DROP TRIGGER IF EXISTS " + trigger + " ON " + q(e.Table) + ";",
		"DROP TRIGGER IF EXISTS " + truncate + " ON " + q(e.Table) + ";",
		"DROP FUNCTION IF EXISTS " + function + "();",
	}
	o.create = []string{
		b.String(),
		"DROP TRIGGER IF EXISTS " + trigger + " ON " + q(e.Table) + ";",
		"CREATE TRIGGER " + trigger + " AFTER INSERT OR UPDATE OR DELETE ON " + q(e.Table) + " FOR EACH ROW EXECUTE FUNCTION " + function + "();",
		"DROP TRIGGER IF EXISTS " + truncate + " ON " + q(e.Table) + ";",
		"CREATE TRIGGER " + truncate + " BEFORE TRUNCATE ON " + q(e.Table) + " FOR EACH STATEMENT EXECUTE FUNCTION " + function + "();",
	}
	return o
}

// postgresAuditValue renders a column value for a PostgreSQL JSON object. A
// text column holding JSON, such as jsontext, is recorded as JSON, as it is on
// MySQL and SQLite.
func postgresAuditValue(c *schema.Col, ref string) string {
	if t, err := ddlType(c, "postgres"); err == nil && (t == "text" || strings.HasPrefix(t, "varchar")) {
		return "CASE WHEN " + ref + " IS JSON THEN " + ref + "::jsonb ELSE to_jsonb(" + ref + ") END"
	}
	return "to_jsonb(" + ref + ")"
}

// postgresRowObject renders every column of a row as one JSON object. A
// function call takes at most 100 arguments, so wide tables are built in parts
// and joined.
func postgresRowObject(e *schema.Entity, row string, q func(string) string) string {
	const pairs = 50
	columns := auditColumns(e)
	var parts []string
	for i := 0; i < len(columns); i += pairs {
		args := make([]string, 0, pairs*2)
		for _, c := range columns[i:min(i+pairs, len(columns))] {
			args = append(args, sqlLiteral(c.Name), postgresAuditValue(c, row+"."+q(c.Name)))
		}
		parts = append(parts, "jsonb_build_object("+strings.Join(args, ", ")+")")
	}
	if len(parts) == 0 {
		return "'{}'::jsonb"
	}
	return strings.Join(parts, " || ")
}

// auditValue renders a column value for a JSON object on MySQL and SQLite.
// Binary values use PostgreSQL's hex text form. SQLite stores JSON as text, so
// valid JSON text in a text column becomes a JSON value, as a PostgreSQL json
// column does; the rule uses the storage type, which a live schema reports.
func auditValue(c *schema.Col, ref, dialect string) string {
	if dialect == "sqlite" {
		switch t, _ := ddlType(c, "sqlite"); t {
		case "BLOB":
			return "CASE WHEN " + ref + " IS NULL THEN NULL ELSE '\\x' || lower(hex(" + ref + ")) END"
		case "TEXT":
			return "CASE WHEN json_valid(" + ref + ") THEN json(" + ref + ") ELSE " + ref + " END"
		}
		return ref
	}
	switch c.Type {
	case "bytes", "inet":
		return "CASE WHEN " + ref + " IS NULL THEN NULL ELSE CONCAT(CHAR(92 USING utf8mb4), 'x', LOWER(HEX(" + ref + "))) END"
	case "point":
		return "ST_AsText(" + ref + ")"
	}
	if t, err := ddlType(c, "mysql"); err == nil && (strings.Contains(t, "char") || strings.Contains(t, "text")) {
		return "CAST(IF(JSON_VALID(" + ref + "), " + ref + ", JSON_QUOTE(" + ref + ")) AS JSON)"
	}
	return ref
}

func auditRowObject(e *schema.Entity, row, dialect string, q func(string) string) string {
	fn := "json_object("
	if dialect == "mysql" {
		fn = "JSON_OBJECT("
	}
	parts := make([]string, 0, len(e.Columns)*2)
	for _, c := range auditColumns(e) {
		parts = append(parts, sqlLiteral(c.Name), auditValue(c, row+"."+q(c.Name), dialect))
	}
	return fn + strings.Join(parts, ", ") + ")"
}

// auditUnchanged removes the SQLite columns whose stored bytes an update did
// not change.
func auditUnchanged(e *schema.Entity, object string, q func(string) string) string {
	parts := make([]string, 0, len(e.Columns))
	for _, c := range auditColumns(e) {
		path := sqlLiteral(`$."` + c.Name + `"`)
		parts = append(parts, "CASE WHEN CAST(NEW."+q(c.Name)+" AS BLOB) IS CAST(OLD."+q(c.Name)+" AS BLOB) THEN "+path+" ELSE '$.\"__orm_unchanged\"' END")
	}
	return "json_remove(" + object + ", " + strings.Join(parts, ", ") + ")"
}

// auditColumns lists the columns by name: a column added by a migration sits
// at the end of the live table, and the trigger must not depend on that.
func auditColumns(e *schema.Entity) []*schema.Col {
	columns := slices.Clone(e.Columns)
	slices.SortFunc(columns, func(a, b *schema.Col) int { return strings.Compare(a.Name, b.Name) })
	return columns
}

func auditJSONPath(path []string) string {
	return sqlLiteral(`$."` + strings.Join(path, `"."`) + `"`)
}

func auditKey(e *schema.Entity, event, dialect string, q func(string) string) string {
	fn := "json_object("
	if dialect == "mysql" {
		fn = "JSON_OBJECT("
	}
	parts := make([]string, 0, len(e.PK)*2)
	for _, k := range e.PK {
		c := e.Column(k)
		value := auditValue(c, auditRow(event)+"."+q(k), dialect)
		if event == "UPDATE" {
			value = "COALESCE(" + auditValue(c, "NEW."+q(k), dialect) + ", " + auditValue(c, "OLD."+q(k), dialect) + ")"
		}
		parts = append(parts, sqlLiteral(k), value)
	}
	return fn + strings.Join(parts, ", ") + ")"
}

func auditRow(event string) string {
	if event == "DELETE" {
		return "OLD"
	}
	return "NEW"
}

func auditSite(a *schema.Audit, event string, q func(string) string) string {
	if a.Site == "" {
		return "NULL"
	}
	if event == "UPDATE" {
		return "COALESCE(NEW." + q(a.Site) + ", OLD." + q(a.Site) + ")"
	}
	return auditRow(event) + "." + q(a.Site)
}

var auditEvents = []string{"INSERT", "UPDATE", "DELETE"}

func mysqlAudit(m *schema.Manifest, e *schema.Entity, a *schema.Audit, markers string) triggerObject {
	q := triggerQuote("mysql")
	l := m.AuditLog
	context := "@`orm." + strings.ReplaceAll(l.Context, "`", "``") + "`"
	o := triggerObject{table: e.Table, kind: "audit"}
	for _, event := range auditEvents {
		trigger := q(triggerName(e.Table, "audit_"+strings.ToLower(event), "mysql"))
		var b strings.Builder
		b.WriteString("CREATE TRIGGER " + trigger + " AFTER " + event + " ON " + q(e.Table) + " FOR EACH ROW\nBEGIN\n")
		b.WriteString(markers + "\n")
		b.WriteString("  DECLARE audit_operation_id VARCHAR(255);\n  DECLARE audit_operation_seq BIGINT;\n")
		if a.Mode == "changes" {
			b.WriteString("  DECLARE audit_old JSON;\n  DECLARE audit_new JSON;\n")
		}
		// The local variable takes the database collation, as the tables do;
		// the user variable has the connection collation.
		b.WriteString("  SET audit_operation_id = " + context + ";\n")
		b.WriteString("  IF COALESCE(audit_operation_id, '') = '' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = " + auditContextMessage + "; END IF;\n")
		b.WriteString("  SET audit_operation_seq = (SELECT " + q(l.Operation.Columns[schema.AuditOperationSeq]) + " FROM " + q(l.Operation.Table) + " WHERE " + q(l.Operation.Columns[schema.AuditOperationUUID]) + " = audit_operation_id LIMIT 1);\n")
		b.WriteString("  IF audit_operation_seq IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = " + auditOperationMessage + "; END IF;\n")
		if a.Mode == "changes" {
			switch event {
			case "INSERT":
				b.WriteString("  SET audit_old = JSON_OBJECT();\n")
				b.WriteString("  SET audit_new = " + auditRowObject(e, "NEW", "mysql", q) + ";\n")
			case "DELETE":
				b.WriteString("  SET audit_old = " + auditRowObject(e, "OLD", "mysql", q) + ";\n")
				b.WriteString("  SET audit_new = JSON_OBJECT();\n")
			default:
				// Only the changed columns are rendered, and stored bytes decide
				// a change; the column collation would treat values that differ
				// only in case or accents as equal.
				b.WriteString("  SET audit_old = JSON_OBJECT();\n  SET audit_new = JSON_OBJECT();\n")
				for _, c := range auditColumns(e) {
					path := sqlLiteral(`$."` + c.Name + `"`)
					b.WriteString("  IF NOT (CAST(NEW." + q(c.Name) + " AS BINARY) <=> CAST(OLD." + q(c.Name) + " AS BINARY)) THEN\n")
					b.WriteString("    SET audit_old = JSON_SET(audit_old, " + path + ", " + auditValue(c, "OLD."+q(c.Name), "mysql") + ");\n")
					b.WriteString("    SET audit_new = JSON_SET(audit_new, " + path + ", " + auditValue(c, "NEW."+q(c.Name), "mysql") + ");\n")
					b.WriteString("  END IF;\n")
				}
			}
			for _, path := range a.Redact {
				p := auditJSONPath(path)
				for _, v := range []string{"audit_new", "audit_old"} {
					b.WriteString("  SET " + v + " = IF(JSON_CONTAINS_PATH(" + v + ", 'one', " + p + "), JSON_SET(" + v + ", " + p + ", JSON_OBJECT('redacted', CAST('true' AS JSON), 'present', CAST('true' AS JSON))), " + v + ");\n")
				}
			}
			insert := "INSERT INTO " + q(l.Change.Table) + " (" + auditChangeColumns(l, q) + ") VALUES (audit_operation_seq, '" + event + "', " + auditSite(a, event, q) + ", " + sqlLiteral(e.Table) + ", " + auditKey(e, event, "mysql", q) + ", audit_old, audit_new);"
			if event == "UPDATE" {
				b.WriteString("  IF JSON_LENGTH(audit_old) > 0 OR JSON_LENGTH(audit_new) > 0 THEN\n    " + insert + "\n  END IF;\n")
			} else {
				b.WriteString("  " + insert + "\n")
			}
		}
		b.WriteString("END;")
		o.drop = append(o.drop, "DROP TRIGGER IF EXISTS "+trigger+";")
		o.create = append(o.create, "DROP TRIGGER IF EXISTS "+trigger+";", b.String())
	}
	return o
}

func sqliteAudit(m *schema.Manifest, e *schema.Entity, a *schema.Audit, markers string) triggerObject {
	q := triggerQuote("sqlite")
	l := m.AuditLog
	context := `(SELECT "value" FROM "orm__context" WHERE "key" = ` + sqlLiteral(l.Context) + ")"
	operation := "(SELECT " + q(l.Operation.Columns[schema.AuditOperationSeq]) + " FROM " + q(l.Operation.Table) + " WHERE " + q(l.Operation.Columns[schema.AuditOperationUUID]) + " = " + context + ")"
	o := triggerObject{table: e.Table, kind: "audit"}
	o.create = append(o.create, sqliteContextTable)
	for _, event := range auditEvents {
		trigger := q(triggerName(e.Table, "audit_"+strings.ToLower(event), "sqlite"))
		var b strings.Builder
		b.WriteString("CREATE TRIGGER " + trigger + " AFTER " + event + " ON " + q(e.Table) + " FOR EACH ROW BEGIN\n")
		b.WriteString(markers + "\n")
		b.WriteString("SELECT RAISE(ABORT, " + auditContextMessage + ") WHERE COALESCE(" + context + ", '') = '';\n")
		b.WriteString("SELECT RAISE(ABORT, " + auditOperationMessage + ") WHERE " + operation + " IS NULL;\n")
		if a.Mode == "changes" {
			oldValue, newValue := "json_object()", "json_object()"
			if event != "INSERT" {
				oldValue = auditRowObject(e, "OLD", "sqlite", q)
			}
			if event != "DELETE" {
				newValue = auditRowObject(e, "NEW", "sqlite", q)
			}
			if event == "UPDATE" {
				oldValue = auditUnchanged(e, oldValue, q)
				newValue = auditUnchanged(e, newValue, q)
			}
			source := "SELECT " + newValue + " AS n, " + oldValue + " AS o"
			for _, path := range a.Redact {
				p := auditJSONPath(path)
				redacted := func(v string) string {
					return "CASE WHEN json_type(r." + v + ", " + p + ") IS NOT NULL THEN json_set(r." + v + ", " + p + ", json_object('redacted', json('true'), 'present', json('true'))) ELSE r." + v + " END"
				}
				source = "SELECT " + redacted("n") + " AS n, " + redacted("o") + " AS o FROM (" + source + ") AS r"
			}
			b.WriteString("INSERT INTO " + q(l.Change.Table) + " (" + auditChangeColumns(l, q) + ") SELECT " + operation + ", '" + event + "', " + auditSite(a, event, q) + ", " + sqlLiteral(e.Table) + ", " + auditKey(e, event, "sqlite", q) + ", v.o, v.n FROM (" + source + ") AS v")
			if event == "UPDATE" {
				b.WriteString(" WHERE v.o <> '{}' OR v.n <> '{}'")
			}
			b.WriteString(";\n")
		}
		b.WriteString("END;")
		o.drop = append(o.drop, "DROP TRIGGER IF EXISTS "+trigger+";")
		o.create = append(o.create, "DROP TRIGGER IF EXISTS "+trigger+";", b.String())
	}
	return o
}

const sqliteContextTable = `CREATE TABLE IF NOT EXISTS "orm__context" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL);`

// diffTriggers returns the statements that drop changed trigger objects
// before the table changes and create them after. A rebuilt SQLite table
// loses its triggers, so its objects are always created again.
func diffTriggers(from, to *schema.Manifest, dialect string, rebuilt map[string]bool) ([]schemaChange, []schemaChange, error) {
	fromObjects, err := triggerObjects(from, dialect)
	if err != nil {
		return nil, nil, err
	}
	toObjects, err := triggerObjects(to, dialect)
	if err != nil {
		return nil, nil, err
	}
	next := map[string]triggerObject{}
	for _, o := range toObjects {
		next[o.key()] = o
	}
	previous := map[string]triggerObject{}
	var drops, creates []schemaChange
	for _, o := range fromObjects {
		previous[o.key()] = o
		n, kept := next[o.key()]
		if kept && n.text() == o.text() && !rebuilt[o.table] {
			continue
		}
		for _, statement := range o.drop {
			drops = append(drops, schemaChange{sql: statement})
		}
	}
	for _, o := range toObjects {
		p, existed := previous[o.key()]
		if existed && p.text() == o.text() && !rebuilt[o.table] {
			continue
		}
		creates = append(creates, schemaChange{sql: strings.Join(o.create, "\n")})
	}
	return drops, creates, nil
}

// sameTriggers reports whether a live schema has the declared trigger
// objects, compared by table so live entity names may differ.
func sameTriggers(want, live *schema.Manifest) bool {
	describe := func(m *schema.Manifest) []string {
		var out []string
		for _, name := range m.Immutable {
			out = append(out, "immutable "+m.Entities[name].Table)
		}
		for _, a := range m.Audits {
			out = append(out, auditMarker(m.Entities[a.Entity].Table, &a))
		}
		if m.AuditLog != nil {
			out = append(out, auditLogMarker(m.AuditLog))
		}
		sort.Strings(out)
		return out
	}
	return strings.Join(describe(want), "\n") == strings.Join(describe(live), "\n")
}

// triggerDirectives turns the marker lines of live triggers into Mermaid
// directives for the tables in the imported set. Entity names are table names.
func triggerDirectives(bodies []string, tables map[string]bool) []string {
	var audits, immutables []string
	auditLog := ""
	seen := map[string]bool{}
	for _, body := range bodies {
		for _, line := range strings.Split(body, "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, triggerMarker) || seen[line] {
				continue
			}
			seen[line] = true
			directive := strings.TrimPrefix(line, triggerMarker)
			kind, rest, _ := strings.Cut(directive, " ")
			switch kind {
			case "audit_log":
				auditLog = "%% orm:" + directive
			case "audit", "immutable":
				table, options, _ := strings.Cut(strings.TrimPrefix(rest, "table="), " ")
				if !tables[table] {
					continue
				}
				line := "%% orm:" + kind + " entity=" + table
				if options != "" {
					line += " " + options
				}
				if kind == "audit" {
					audits = append(audits, line)
				} else {
					immutables = append(immutables, line)
				}
			}
		}
	}
	sort.Strings(audits)
	sort.Strings(immutables)
	out := immutables
	if len(audits) > 0 && auditLog != "" {
		out = append(out, auditLog)
		out = append(out, audits...)
	}
	return out
}

// readTriggerBodies returns the bodies of the triggers in the current schema
// that carry ORM markers.
func readTriggerBodies(db *sql.DB, driver string) ([]string, error) {
	var query string
	switch driver {
	case "postgres":
		query = `SELECT p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = current_schema() ORDER BY c.relname, t.tgname`
	case "mysql":
		query = `SELECT ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`
	case "sqlite":
		query = `SELECT sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name`
	default:
		return nil, fmt.Errorf("unknown driver %q", driver)
	}
	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var bodies []string
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			return nil, err
		}
		if strings.Contains(body, triggerMarker) {
			bodies = append(bodies, body)
		}
	}
	return bodies, rows.Err()
}

// withTriggerDirectives appends the directives of the live ORM triggers on the
// imported tables to a rendered diagram.
func withTriggerDirectives(db *sql.DB, driver string, tables []impTable, text string) (string, error) {
	bodies, err := readTriggerBodies(db, driver)
	if err != nil {
		return "", err
	}
	names := map[string]bool{}
	for _, t := range tables {
		names[t.Name] = true
	}
	for _, line := range triggerDirectives(bodies, names) {
		text += "  " + line + "\n"
	}
	return text, nil
}
