// ORM-owned triggers (audit and immutable guards), rendered as the schema tool
// renders them. Each table's triggers form one object: DDL creates it after the
// tables, and diff replaces it when its rendered form changes.
import { OrmError } from '../runtime_error.js';
import { byteOrder, ddlBase, ddlTable, ddlType, quoteQualified, sqlQuote, type Quote } from './ddl.js';
import { columnOf, type AuditDeclaration, type AuditLog, type Column, type Entity, type Manifest } from './manifest.js';

export interface TriggerObject {
  readonly table: string;
  readonly kind: 'audit' | 'immutable';
  readonly drop: string[];
  readonly create: string[];
}

export const triggerMarker = '-- orm:';
const contextMessage = "'audit operation context is required'";
const operationMessage = "'audit operation does not exist'";
export const sqliteContextTable = 'CREATE TABLE IF NOT EXISTS "orm__context" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL);';
const events = ['INSERT', 'UPDATE', 'DELETE'] as const;

export function auditLogMarker(l: AuditLog): string {
  return `${triggerMarker}audit_log operation=${l.operation.table}(${l.operation.columns.join(', ')}) context=${l.context} change=${l.change.table}(${l.change.columns.join(', ')})`;
}

export function auditMarker(table: string, a: AuditDeclaration): string {
  let s = `${triggerMarker}audit table=${table} mode=${a.mode}`;
  if ((a.site ?? '') !== '') s += ` service=${a.site}`;
  if ((a.redact ?? []).length > 0) s += ` redact=${a.redact!.map(p => p.join('.')).join(',')}`;
  return s;
}

function quoter(dialect: string): Quote {
  return dialect === 'mysql' ? s => quoteQualified('`', s) : s => quoteQualified('"', ddlTable(s, dialect));
}

const literal = (s: string): string => `'${sqlQuote(s)}'`;

function triggerName(table: string, suffix: string, dialect: string): string {
  return `${dialect === 'sqlite' ? ddlTable(table, dialect) : table}_${suffix}`;
}

export function auditOf(m: Manifest, entity: string): AuditDeclaration | undefined {
  return (m.audits ?? []).find(a => a.entity === entity);
}

export function triggerText(o: TriggerObject): string { return o.create.join('\n'); }

export function triggerObjects(m: Manifest, dialect: string): TriggerObject[] {
  const immutable = new Set(m.immutable ?? []);
  const out: TriggerObject[] = [];
  for (const name of m.order) {
    const e = m.entities[name]!;
    const a = auditOf(m, name);
    if (a !== undefined) {
      const markers = `${auditLogMarker(m.audit_log!)}\n${auditMarker(e.table, a)}`;
      switch (dialect) {
        case 'postgres': out.push(postgresAudit(m, e, a, markers)); break;
        case 'mysql': out.push(mysqlAudit(m, e, a, markers)); break;
        case 'sqlite': out.push(sqliteAudit(m, e, a, markers)); break;
        default: throw new OrmError('CONFIG', `unknown dialect "${dialect}"`);
      }
    }
    if (immutable.has(name)) out.push(immutableObject(e, dialect));
  }
  return out;
}

function immutableObject(e: Entity, dialect: string): TriggerObject {
  const q = quoter(dialect);
  const drop: string[] = [];
  const create: string[] = [];
  const marker = `${triggerMarker}immutable table=${e.table}`;
  const message = literal(`immutable table: ${e.table}`);
  if (dialect === 'postgres') {
    const fn = q(`${e.table}_immutable_reject`);
    const trigger = `"${ddlBase(e.table)}_immutable"`;
    drop.push(`DROP TRIGGER IF EXISTS ${trigger} ON ${q(e.table)};`, `DROP FUNCTION IF EXISTS ${fn}();`);
    create.push(
      `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$\n${marker}\nBEGIN RAISE EXCEPTION ${message}; END;\n$$;`,
      `DROP TRIGGER IF EXISTS ${trigger} ON ${q(e.table)};`,
      `CREATE TRIGGER ${trigger} BEFORE UPDATE OR DELETE OR TRUNCATE ON ${q(e.table)} FOR EACH STATEMENT EXECUTE FUNCTION ${fn}();`,
    );
    return { table: e.table, kind: 'immutable', drop, create };
  }
  for (const event of ['update', 'delete']) {
    const trigger = q(triggerName(e.table, `immutable_${event}`, dialect));
    drop.push(`DROP TRIGGER IF EXISTS ${trigger};`);
    create.push(`DROP TRIGGER IF EXISTS ${trigger};`);
    create.push(dialect === 'sqlite'
      ? `CREATE TRIGGER ${trigger} BEFORE ${event.toUpperCase()} ON ${q(e.table)} FOR EACH ROW BEGIN\n${marker}\nSELECT RAISE(ABORT, ${message});\nEND;`
      : `CREATE TRIGGER ${trigger} BEFORE ${event.toUpperCase()} ON ${q(e.table)} FOR EACH ROW\nBEGIN\n${marker}\n  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${message};\nEND;`);
  }
  return { table: e.table, kind: 'immutable', drop, create };
}

const changeColumns = (l: AuditLog, q: Quote): string => l.change.columns.map(q).join(', ');

function postgresAudit(m: Manifest, e: Entity, a: AuditDeclaration, markers: string): TriggerObject {
  const q = quoter('postgres');
  const l = m.audit_log!;
  const fn = q(`${e.table}_audit`);
  const trigger = `"${ddlBase(e.table)}_audit"`;
  const truncate = `"${ddlBase(e.table)}_audit_truncate"`;
  let b = `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$\n`;
  b += `${markers}\n`;
  b += `DECLARE\n  audit_operation_id text := current_setting(${literal(l.context)}, true);\n  audit_operation_seq bigint;\n`;
  if (a.mode === 'changes') {
    b += "  audit_old jsonb := '{}'::jsonb;\n  audit_new jsonb := '{}'::jsonb;\n  audit_service text;\n  audit_key jsonb;\n";
  }
  b += 'BEGIN\n';
  b += `  IF audit_operation_id IS NULL OR audit_operation_id = '' THEN RAISE EXCEPTION ${contextMessage}; END IF;\n`;
  b += `  SELECT ${q(l.operation.columns[0]!)} INTO audit_operation_seq FROM ${q(l.operation.table)} WHERE ${q(l.operation.columns[1]!)}::text = audit_operation_id;\n`;
  b += `  IF audit_operation_seq IS NULL THEN RAISE EXCEPTION ${operationMessage}; END IF;\n`;
  if (a.mode === 'changes') {
    b += "  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;\n";
    // An insert and a delete record every column. An update compares each
    // column's stored bytes and records only the changed columns, so an
    // unchanged large value is neither parsed nor compared under a collation.
    b += "  IF TG_OP = 'INSERT' THEN\n";
    b += `    audit_new := ${postgresRowObject(e, 'NEW', q)};\n`;
    b += "  ELSIF TG_OP = 'DELETE' THEN\n";
    b += `    audit_old := ${postgresRowObject(e, 'OLD', q)};\n`;
    b += '  ELSE\n';
    for (const c of auditColumns(e)) {
      const name = literal(c.name);
      b += `    IF OLD.${q(c.name)}::text IS DISTINCT FROM NEW.${q(c.name)}::text THEN\n`;
      b += `      audit_old := audit_old || jsonb_build_object(${name}, ${postgresValue(c, `OLD.${q(c.name)}`)});\n`;
      b += `      audit_new := audit_new || jsonb_build_object(${name}, ${postgresValue(c, `NEW.${q(c.name)}`)});\n`;
      b += '    END IF;\n';
    }
    b += "    IF audit_old::text = '{}' AND audit_new::text = '{}' THEN RETURN NULL; END IF;\n";
    b += '  END IF;\n';
    if ((a.site ?? '') !== '') b += `  audit_service := CASE TG_OP WHEN 'DELETE' THEN OLD.${q(a.site!)}::text ELSE NEW.${q(a.site!)}::text END;\n`;
    const keys = e.pk.flatMap(k => [literal(k), `to_jsonb(CASE TG_OP WHEN 'DELETE' THEN OLD.${q(k)} ELSE NEW.${q(k)} END)`]);
    b += `  audit_key := jsonb_build_object(${keys.join(', ')});\n`;
    for (const path of a.redact ?? []) {
      const p = literal(`{${path.join(',')}}`);
      for (const v of ['audit_new', 'audit_old']) {
        b += `  IF ${v} #> ${p} IS NOT NULL THEN ${v} := jsonb_set(${v}, ${p}, '{"redacted": true, "present": true}'::jsonb); END IF;\n`;
      }
    }
    b += `  INSERT INTO ${q(l.change.table)} (${changeColumns(l, q)}) VALUES (audit_operation_seq, TG_OP, audit_service, ${literal(e.table)}, audit_key, audit_old, audit_new);\n`;
  }
  b += '  RETURN NULL;\nEND\n$$;';
  const table = q(e.table);
  return {
    table: e.table, kind: 'audit',
    drop: [
      `DROP TRIGGER IF EXISTS ${trigger} ON ${table};`,
      `DROP TRIGGER IF EXISTS ${truncate} ON ${table};`,
      `DROP FUNCTION IF EXISTS ${fn}();`,
    ],
    create: [
      b,
      `DROP TRIGGER IF EXISTS ${trigger} ON ${table};`,
      `CREATE TRIGGER ${trigger} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
      `DROP TRIGGER IF EXISTS ${truncate} ON ${table};`,
      `CREATE TRIGGER ${truncate} BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${fn}();`,
    ],
  };
}

/** A column value for a JSON object on MySQL and SQLite. */
/** A PostgreSQL JSON value; a text column holding JSON is recorded as JSON. */
function postgresValue(c: Column, ref: string): string {
  const type = ddlType(c, 'postgres');
  if (type === 'text' || type.startsWith('varchar')) return `CASE WHEN ${ref} IS JSON THEN ${ref}::jsonb ELSE to_jsonb(${ref}) END`;
  return `to_jsonb(${ref})`;
}

/** Every column of a row as one JSON object, built in parts of 50 pairs. */
function postgresRowObject(e: Entity, row: string, q: Quote): string {
  const columns = auditColumns(e);
  const parts: string[] = [];
  for (let i = 0; i < columns.length; i += 50) {
    const args = columns.slice(i, i + 50).flatMap(c => [literal(c.name), postgresValue(c, `${row}.${q(c.name)}`)]);
    parts.push(`jsonb_build_object(${args.join(', ')})`);
  }
  return parts.length === 0 ? "'{}'::jsonb" : parts.join(' || ');
}

function auditValue(c: Column, ref: string, dialect: string): string {
  if (dialect === 'sqlite') {
    switch (ddlType(c, 'sqlite')) {
      case 'BLOB': return `CASE WHEN ${ref} IS NULL THEN NULL ELSE '\\x' || lower(hex(${ref})) END`;
      case 'TEXT': return `CASE WHEN json_valid(${ref}) THEN json(${ref}) ELSE ${ref} END`;
      default: return ref;
    }
  }
  switch (c.type) {
    case 'bytes': case 'inet': return `CASE WHEN ${ref} IS NULL THEN NULL ELSE CONCAT(CHAR(92 USING utf8mb4), 'x', LOWER(HEX(${ref}))) END`;
    case 'point': return `ST_AsText(${ref})`;
  }
  const type = ddlType(c, 'mysql').toLowerCase();
  if (type.includes('char') || type.includes('text')) return `CAST(IF(JSON_VALID(${ref}), ${ref}, JSON_QUOTE(${ref})) AS JSON)`;
  return ref;
}

/** The columns by name: a column added by a migration sits at the end of the live table. */
function auditColumns(e: Entity): Column[] {
  return [...e.columns].sort((a, b) => byteOrder(a.name, b.name));
}

function rowObject(e: Entity, row: string, dialect: string, q: Quote): string {
  const parts = auditColumns(e).flatMap(c => [literal(c.name), auditValue(c, `${row}.${q(c.name)}`, dialect)]);
  return `${dialect === 'mysql' ? 'JSON_OBJECT(' : 'json_object('}${parts.join(', ')})`;
}

/** Removes the SQLite columns whose stored bytes did not change. */
function unchanged(e: Entity, object: string, q: Quote): string {
  const parts = auditColumns(e).map(c => {
    const path = literal(`$."${c.name}"`);
    return `CASE WHEN CAST(NEW.${q(c.name)} AS BLOB) IS CAST(OLD.${q(c.name)} AS BLOB) THEN ${path} ELSE '$."__orm_unchanged"' END`;
  });
  return `json_remove(${object}, ${parts.join(', ')})`;
}

const jsonPath = (path: readonly string[]): string => literal(`$."${path.join('"."')}"`);
const rowOf = (event: string): string => event === 'DELETE' ? 'OLD' : 'NEW';

function auditKey(e: Entity, event: string, dialect: string, q: Quote): string {
  const parts = e.pk.flatMap(k => {
    const c = columnOf(e, k)!;
    const value = event === 'UPDATE'
      ? `COALESCE(${auditValue(c, `NEW.${q(k)}`, dialect)}, ${auditValue(c, `OLD.${q(k)}`, dialect)})`
      : auditValue(c, `${rowOf(event)}.${q(k)}`, dialect);
    return [literal(k), value];
  });
  return `${dialect === 'mysql' ? 'JSON_OBJECT(' : 'json_object('}${parts.join(', ')})`;
}

function auditService(a: AuditDeclaration, event: string, q: Quote): string {
  if ((a.site ?? '') === '') return 'NULL';
  if (event === 'UPDATE') return `COALESCE(NEW.${q(a.site!)}, OLD.${q(a.site!)})`;
  return `${rowOf(event)}.${q(a.site!)}`;
}

function mysqlAudit(m: Manifest, e: Entity, a: AuditDeclaration, markers: string): TriggerObject {
  const q = quoter('mysql');
  const l = m.audit_log!;
  const context = '@`orm.' + l.context.replaceAll('`', '``') + '`';
  const drop: string[] = [];
  const create: string[] = [];
  for (const event of events) {
    const trigger = q(triggerName(e.table, `audit_${event.toLowerCase()}`, 'mysql'));
    let b = `CREATE TRIGGER ${trigger} AFTER ${event} ON ${q(e.table)} FOR EACH ROW\nBEGIN\n`;
    b += `${markers}\n`;
    b += '  DECLARE audit_operation_id VARCHAR(255);\n  DECLARE audit_operation_seq BIGINT;\n';
    if (a.mode === 'changes') b += '  DECLARE audit_old JSON;\n  DECLARE audit_new JSON;\n';
    b += `  SET audit_operation_id = ${context};\n`;
    b += `  IF COALESCE(audit_operation_id, '') = '' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${contextMessage}; END IF;\n`;
    b += `  SET audit_operation_seq = (SELECT ${q(l.operation.columns[0]!)} FROM ${q(l.operation.table)} WHERE ${q(l.operation.columns[1]!)} = audit_operation_id LIMIT 1);\n`;
    b += `  IF audit_operation_seq IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${operationMessage}; END IF;\n`;
    if (a.mode === 'changes') {
      if (event === 'INSERT') {
        b += '  SET audit_old = JSON_OBJECT();\n';
        b += `  SET audit_new = ${rowObject(e, 'NEW', 'mysql', q)};\n`;
      } else if (event === 'DELETE') {
        b += `  SET audit_old = ${rowObject(e, 'OLD', 'mysql', q)};\n`;
        b += '  SET audit_new = JSON_OBJECT();\n';
      } else {
        // Only the changed columns are rendered, and stored bytes decide a
        // change; the column collation would treat values that differ only in
        // case or accents as equal.
        b += '  SET audit_old = JSON_OBJECT();\n  SET audit_new = JSON_OBJECT();\n';
        for (const c of auditColumns(e)) {
          const path = literal(`$."${c.name}"`);
          b += `  IF NOT (CAST(NEW.${q(c.name)} AS BINARY) <=> CAST(OLD.${q(c.name)} AS BINARY)) THEN\n`;
          b += `    SET audit_old = JSON_SET(audit_old, ${path}, ${auditValue(c, `OLD.${q(c.name)}`, 'mysql')});\n`;
          b += `    SET audit_new = JSON_SET(audit_new, ${path}, ${auditValue(c, `NEW.${q(c.name)}`, 'mysql')});\n`;
          b += '  END IF;\n';
        }
      }
      for (const path of a.redact ?? []) {
        const p = jsonPath(path);
        for (const v of ['audit_new', 'audit_old']) {
          b += `  SET ${v} = IF(JSON_CONTAINS_PATH(${v}, 'one', ${p}), JSON_SET(${v}, ${p}, JSON_OBJECT('redacted', CAST('true' AS JSON), 'present', CAST('true' AS JSON))), ${v});\n`;
        }
      }
      const insert = `INSERT INTO ${q(l.change.table)} (${changeColumns(l, q)}) VALUES (audit_operation_seq, '${event}', ${auditService(a, event, q)}, ${literal(e.table)}, ${auditKey(e, event, 'mysql', q)}, audit_old, audit_new);`;
      b += event === 'UPDATE'
        ? `  IF JSON_LENGTH(audit_old) > 0 OR JSON_LENGTH(audit_new) > 0 THEN\n    ${insert}\n  END IF;\n`
        : `  ${insert}\n`;
    }
    b += 'END;';
    drop.push(`DROP TRIGGER IF EXISTS ${trigger};`);
    create.push(`DROP TRIGGER IF EXISTS ${trigger};`, b);
  }
  return { table: e.table, kind: 'audit', drop, create };
}

function sqliteAudit(m: Manifest, e: Entity, a: AuditDeclaration, markers: string): TriggerObject {
  const q = quoter('sqlite');
  const l = m.audit_log!;
  const context = `(SELECT "value" FROM "orm__context" WHERE "key" = ${literal(l.context)})`;
  const operation = `(SELECT ${q(l.operation.columns[0]!)} FROM ${q(l.operation.table)} WHERE ${q(l.operation.columns[1]!)} = ${context})`;
  const drop: string[] = [];
  const create: string[] = [sqliteContextTable];
  for (const event of events) {
    const trigger = q(triggerName(e.table, `audit_${event.toLowerCase()}`, 'sqlite'));
    let b = `CREATE TRIGGER ${trigger} AFTER ${event} ON ${q(e.table)} FOR EACH ROW BEGIN\n`;
    b += `${markers}\n`;
    b += `SELECT RAISE(ABORT, ${contextMessage}) WHERE COALESCE(${context}, '') = '';\n`;
    b += `SELECT RAISE(ABORT, ${operationMessage}) WHERE ${operation} IS NULL;\n`;
    if (a.mode === 'changes') {
      let oldValue = event !== 'INSERT' ? rowObject(e, 'OLD', 'sqlite', q) : 'json_object()';
      let newValue = event !== 'DELETE' ? rowObject(e, 'NEW', 'sqlite', q) : 'json_object()';
      if (event === 'UPDATE') {
        oldValue = unchanged(e, oldValue, q);
        newValue = unchanged(e, newValue, q);
      }
      let source = `SELECT ${newValue} AS n, ${oldValue} AS o`;
      for (const path of a.redact ?? []) {
        const p = jsonPath(path);
        const redacted = (v: string) => `CASE WHEN json_type(r.${v}, ${p}) IS NOT NULL THEN json_set(r.${v}, ${p}, json_object('redacted', json('true'), 'present', json('true'))) ELSE r.${v} END`;
        source = `SELECT ${redacted('n')} AS n, ${redacted('o')} AS o FROM (${source}) AS r`;
      }
      b += `INSERT INTO ${q(l.change.table)} (${changeColumns(l, q)}) SELECT ${operation}, '${event}', ${auditService(a, event, q)}, ${literal(e.table)}, ${auditKey(e, event, 'sqlite', q)}, v.o, v.n FROM (${source}) AS v`;
      if (event === 'UPDATE') b += " WHERE v.o <> '{}' OR v.n <> '{}'";
      b += ';\n';
    }
    b += 'END;';
    drop.push(`DROP TRIGGER IF EXISTS ${trigger};`);
    create.push(`DROP TRIGGER IF EXISTS ${trigger};`, b);
  }
  return { table: e.table, kind: 'audit', drop, create };
}

/**
 * The statements that drop changed trigger objects before the table changes
 * and create them after. A rebuilt SQLite table loses its triggers, so its
 * objects are always created again.
 */
export function diffTriggers(from: Manifest, to: Manifest, dialect: string, rebuilt: ReadonlySet<string>): { drops: string[]; creates: string[] } {
  const key = (o: TriggerObject) => `${o.table}\x00${o.kind}`;
  const next = new Map(triggerObjects(to, dialect).map(o => [key(o), o]));
  const previous = new Map<string, TriggerObject>();
  const drops: string[] = [];
  for (const o of triggerObjects(from, dialect)) {
    previous.set(key(o), o);
    const n = next.get(key(o));
    if (n !== undefined && triggerText(n) === triggerText(o) && !rebuilt.has(o.table)) continue;
    drops.push(...o.drop);
  }
  const creates: string[] = [];
  for (const [k, o] of next) {
    const p = previous.get(k);
    if (p !== undefined && triggerText(p) === triggerText(o) && !rebuilt.has(o.table)) continue;
    creates.push(o.create.join('\n'));
  }
  return { drops, creates };
}

/** Whether a live schema has the declared trigger objects, compared by table. */
export function sameTriggers(want: Manifest, live: Manifest): boolean {
  const describe = (m: Manifest): string => {
    const out: string[] = [];
    for (const name of m.immutable ?? []) out.push(`immutable ${m.entities[name]!.table}`);
    for (const a of m.audits ?? []) out.push(auditMarker(m.entities[a.entity]!.table, a));
    if (m.audit_log) out.push(auditLogMarker(m.audit_log));
    return out.sort(byteOrder).join('\n');
  };
  return describe(want) === describe(live);
}

/** Mermaid directives for the marker lines of live triggers on the imported tables. */
export function triggerDirectives(bodies: readonly string[], tables: ReadonlySet<string>): string[] {
  const audits: string[] = [];
  const immutables: string[] = [];
  let auditLog = '';
  const seen = new Set<string>();
  for (const body of bodies) {
    for (let line of body.split('\n')) {
      line = line.trim();
      if (!line.startsWith(triggerMarker) || seen.has(line)) continue;
      seen.add(line);
      const directive = line.slice(triggerMarker.length);
      const space = directive.indexOf(' ');
      const kind = space < 0 ? directive : directive.slice(0, space);
      const rest = space < 0 ? '' : directive.slice(space + 1);
      if (kind === 'audit_log') auditLog = `%% orm:${directive}`;
      else if (kind === 'audit' || kind === 'immutable') {
        const body = rest.startsWith('table=') ? rest.slice('table='.length) : rest;
        const cut = body.indexOf(' ');
        const table = cut < 0 ? body : body.slice(0, cut);
        const options = cut < 0 ? '' : body.slice(cut + 1);
        if (!tables.has(table)) continue;
        const out = `%% orm:${kind} entity=${table}${options !== '' ? ` ${options}` : ''}`;
        (kind === 'audit' ? audits : immutables).push(out);
      }
    }
  }
  audits.sort(byteOrder);
  immutables.sort(byteOrder);
  const out = [...immutables];
  if (audits.length > 0 && auditLog !== '') out.push(auditLog, ...audits);
  return out;
}

export const triggerBodiesQuery: Readonly<Record<string, string>> = {
  postgres: 'SELECT p.prosrc AS body FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = current_schema() ORDER BY c.relname, t.tgname',
  mysql: 'SELECT ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME',
  sqlite: "SELECT sql AS body FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name",
};
