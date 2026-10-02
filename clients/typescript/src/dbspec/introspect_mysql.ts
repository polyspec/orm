// MySQL의 현재 database를 catalog으로 읽는다 (docs/dialects.md "Introspection").
// 모든 query는 현재 database 전체를 한 번에 읽는다.
import { actionName, Catalog, cut, quote, tableTypes, type CatalogQuery, type IColumn, type IForeignKey, type IKey, type ITable } from './introspect_catalog.js';
import { CheckDecodeError, decodeCheck } from './introspect_check.js';
import { recognizeTriggers, type ITrigger } from './introspect_trigger.js';
import type { DbspecType } from './model.js';
import { UUID_PATTERN } from './render.js';

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
// CHECK_CONSTRAINTS와 TABLE_CONSTRAINTS의 join은 table 수에 비례해 느려지므로(2000 table에서
// 60초 이상) 두 query로 읽고 이름으로 잇는다. MySQL의 CHECK 이름은 database 안에서 유일하다.
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
  // table: column: renderer CHECK가 있어야 정해지는 type 후보
  const pending = new Map<string, Map<string, string>>();
  for (const r of await query(COLUMNS_QUERY)) {
    const [table, name, columnType, nullable, dflt] = [r.text(0), r.text(1), r.text(2), r.text(3), r.nullableText(4)];
    let extra = r.text(5);
    const [charset, collation, generation] = [r.text(6), r.text(7), r.text(8)];
    const t = c.table(table);
    if (t === undefined) continue;
    const read = mysqlType(columnType, charset, collation);
    if (read === null || generation !== '') {
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
    columns.get(table)!.set(name, col);
    if (read.needsCheck !== '') {
      if (!pending.has(table)) pending.set(table, new Map());
      pending.get(table)!.set(name, read.needsCheck);
    }
  }
  await readIndexes(query, c);
  await readForeignKeys(query, c);
  const checked = new Map<string, Set<string>>();
  const clauses = new Map<string, string>();
  for (const r of await query(CHECK_CLAUSES_QUERY)) clauses.set(r.text(0), r.text(1));
  for (const r of await query(CHECKS_QUERY)) {
    const [table, name, enforced] = [r.text(0), r.text(1), r.text(2)];
    const clause = clauses.get(name);
    if (clause === undefined) throw new Error(`check ${table}.${name} has no CHECK_CLAUSE`);
    const t = c.table(table);
    if (t === undefined) continue;
    if (enforced !== 'YES') {
      c.report('check', table, name, 'the check is not enforced');
      continue;
    }
    const [owner, column, generated] = cut(name, '$');
    if (generated) {
      const col = columns.get(table)?.get(column);
      if (owner !== table || col === undefined || withoutIntroducers(clause) !== withoutIntroducers(rendererCheck(col))) {
        c.report('check', table, name, `the check ${clause} is not the renderer CHECK`);
        continue;
      }
      if (!checked.has(table)) checked.set(table, new Set());
      checked.get(table)!.add(column);
      continue;
    }
    let predicate: string;
    try {
      predicate = decodeCheck('mysql', clause, tableTypes(t));
    } catch (error) {
      if (!(error instanceof CheckDecodeError)) throw error;
      c.report('check', table, name, error.message);
      continue;
    }
    t.checks.push({ name, predicate });
  }
  // renderer CHECK이 있어야 하는 type은 그 CHECK이 없으면 dbspec type이 아니다.
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
 * COLUMN_TYPE과 character set, collation을 dbspec type으로 읽는다. needsCheck는
 * renderer CHECK이 있어야 그 type이 되는 경우의 catalog type이다. dbspec type이
 * 아니면 null이다.
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
 * character set introducer를 뺀 CHECK_CLAUSE다. ALTER TABLE은 CHECK_CLAUSE를 다시
 * 쓰며 introducer를 바꾸거나 빼므로(probe mysql.check.alter_rewrites_introducers)
 * renderer CHECK은 introducer 없이 비교한다. 이 template의 literal은 ASCII이므로
 * 의미가 같다.
 */
function withoutIntroducers(clause: string): string {
  // ALTER TABLE은 time(p) column과 만나는 time literal에 0으로 된 p 자리 소수도 붙이므로
  // (probe mysql.check.alter_writes_time_precision) 그 소수도 뺀다.
  return clause.replace(/_[a-z0-9]+\\'/g, "\\'").replace(/\\'(\d\d:\d\d:\d\d)\.0+\\'/g, "\\'$1\\'");
}

/** renderer CHECK이 CHECK_CLAUSE에 남는 형식이다 (docs/dialects.md "Introspection", "Checks"). */
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

/** DEFAULT_GENERATED default가 그 column의 renderer 시각 default인지 알려 준다. */
function mysqlNow(text: string, type: DbspecType): boolean {
  if (type.kind !== 'datetime') return false;
  if (type.precision === 0) return text === 'CURRENT_TIMESTAMP';
  return text === `CURRENT_TIMESTAMP(${type.precision})`;
}

/** escape를 푼 COLUMN_DEFAULT 값을 dbspec literal로 쓴다. parse가 canonical form과 유효성을 정한다. */
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
    while (j < rows.length && rows[j]!.table === rows[i]!.table && rows[j]!.name === rows[i]!.name) j++;
    const group = rows.slice(i, j);
    i = j;
    const first = group[0]!;
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
  // 보고한 key의 나머지 column row는 건너뛴다.
  let skipped = '';
  for (const r of await query(FOREIGN_KEYS_QUERY)) {
    const [table, name, refTable, onDelete, onUpdate, match, column, refColumn] = [0, 1, 2, 3, 4, 5, 6, 7].map(i => r.text(i)) as [
      string, string, string, string, string, string, string, string,
    ];
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

/** trigger를 renderer statement 형식으로 다시 쓰고 알아본다. */
async function readTriggers(query: CatalogQuery, c: Catalog): Promise<void> {
  const triggers = new Map<string, ITrigger[]>();
  for (const r of await query(TRIGGERS_QUERY)) {
    const [table, name, timing, event, statement] = [r.text(0), r.text(1), r.text(2), r.text(3), r.text(4)];
    if (!triggers.has(table)) triggers.set(table, []);
    triggers.get(table)!.push({ name, statements: [`CREATE TRIGGER \`${name}\` ${timing} ${event} ON \`${table}\` FOR EACH ROW ${statement}`] });
  }
  recognizeTriggers(c, 'mysql', triggers);
}
