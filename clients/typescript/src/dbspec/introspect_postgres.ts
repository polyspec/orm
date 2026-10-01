// PostgreSQL의 현재 schema를 catalog으로 읽는다 (docs/dialects.md "Introspection").
// 모든 query는 현재 schema 전체를 한 번에 읽는다.
import { Catalog, cut, quote, tableTypes, type CatalogQuery } from './introspect_catalog.js';
import { CheckDecodeError, decodeCheck } from './introspect_check.js';
import { recognizeTriggers, type ITrigger } from './introspect_trigger.js';
import type { DbspecAction, DbspecType } from './model.js';

const TABLES_QUERY = `SELECT c.relname, c.relkind::text, c.relispartition FROM pg_class c
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname <> 'dbspec$plans' ORDER BY c.relname`;
const SEQUENCES_QUERY = `SELECT c.relname FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'S'
AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i') ORDER BY c.relname`;
const COLUMNS_QUERY = `SELECT c.relname, a.attname, quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull,
pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text, coalesce(co.collname, '')
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_collation co ON co.oid = a.attcollation
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum`;
const CONSTRAINTS_QUERY = `SELECT c.relname, con.conname, con.contype::text, pg_get_constraintdef(con.oid), con.condeferrable,
con.convalidated, con.confmatchtype::text, con.confdeltype::text, con.confupdtype::text, coalesce(r.relname, ''),
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), ',')
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_class r ON r.oid = con.confrelid
WHERE c.relnamespace = current_schema()::regnamespace AND con.contype <> 'n' ORDER BY c.relname, con.conname`;
const INDEXES_QUERY = `SELECT c.relname, i.relname, x.indisunique, x.indpred IS NOT NULL, x.indexprs IS NOT NULL,
x.indnatts <> x.indnkeyatts, am.amname,
array_to_string(ARRAY(SELECT a.attname FROM unnest(x.indkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT (o & 1)::text FROM unnest(x.indoption::int2[]) o), ',')
FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_am am ON am.oid = i.relam
WHERE c.relnamespace = current_schema()::regnamespace
AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid AND con.contype IN ('p', 'u', 'x'))
ORDER BY c.relname, i.relname`;
const TRIGGERS_QUERY = `SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid), p.proname, p.prosrc, l.lanname
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_language l ON l.oid = p.prolang
WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace ORDER BY c.relname, t.tgname`;
const ROUTINES_QUERY = `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace ORDER BY p.proname`;

const TYPE_PATTERN =
  /^(smallint|integer|bigint|boolean|double precision|text|bytea|uuid|date)$|^numeric\((\d+),(\d+)\)$|^character varying\((\d+)\)$|^(time|timestamp)\((\d)\) without time zone$/;
const LITERAL_PATTERN = /^'((?:[^']|'')*)'::([a-z ]+)$/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
// \S는 Go RE2처럼 ASCII 공백 [\t\n\f\r ]만 뺀다.
const TRIGGER_PATTERN =
  /^CREATE TRIGGER ([^\t\n\f\r ]+) (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON (?:[^\t\n\f\r ]+\.)?([^\t\n\f\r ]+) FOR EACH ROW EXECUTE FUNCTION ([^\t\n\f\r ]+)\(\)$/;

const trimQuotes = (s: string): string => s.replace(/^"+|"+$/g, '');

export async function readPostgres(query: CatalogQuery): Promise<Catalog> {
  const c = new Catalog();
  for (const r of await query(TABLES_QUERY)) {
    const [name, kind, partition] = [r.text(0), r.text(1), r.flag(2)];
    if (kind === 'p' || partition) {
      c.report('partition', name, name, 'a partitioned table or a partition has no dbspec definition');
    } else if (kind === 'r') {
      c.addTable(name);
    } else {
      c.report('view', name, name, `a relation of kind ${kind} has no dbspec definition`);
    }
  }
  for (const r of await query(SEQUENCES_QUERY)) {
    c.report('sequence', '', r.text(0), 'a sequence outside identity has no dbspec definition');
  }
  const quoted = new Map<string, Map<string, string>>();
  const pending = new Map<string, Set<string>>();
  for (const r of await query(COLUMNS_QUERY)) {
    const [table, name, quotedName, formatted, notNull, dflt] = [r.text(0), r.text(1), r.text(2), r.text(3), r.flag(4), r.nullableText(5)];
    const [identity, generated, collation] = [r.text(6), r.text(7), r.text(8)];
    const t = c.table(table);
    if (t === undefined) continue;
    const type = postgresType(formatted, collation);
    if (type === null || generated !== '') {
      c.report('column', table, name, `type ${formatted} with collation ${JSON.stringify(collation)} has no dbspec type`);
      continue;
    }
    const col = { name, type, nullable: !notNull, identity: false, dflt: '' };
    if (identity === 'd') {
      col.identity = true;
    } else if (identity === 'a') {
      c.report('column', table, name, 'an identity generated always has no dbspec definition');
      continue;
    }
    if (dflt !== null) {
      const value = postgresDefault(dflt, type);
      if (value === null) {
        c.report('column', table, name, `default ${dflt} is not a dbspec default`);
        continue;
      }
      col.dflt = value;
    }
    t.columns.push(col);
    if (!quoted.has(table)) quoted.set(table, new Map());
    quoted.get(table)!.set(name, quotedName);
    if (type.kind === 'time') {
      if (!pending.has(table)) pending.set(table, new Set());
      pending.get(table)!.add(name);
    }
  }
  const checked = new Map<string, Set<string>>();
  for (const r of await query(CONSTRAINTS_QUERY)) {
    const [table, name, kind, definition, deferrable, validated] = [r.text(0), r.text(1), r.text(2), r.text(3), r.flag(4), r.flag(5)];
    const [match, onDelete, onUpdate, refTable, columns, refs] = [r.text(6), r.text(7), r.text(8), r.text(9), r.text(10), r.text(11)];
    const t = c.table(table);
    if (t === undefined) continue;
    const list = columns.split(',');
    if (!validated || deferrable) {
      c.report(postgresKind(kind), table, name, 'a deferrable or not validated constraint has no dbspec definition');
    } else if (kind === 'p') {
      t.primary = list;
    } else if (kind === 'u') {
      if (name.includes('$') || !definition.startsWith('UNIQUE (')) {
        c.report('unique', table, name, `the unique constraint ${definition} has no dbspec definition`);
        continue;
      }
      t.uniques.push({ name, columns: list, desc: list.map(() => false) });
    } else if (kind === 'f') {
      const del = postgresAction(onDelete);
      const upd = postgresAction(onUpdate);
      if (del === null || upd === null || match !== 's') {
        c.report('foreign_key', table, name, `actions ${onDelete}, ${onUpdate} or match ${match} have no dbspec definition`);
        continue;
      }
      t.fks.push({ name, columns: list, table: refTable, refs: refs.split(','), onDelete: del, onUpdate: upd });
    } else if (kind === 'c') {
      const [owner, column, generated] = cut(name, '$');
      if (generated) {
        const want = `CHECK ((${quoted.get(table)?.get(column) ?? ''} < '24:00:00'::time without time zone))`;
        if (owner !== table || !pending.get(table)?.has(column) || definition !== want) {
          c.report('check', table, name, `the check ${definition} is not the renderer CHECK`);
          continue;
        }
        if (!checked.has(table)) checked.set(table, new Set());
        checked.get(table)!.add(column);
        continue;
      }
      let predicate: string;
      try {
        predicate = decodeCheck('postgres', definition, tableTypes(t));
      } catch (error) {
        if (!(error instanceof CheckDecodeError)) throw error;
        c.report('check', table, name, error.message);
        continue;
      }
      t.checks.push({ name, predicate });
    } else {
      c.report(postgresKind(kind), table, name, `a constraint of kind ${kind} has no dbspec definition`);
    }
  }
  for (const [table, cols] of pending) {
    for (const column of cols) {
      if (checked.get(table)?.has(column)) continue;
      c.report('column', table, column, 'time without its renderer CHECK has no dbspec type');
      c.dropColumn(table, column);
    }
  }
  for (const r of await query(INDEXES_QUERY)) {
    const [table, name, unique, partial, expression, include] = [r.text(0), r.text(1), r.flag(2), r.flag(3), r.flag(4), r.flag(5)];
    const [method, columns, options] = [r.text(6), r.text(7), r.text(8)];
    const t = c.table(table);
    if (t === undefined) continue;
    if (unique || partial || expression || include || method !== 'btree' || name.includes('$')) {
      c.report('index', table, name, `a unique, partial, expression, covering or ${method} index has no dbspec index`);
      continue;
    }
    t.indexes.push({ name, columns: columns.split(','), desc: options.split(',').map(o => o === '1') });
  }
  const triggers = new Map<string, ITrigger[]>();
  const functions = new Set<string>();
  for (const r of await query(TRIGGERS_QUERY)) {
    const [table, name, definition, fn, source, language] = [r.text(0), r.text(1), r.text(2), r.text(3), r.text(4), r.text(5)];
    functions.add(fn);
    if (!triggers.has(table)) triggers.set(table, []);
    const m = TRIGGER_PATTERN.exec(definition);
    if (m === null || language !== 'plpgsql' || trimQuotes(m[1]!) !== name || trimQuotes(m[5]!) !== fn) {
      triggers.get(table)!.push({ name, statements: [definition] });
      continue;
    }
    triggers.get(table)!.push({
      name,
      statements: [
        `CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$${source}$$`,
        `CREATE TRIGGER "${name}" ${m[2]} ${m[3]} ON "${trimQuotes(m[4]!)}" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
      ],
    });
  }
  recognizeTriggers(c, 'postgres', triggers);
  for (const r of await query(ROUTINES_QUERY)) {
    const name = r.text(0);
    if (!functions.has(name)) c.report('routine', '', name, 'a function outside the renderer triggers has no dbspec definition');
  }
  return c;
}

/** format_type과 collation을 dbspec type으로 읽는다. dbspec type이 아니면 null이다. */
function postgresType(formatted: string, collation: string): DbspecType | null {
  const m = TYPE_PATTERN.exec(formatted);
  if (m === null) return null;
  if (m[2] !== undefined) return { kind: 'decimal', precision: Number(m[2]), scale: Number(m[3]) };
  if (m[4] !== undefined) return collation === 'C' ? { kind: 'varchar', length: Number(m[4]) } : null;
  if (m[5] !== undefined) return { kind: m[5] === 'time' ? 'time' : 'datetime', precision: Number(m[6]) };
  switch (m[1]) {
    case 'smallint':
      return { kind: 'i16' };
    case 'integer':
      return { kind: 'i32' };
    case 'bigint':
      return { kind: 'i64' };
    case 'boolean':
      return { kind: 'bool' };
    case 'double precision':
      return { kind: 'f64' };
    case 'text':
      return collation === 'C' ? { kind: 'text' } : null;
    case 'bytea':
      return { kind: 'bytes' };
    case 'uuid':
      return { kind: 'uuid' };
    case 'date':
      return { kind: 'date' };
  }
  return null;
}

/** pg_get_expr의 default를 dbspec literal이나 now로 읽는다. 읽을 수 없으면 null이다. */
function postgresDefault(text: string, type: DbspecType): string | null {
  if (text === 'statement_timestamp()') return type.kind === 'datetime' ? 'now' : null;
  const m = LITERAL_PATTERN.exec(text);
  if (m !== null) {
    const value = m[1]!.replaceAll("''", "'");
    switch (type.kind) {
      case 'i16':
      case 'i32':
      case 'i64':
      case 'decimal':
      case 'f64':
        return value;
    }
    return quote(value);
  }
  if (text === 'true' || text === 'false') return type.kind === 'bool' ? text : null;
  if (NUMBER_PATTERN.test(text)) return text;
  return null;
}

function postgresAction(code: string): DbspecAction | null {
  switch (code) {
    case 'r':
      return 'restrict';
    case 'c':
      return 'cascade';
    case 'n':
      return 'set_null';
  }
  return null;
}

function postgresKind(contype: string): string {
  switch (contype) {
    case 'p':
    case 'u':
      return 'unique';
    case 'f':
      return 'foreign_key';
    case 'c':
      return 'check';
  }
  return 'index';
}
