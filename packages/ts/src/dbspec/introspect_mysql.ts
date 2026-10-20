// Reads MySQL's current database as a catalog (docs/spec/dialects.md "Introspection").
// Every query reads the whole current database at once.
import { present } from '../present.js';
import { actionName, Catalog, quote, tableTypes, type CatalogQuery, type IColumn, type IForeignKey, type IKey, type ITable } from './introspect_catalog.js';
import { addCheck, markChecked } from './introspect_check.js';
import { recognizeTriggers, type ITrigger } from './introspect_trigger.js';
import type { DbspecType } from './model.js';
import { UUID_PATTERN } from './render.js';
import { renderedColumn } from './names.js';

const TABLES_QUERY = `SELECT TABLE_NAME, TABLE_TYPE, IFNULL(CREATE_OPTIONS, '') FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME`;
const COLUMNS_QUERY = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
IFNULL(CHARACTER_SET_NAME, ''), IFNULL(COLLATION_NAME, ''), IFNULL(GENERATION_EXPRESSION, '')
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME, ORDINAL_POSITION`;
const INDEXES_QUERY = `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, IFNULL(COLUMN_NAME, ''), IFNULL(COLLATION, 'A'),
SUB_PART IS NOT NULL, EXPRESSION IS NOT NULL, INDEX_TYPE FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;
const FOREIGN_KEYS_QUERY = `SELECT rc.TABLE_NAME, rc.CONSTRAINT_NAME, rc.REFERENCED_TABLE_NAME, rc.DELETE_RULE, rc.UPDATE_RULE,
rc.MATCH_OPTION, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS rc
JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND k.TABLE_NAME = rc.TABLE_NAME
WHERE rc.CONSTRAINT_SCHEMA = DATABASE() ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME, k.ORDINAL_POSITION`;
// Joining CHECK_CONSTRAINTS and TABLE_CONSTRAINTS slows down in proportion to the number of tables (over
// 60 seconds at 2000 tables), so two queries are read and joined by name. MySQL's CHECK names are unique within a database.
const CHECK_CLAUSES_QUERY = `SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME`;
const CHECKS_QUERY = `SELECT TABLE_NAME, CONSTRAINT_NAME, ENFORCED FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' ORDER BY TABLE_NAME, CONSTRAINT_NAME`;
const TRIGGERS_QUERY = `SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`;
const ROUTINES_QUERY = `SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME`;
const EVENTS_QUERY = `SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME`;

const TYPE_PATTERN =
  /^(smallint|int|bigint|tinyint\(1\)|double|longtext|longblob|date|char\(36\)|time|datetime)(?:\((\d+)\))?$|^(decimal)\((\d+),(\d+)\)$|^(varchar)\((\d+)\)$/;

export async function readMySQL(query: CatalogQuery): Promise<Catalog> {
  const c = new Catalog();
  for (const r of await query(TABLES_QUERY)) {
    const [name, kind, options] = [r.text(0), r.text(1), r.text(2)];
    if (kind !== 'BASE TABLE') {
      c.report('view', name, name, `a ${kind.toLowerCase()} has no dbspec definition`);
    } else if (options.includes('partitioned')) {
      c.report('partition', name, name, 'a partitioned table has no dbspec definition');
    } else {
      c.addTable(name);
    }
  }
  const columns = new Map<string, Map<string, IColumn>>();
  // table: column: renderer CHECK candidate types that are determined only when a CHECK exists
  const pending = new Map<string, Map<string, string>>();
  for (const r of await query(COLUMNS_QUERY)) {
    const [table, name, columnType, nullable, dflt] = [r.text(0), r.text(1), r.text(2), r.text(3), r.nullableText(4)];
    let extra = r.text(5);
    const [charset, collation, generation] = [r.text(6), r.text(7), r.text(8)];
    const t = c.table(table);
    if (t === undefined) continue;
    if (generation !== '') {
      c.report('column', table, name, 'a generated column has no dbspec definition');
      continue;
    }
    const read = mysqlType(columnType, charset, collation);
    if (read === null) {
      c.report('column', table, name, `type ${columnType} ${charset} ${collation} has no dbspec type`);
      continue;
    }
    const col: IColumn = { name, type: read.type, nullable: nullable === 'YES', identity: false, dflt: '' };
    extra = extra.trim();
    if (extra === 'auto_increment') {
      col.identity = true;
    } else if (extra === 'DEFAULT_GENERATED' && dflt !== null) {
      if (!mysqlNow(dflt, read.type)) {
        c.report('column', table, name, `default ${dflt} is not a dbspec default`);
        continue;
      }
      col.dflt = 'now';
    } else if (extra !== '') {
      c.report('column', table, name, `extra ${extra} has no dbspec definition`);
      continue;
    } else if (dflt !== null) {
      col.dflt = mysqlDefault(dflt, read.type);
    }
    t.columns.push(col);
    if (!columns.has(table)) columns.set(table, new Map());
    present(columns.get(table), 'columns.get(table)').set(name, col);
    if (read.needsCheck !== '') {
      if (!pending.has(table)) pending.set(table, new Map());
      present(pending.get(table), 'pending.get(table)').set(name, read.needsCheck);
    }
  }
  await readIndexes(query, c);
  await readForeignKeys(query, c);
  const checked = new Map<string, Set<string>>();
  const clauses = new Map<string, string>();
  for (const r of await query(CHECK_CLAUSES_QUERY)) clauses.set(r.text(0), r.text(1));
  const shown = new Map<string, Map<string, string>>();
  for (const r of await query(CHECKS_QUERY)) {
    const [table, name, enforced] = [r.text(0), r.text(1), r.text(2)];
    const stored = clauses.get(name);
    if (stored === undefined) throw new Error(`check ${table}.${name} has no CHECK_CLAUSE`);
    const clause = hasNonAscii(stored) ? await shownCheck(query, table, name, shown) : stored;
    const t = c.table(table);
    if (t === undefined) continue;
    if (enforced !== 'YES') {
      c.report('check', table, name, 'the check is not enforced');
      continue;
    }
    if (name.includes('$')) {
      const column = renderedColumn(table, name, columns.get(table)?.keys() ?? []);
      const col = column === null ? undefined : columns.get(table)?.get(column);
      if (column === null || col === undefined || withoutIntroducers(clause) !== withoutIntroducers(rendererCheck(col))) {
        c.report('check', table, name, `the check ${clause} is not the renderer CHECK`);
        continue;
      }
      markChecked(checked, table, column);
      continue;
    }
    addCheck(c, table, t, 'mysql', name, clause, tableTypes(t));
  }
  // A type that requires the renderer CHECK is not a dbspec type without that CHECK.
  for (const [table, cols] of pending) {
    for (const [column, need] of cols) {
      if (checked.get(table)?.has(column)) continue;
      c.report('column', table, column, `${need} without its renderer CHECK has no dbspec type`);
      c.dropColumn(table, column);
    }
  }
  await readTriggers(query, c);
  for (const [kind, sql] of [
    ['routine', ROUTINES_QUERY],
    ['event', EVENTS_QUERY],
  ] as const) {
    for (const r of await query(sql)) {
      c.report(kind, '', r.text(0), `a ${kind} has no dbspec definition`);
    }
  }
  return c;
}

/**
 * Reads COLUMN_TYPE, the character set and the collation as a dbspec type. needsCheck is
 * the catalog type for the case where the type becomes a dbspec type only when a renderer CHECK exists. The dbspec type
 * is null otherwise.
 */
function mysqlType(columnType: string, charset: string, collation: string): { type: DbspecType; needsCheck: string } | null {
  const m = TYPE_PATTERN.exec(columnType);
  if (m === null) return null;
  const g = (i: number): string => m[i] ?? '';
  const text = charset === 'utf8mb4' && collation === 'utf8mb4_0900_bin';
  const result = (type: DbspecType, needsCheck: string, ok: boolean) => (ok ? { type, needsCheck } : null);
  if (g(3) === 'decimal') return result({ kind: 'decimal', precision: Number(g(4)), scale: Number(g(5)) }, '', charset === '');
  if (g(6) === 'varchar') return result({ kind: 'varchar', length: Number(g(7)) }, '', text);
  const precision = g(2) === '' ? 0 : Number(g(2));
  switch (g(1)) {
    case 'smallint':
      return result({ kind: 'i16' }, '', g(2) === '');
    case 'int':
      return result({ kind: 'i32' }, '', g(2) === '');
    case 'bigint':
      return result({ kind: 'i64' }, '', g(2) === '');
    case 'tinyint(1)':
      return result({ kind: 'bool' }, columnType, true);
    case 'double':
      return result({ kind: 'f64' }, '', g(2) === '');
    case 'longtext':
      return result({ kind: 'text' }, '', text);
    case 'longblob':
      return result({ kind: 'bytes' }, '', true);
    case 'char(36)':
      return result({ kind: 'uuid' }, columnType, charset === 'ascii' && collation === 'ascii_bin');
    case 'date':
      return result({ kind: 'date' }, '', g(2) === '');
    case 'time':
      return result({ kind: 'time', precision }, columnType, true);
    case 'datetime':
      return result({ kind: 'datetime', precision }, '', true);
  }
  return null;
}

/**
 * The CHECK_CLAUSE with the character set introducer removed. ALTER TABLE writes the CHECK_CLAUSE again
 * and changes or removes the introducers when it does so (probe mysql.check.alter_rewrites_introducers),
 * so the renderer CHECK is compared without introducers. The literals of this template are ASCII, so
 * they have the same meaning.
 */
function withoutIntroducers(clause: string): string {
  // ALTER TABLE also attaches a zero-valued fractional part of p digits to time literals that meet a time(p) column, so
  // (probe mysql.check.alter_writes_time_precision) that fractional part is removed too.
  return clause.replace(/_[a-z0-9]+\\'/g, "\\'").replace(/\\'(\d\d:\d\d:\d\d)\.0+\\'/g, "\\'$1\\'");
}

/** True if the CHECK_CLAUSE has a byte of 0x80 or more. MySQL 8.4 shows non-ASCII literals encoded twice. */
function hasNonAscii(clause: string): boolean {
  for (let i = 0; i < clause.length; i++) if (clause.charCodeAt(i) > 0x7f) return true;
  return false;
}

/**
 * Reads from SHOW CREATE TABLE the body of a check whose CHECK_CLAUSE garbled non-ASCII text. For each table
 * reads SHOW CREATE TABLE only once and collects into shown. The result is in CHECK_CLAUSE form.
 */
async function shownCheck(
  query: CatalogQuery,
  table: string,
  name: string,
  shown: Map<string, Map<string, string>>,
): Promise<string> {
  let checks = shown.get(table);
  if (checks === undefined) {
    const rows = await query('SHOW CREATE TABLE `' + table.replace(/`/g, '``') + '`');
    const [row] = rows;
    if (row === undefined) throw new Error(`SHOW CREATE TABLE ${table} returned no row`);
    checks = createChecks(row.text(1));
    shown.set(table, checks);
  }
  const clause = checks.get(name);
  if (clause === undefined) throw new Error(`check ${table}.${name} has no CHECK in SHOW CREATE TABLE`);
  return clause;
}

/** Returns the bodies of all CHECKs in a SHOW CREATE TABLE statement, by name, in CHECK_CLAUSE form. */
export function createChecks(create: string): Map<string, string> {
  const checks = new Map<string, string>();
  const pattern = /CONSTRAINT `([^`]+)` CHECK \(/g;
  for (let m = pattern.exec(create); m !== null; m = pattern.exec(create)) {
    const name = m[1];
    if (name === undefined) throw new Error('the CHECK pattern captures no constraint name');
    const start = m.index + m[0].length;
    let depth = 1;
    for (let i = start; i < create.length; i++) {
      const c = create[i];
      if (c === "'") {
        for (i++; i < create.length && create[i] !== "'"; i++) {
          if (create[i] === '\\') i++;
        }
      } else if (c === '(') {
        depth++;
      } else if (c === ')' && --depth === 0) {
        checks.set(name, create.slice(start, i).replace(/[\\']/g, (ch) => (ch === '\\' ? '\\\\' : "\\'")));
        break;
      }
    }
  }
  return checks;
}

/** The form in which a renderer CHECK remains in CHECK_CLAUSE (docs/spec/dialects.md "Introspection", "Checks"). */
function rendererCheck(col: IColumn): string {
  const c = '`' + col.name + '`';
  switch (col.type.kind) {
    case 'bool':
      return `(${c} in (0,1))`;
    case 'uuid':
      return `regexp_like(${c},_utf8mb4\\'${UUID_PATTERN}\\',_utf8mb4\\'c\\')`;
    case 'time':
      return `((${c} >= _utf8mb4\\'00:00:00\\') and (${c} < _utf8mb4\\'24:00:00\\'))`;
  }
  return '';
}

/** Tells whether a DEFAULT_GENERATED default is the renderer's time default for that column. */
function mysqlNow(text: string, type: DbspecType): boolean {
  if (type.kind !== 'datetime') return false;
  if (type.precision === 0) return text === 'CURRENT_TIMESTAMP';
  return text === `CURRENT_TIMESTAMP(${type.precision})`;
}

/** Writes the COLUMN_DEFAULT value with its escape removed as a dbspec literal. parse decides the canonical form and validity. */
function mysqlDefault(value: string, type: DbspecType): string {
  switch (type.kind) {
    case 'bool':
      if (value === '1') return 'true';
      if (value === '0') return 'false';
      return quote(value);
    case 'i16':
    case 'i32':
    case 'i64':
    case 'decimal':
    case 'f64':
      return value;
  }
  return quote(value);
}

async function readIndexes(query: CatalogQuery, c: Catalog): Promise<void> {
  const rows = (await query(INDEXES_QUERY)).map(r => ({
    table: r.text(0),
    name: r.text(1),
    unique: r.integer(2) === 0,
    column: r.text(3),
    collation: r.text(4),
    part: r.flag(5),
    expression: r.flag(6),
    kind: r.text(7),
  }));
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && present(rows[j], 'rows[j]').table === present(rows[i], 'rows[i]').table && present(rows[j], 'rows[j]').name === present(rows[i], 'rows[i]').name) j++;
    const group = rows.slice(i, j);
    i = j;
    const first = present(group[0], 'group[0]');
    const t = c.table(first.table);
    if (t === undefined) continue;
    const key: IKey = { name: first.name, columns: [], desc: [] };
    let supported = first.kind === 'BTREE';
    for (const x of group) {
      if (x.part || x.expression || x.column === '') supported = false;
      key.columns.push(x.column);
      key.desc.push(x.collation === 'D');
    }
    if (!supported) {
      c.report('index', t.name, key.name, `a prefix, expression or ${first.kind.toLowerCase()} index has no dbspec definition`);
    } else if (key.name === 'PRIMARY') {
      t.primary = key.columns;
    } else if (key.name.includes('$')) {
      c.report('index', t.name, key.name, 'the name contains $');
    } else if (first.unique) {
      t.uniques.push(key);
    } else {
      t.indexes.push(key);
    }
  }
}

async function readForeignKeys(query: CatalogQuery, c: Catalog): Promise<void> {
  let current: { fk: IForeignKey; table: ITable } | null = null;
  // The remaining column rows of the reported key are skipped.
  let skipped = '';
  for (const r of await query(FOREIGN_KEYS_QUERY)) {
    const [table, name, refTable, onDelete, onUpdate, match, column, refColumn] = [r.text(0), r.text(1), r.text(2), r.text(3), r.text(4), r.text(5), r.text(6), r.text(7)];
    if (current !== null && (current.fk.name !== name || current.table.name !== table)) {
      current.table.fks.push(current.fk);
      current = null;
    }
    if (skipped === `${table}\x00${name}`) continue;
    skipped = '';
    if (current === null) {
      const t = c.table(table);
      const del = actionName(onDelete);
      const upd = actionName(onUpdate);
      if (t === undefined) continue;
      if (del === null || upd === null || match !== 'NONE') {
        c.report('foreign_key', table, name, `actions ${onDelete}, ${onUpdate} or match ${match} have no dbspec definition`);
        skipped = `${table}\x00${name}`;
        continue;
      }
      current = { fk: { name, columns: [], table: refTable, refs: [], onDelete: del, onUpdate: upd }, table: t };
    }
    current.fk.columns.push(column);
    current.fk.refs.push(refColumn);
  }
  if (current !== null) current.table.fks.push(current.fk);
}

/** Rewrites a trigger in the renderer statement form and recognizes it. */
async function readTriggers(query: CatalogQuery, c: Catalog): Promise<void> {
  const triggers = new Map<string, ITrigger[]>();
  for (const r of await query(TRIGGERS_QUERY)) {
    const [table, name, timing, event, statement] = [r.text(0), r.text(1), r.text(2), r.text(3), r.text(4)];
    if (!triggers.has(table)) triggers.set(table, []);
    present(triggers.get(table), 'triggers.get(table)').push({ name, statements: [`CREATE TRIGGER \`${name}\` ${timing} ${event} ON \`${table}\` FOR EACH ROW ${statement}`] });
  }
  recognizeTriggers(c, 'mysql', triggers);
}
