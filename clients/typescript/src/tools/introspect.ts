// Reads a live database catalog and renders it as a Mermaid diagram
// (`orm-gen import`); the migration tools build their live manifest from the
// same diagram.
import { quoted } from '../schema/json.js';
import { triggerBodiesQuery, triggerDirectives, triggerMarker } from '../engine/triggers.js';
import { buildManifest, plural, type SchemaManifest } from '../schema/build.js';
import { parseDiagram, trimSpace, type DColumn, type DRelation, type Diagram } from '../schema/mermaid.js';
import type { ToolDb } from './db.js';

/** The marker of a column without a default. */
const noDefault = '\x00';

export interface ImpColumn { name: string; type: string; default: string; extra: string; key: string; nullable: boolean; comment: string; }
export interface ImpIndex { name: string; unique: boolean; fulltext: boolean; columns: string[]; }
export interface ImpForeignKey { name: string; columns: string[]; target: string; targetColumns: string[]; onDelete: string; }
export interface ImpCheck { name: string; expr: string; }
export interface ImpTable { name: string; comment: string; columns: ImpColumn[]; indexes: ImpIndex[]; foreignKeys: ImpForeignKey[]; checks: ImpCheck[]; }

function newTable(name: string): ImpTable {
  return { name, comment: '', columns: [], indexes: [], foreignKeys: [], checks: [] };
}

function s(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function n(value: unknown): number {
  return Number(value);
}

function byteSorted(names: string[]): string[] {
  return names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function addForeignKey(tb: ImpTable, name: string, target: string, onDelete: string, column: string, targetColumn: string): void {
  const last = tb.foreignKeys[tb.foreignKeys.length - 1];
  const fk = last && last.name === name ? last : (tb.foreignKeys.push({ name, columns: [], target, targetColumns: [], onDelete }), tb.foreignKeys[tb.foreignKeys.length - 1]!);
  fk.columns.push(column);
  fk.targetColumns.push(targetColumn);
}

/** Reads the tables of the current database, optionally only the named ones. */
const reMySQLStringDefault = /^_[A-Za-z0-9]+\\'(.*)\\'$/;

/**
 * The literal of an expression default such as DEFAULT ('x'), which MySQL
 * reports as _utf8mb4\\'x\\'; the expression text escapes the literal.
 */
function mysqlExpressionLiteral(def: string): string | undefined {
  const m = reMySQLStringDefault.exec(def);
  if (m) return mysqlUnescape(mysqlUnescape(m[1]!));
  return isNumber(def) ? def : undefined;
}

function mysqlUnescape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) i++;
    out += text[i];
  }
  return out;
}

export async function readTables(db: ToolDb, only?: Set<string>): Promise<ImpTable[]> {
  if (db.driver === 'postgres') return readTablesPG(db, only);
  if (db.driver === 'sqlite') {
    const tables = await readTablesSQLite(db);
    return only ? tables.filter(t => only.has(t.name)) : tables;
  }
  const byName = new Map<string, ImpTable>();
  for (const row of await db.query(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY, COLUMN_COMMENT
		FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`)) {
    const table = s(row[0]);
    if (only && !only.has(table)) continue;
    const c: ImpColumn = {
      name: s(row[1]), type: s(row[2]), nullable: s(row[3]) === 'YES', default: row[4] === null ? noDefault : s(row[4]),
      extra: s(row[5]), key: s(row[6]), comment: s(row[7]),
    };
    if (row[4] !== null && c.extra.includes('DEFAULT_GENERATED')) {
      const literal = mysqlExpressionLiteral(c.default);
      if (literal !== undefined) {
        c.default = literal;
        c.extra = trimSpace(c.extra.replace('DEFAULT_GENERATED', ''));
      }
    }
    let tb = byName.get(table);
    if (!tb) { tb = newTable(table); byName.set(table, tb); }
    tb.columns.push(c);
  }
  for (const row of await db.query('SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')) {
    const tb = byName.get(s(row[0]));
    if (tb) tb.comment = s(row[1]);
  }
  for (const row of await db.query(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`)) {
    const tb = byName.get(s(row[0]));
    const name = s(row[1]);
    if (!tb || name === 'PRIMARY') continue;
    const last = tb.indexes[tb.indexes.length - 1];
    if (last && last.name === name) { last.columns.push(s(row[4])); continue; }
    tb.indexes.push({ name, unique: n(row[2]) === 0, fulltext: s(row[3]) === 'FULLTEXT', columns: [s(row[4])] });
  }
  for (const row of await db.query(`SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
		k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
		FROM information_schema.KEY_COLUMN_USAGE k
		JOIN information_schema.REFERENTIAL_CONSTRAINTS r
		  ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
		WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
		ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`)) {
    const tb = byName.get(s(row[0]));
    if (!tb) continue;
    addForeignKey(tb, s(row[1]), s(row[3]), importDeleteAction(s(row[5])), s(row[2]), s(row[4]));
  }
  for (const row of await db.query(`SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
		FROM information_schema.TABLE_CONSTRAINTS tc
		JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
		WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.CONSTRAINT_TYPE='CHECK'
		ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`)) {
    byName.get(s(row[0]))?.checks.push({ name: s(row[1]), expr: s(row[2]) });
  }
  return byteSorted([...byName.keys()]).map(name => byName.get(name)!);
}

async function readTablesPG(db: ToolDb, only?: Set<string>): Promise<ImpTable[]> {
  const byName = new Map<string, ImpTable>();
  for (const row of await db.query(`SELECT c.table_name, c.column_name, c.data_type, c.character_maximum_length,
		       c.numeric_precision, c.numeric_scale, c.datetime_precision, c.udt_name,
		       c.is_nullable, c.column_default, c.is_identity, coalesce(d.description, '')
		  FROM information_schema.columns c
		  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
		  LEFT JOIN pg_catalog.pg_class cl ON cl.relname = c.table_name
		  LEFT JOIN pg_catalog.pg_description d ON d.objoid = cl.oid AND d.objsubid = c.ordinal_position
		 WHERE c.table_schema = current_schema()
		 ORDER BY c.table_name, c.ordinal_position`)) {
    const table = s(row[0]);
    if (only && !only.has(table)) continue;
    const def = row[9];
    const c: ImpColumn = {
      name: s(row[1]), type: pgTypeText(s(row[2]), s(row[7]), row[3], row[4], row[5], row[6]),
      nullable: s(row[8]) === 'YES', comment: s(row[11]), default: noDefault, extra: '', key: '',
    };
    if (s(row[10]) === 'YES' || (def !== null && s(def).startsWith('nextval('))) c.extra = 'auto_increment';
    else if (def !== null) c.default = pgDefaultText(s(def));
    let tb = byName.get(table);
    if (!tb) { tb = newTable(table); byName.set(table, tb); }
    tb.columns.push(c);
  }
  for (const row of await db.query(`SELECT c.relname, coalesce(d.description, '')
		FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname=current_schema()
		LEFT JOIN pg_catalog.pg_description d ON d.objoid=c.oid AND d.objsubid=0
		WHERE c.relkind='r'`)) {
    const tb = byName.get(s(row[0]));
    if (tb) tb.comment = s(row[1]);
  }
  for (const row of await db.query(`SELECT cl.relname AS table_name, ic.relname AS index_name, ix.indisunique, ix.indisprimary,
		       am.amname, a.attname, k.ord
		  FROM pg_class cl
		  JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = current_schema()
		  JOIN pg_index ix ON ix.indrelid = cl.oid
		  JOIN pg_class ic ON ic.oid = ix.indexrelid
		  JOIN pg_am am ON am.oid = ic.relam
		  JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
		  JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
		 ORDER BY cl.relname, ic.relname, k.ord`)) {
    const table = s(row[0]);
    const tb = byName.get(table);
    if (!tb) continue;
    const col = s(row[5]);
    if (row[3] === true) {
      for (const c of tb.columns) if (c.name === col) c.key = 'PRI';
      continue;
    }
    const unique = row[2] === true;
    const logicalName = postgresLogicalIndexName(table, s(row[1]), unique);
    const last = tb.indexes[tb.indexes.length - 1];
    if (last && last.name === logicalName) { last.columns.push(col); continue; }
    tb.indexes.push({ name: logicalName, unique, fulltext: s(row[4]) === 'gin', columns: [col] });
  }
  for (const row of await db.query(`SELECT child.relname, con.conname, ca.attname, parent.relname, pa.attname, con.confdeltype, ck.ord
		FROM pg_constraint con
		JOIN pg_class child ON child.oid=con.conrelid
		JOIN pg_namespace n ON n.oid=child.relnamespace AND n.nspname=current_schema()
		JOIN pg_class parent ON parent.oid=con.confrelid
		JOIN LATERAL unnest(con.conkey) WITH ORDINALITY ck(attnum, ord) ON true
		JOIN LATERAL unnest(con.confkey) WITH ORDINALITY pk(attnum, ord) ON pk.ord=ck.ord
		JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=ck.attnum
		JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=pk.attnum
		WHERE con.contype='f'
		ORDER BY child.relname, con.conname, ck.ord`)) {
    const tb = byName.get(s(row[0]));
    if (!tb) continue;
    addForeignKey(tb, s(row[1]), s(row[3]), postgresDeleteAction(s(row[5])), s(row[2]), s(row[4]));
  }
  for (const row of await db.query(`SELECT child.relname, con.conname, pg_get_constraintdef(con.oid)
		FROM pg_constraint con
		JOIN pg_class child ON child.oid=con.conrelid
		JOIN pg_namespace n ON n.oid=child.relnamespace AND n.nspname=current_schema()
		WHERE con.contype='c' ORDER BY child.relname, con.conname`)) {
    byName.get(s(row[0]))?.checks.push({ name: s(row[1]), expr: postgresCheckExpr(s(row[2])) });
  }
  for (const row of await db.query(`SELECT cl.relname, ic.relname, pg_get_indexdef(ic.oid)
		FROM pg_class cl
		JOIN pg_namespace n ON n.oid=cl.relnamespace AND n.nspname=current_schema()
		JOIN pg_index ix ON ix.indrelid=cl.oid
		JOIN pg_class ic ON ic.oid=ix.indexrelid
		JOIN pg_am am ON am.oid=ic.relam
		WHERE am.amname='gin'
		ORDER BY cl.relname, ic.relname`)) {
    const table = s(row[0]);
    const tb = byName.get(table);
    if (!tb) continue;
    let columns: string[];
    try { columns = postgresFulltextColumns(s(row[2])); } catch (error) { throw new Error(`table ${table} index ${s(row[1])}: ${(error as Error).message}`); }
    tb.indexes.push({ name: s(row[1]), unique: false, fulltext: true, columns });
  }
  return byteSorted([...byName.keys()]).map(name => byName.get(name)!);
}

/** Strips the CHECK keyword from pg_get_constraintdef. */
export function postgresCheckExpr(definition: string): string {
  let expr = definition.trim();
  if (expr.length >= 5 && expr.slice(0, 5).toUpperCase() === 'CHECK') expr = expr.slice(5).trim();
  return expr;
}

/** Whether a SQLite column default is the one the DDL writes for =now. */
function sqliteClockDefault(value: string): boolean {
  let def = value.trim();
  while (def.length > 1 && def[0] === '(' && def[def.length - 1] === ')') def = def.slice(1, -1).trim();
  return def.toUpperCase() === 'CURRENT_TIMESTAMP' || def === "strftime('%Y-%m-%d %H:%M:%f', 'now') || '000'";
}

/** Whether the CREATE TABLE text declares column as INTEGER PRIMARY KEY AUTOINCREMENT. */
function sqliteAutoIncrement(createSQL: string, column: string): boolean {
  const fields = createSQL.toUpperCase().split(/[ \t\n\v\f\r\u0085\u00a0]+/).filter(Boolean);
  const upper = column.toUpperCase();
  const names = new Set([`"${upper}"`, `\`${upper}\``, upper, `[${upper}]`]);
  for (let i = 0; i + 4 < fields.length; i++) {
    const name = fields[i]!.replace(/^[(,]+/, '');
    if (names.has(name) && fields[i + 1] === 'INTEGER' && fields[i + 2] === 'PRIMARY' && fields[i + 3] === 'KEY' && fields[i + 4]!.replace(/[,)]+$/, '') === 'AUTOINCREMENT') return true;
  }
  return false;
}

/** Reads the tables of a SQLite database. */
export async function readTablesSQLite(db: ToolDb): Promise<ImpTable[]> {
  const out: ImpTable[] = [];
  for (const row of await db.query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'orm_schema_migrations' AND name <> 'orm_schema_comments' AND name <> 'orm__context' ORDER BY name")) {
    const name = s(row[0]);
    const createSQL = s(row[1]);
    const t = newTable(name);
    t.checks = sqliteChecks(name, createSQL);
    const qname = name.replaceAll("'", "''");
    for (const col of await db.query(`PRAGMA table_info('${qname}')`)) {
      const pk = n(col[5]);
      const def = col[4] === null ? noDefault : sqliteClockDefault(s(col[4])) ? 'CURRENT_TIMESTAMP' : s(col[4]);
      t.columns.push({
        name: s(col[1]), type: s(col[2]), nullable: n(col[3]) === 0 && pk === 0, default: def,
        key: pk > 0 ? 'PRI' : '', extra: pk > 0 && sqliteAutoIncrement(createSQL, s(col[1])) ? 'auto_increment' : '', comment: '',
      });
    }
    for (const idx of await db.query(`PRAGMA index_list('${qname}')`)) {
      const indexName = s(idx[1]);
      const unique = n(idx[2]) !== 0;
      if (s(idx[3]) === 'pk') continue;
      const logicalName = unique ? indexName : (indexName.startsWith(name + '_') ? indexName.slice(name.length + 1) : indexName);
      const ix: ImpIndex = { name: logicalName, unique, fulltext: false, columns: [] };
      for (const ic of await db.query(`PRAGMA index_info('${indexName.replaceAll("'", "''")}')`)) ix.columns.push(s(ic[2]));
      if (ix.columns.length > 0) t.indexes.push(ix);
    }
    const byId = new Map<number, number>();
    for (const fk of await db.query(`PRAGMA foreign_key_list('${qname}')`)) {
      const id = n(fk[0]);
      let position = byId.get(id);
      if (position === undefined) {
        position = t.foreignKeys.length;
        byId.set(id, position);
        t.foreignKeys.push({ name: `fk_${name}_${id}`, columns: [], target: s(fk[2]), targetColumns: [], onDelete: importDeleteAction(s(fk[6])) });
      }
      t.foreignKeys[position]!.columns.push(s(fk[3]));
      t.foreignKeys[position]!.targetColumns.push(s(fk[4]));
    }
    out.push(t);
  }
  let comments: unknown[][] | undefined;
  try { comments = await db.query('SELECT table_name, column_name, comment FROM orm_schema_comments'); } catch (error) {
    if (!(error as Error).message.toLowerCase().includes('no such table')) throw new Error(`sqlite schema comments: ${(error as Error).message}`);
  }
  for (const row of comments ?? []) {
    const t = out.find(table => table.name === s(row[0]));
    if (!t) continue;
    const column = s(row[1]);
    if (column === '') t.comment = s(row[2]);
    else for (const c of t.columns) if (c.name === column) c.comment = s(row[2]);
  }
  return out;
}

function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /^[_0-9a-zA-Z]$/.test(c);
}

function sqliteChecks(table: string, createSQL: string): ImpCheck[] {
  const checks: ImpCheck[] = [];
  for (let i = 0; i < createSQL.length; i++) {
    const ch = createSQL[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < createSQL.length; i++) {
        if (createSQL[i] === ch) {
          if (createSQL[i + 1] === ch) { i++; continue; }
          break;
        }
      }
      continue;
    }
    if (i + 5 > createSQL.length || createSQL.slice(i, i + 5).toUpperCase() !== 'CHECK' || (i > 0 && isIdentChar(createSQL[i - 1])) || isIdentChar(createSQL[i + 5])) continue;
    let j = i + 5;
    while (j < createSQL.length && ' \t\r\n'.includes(createSQL[j]!)) j++;
    if (j >= createSQL.length || createSQL[j] !== '(') throw new Error(`table ${table}: sqlite CHECK expression missing opening parenthesis`);
    let end: number;
    try { end = sqliteBalancedParen(createSQL, j); } catch (error) { throw new Error(`table ${table}: sqlite CHECK expression: ${(error as Error).message}`); }
    let name = `check_${table}_${checks.length + 1}`;
    const prefix = createSQL.slice(0, i).trim();
    const k = prefix.toUpperCase().lastIndexOf('CONSTRAINT ');
    if (k >= 0) {
      const candidate = prefix.slice(k + 'CONSTRAINT '.length).trim();
      if (candidate !== '' && !/[ ,()\t\r\n]/.test(candidate)) name = candidate.replace(/^[`"]+|[`"]+$/g, '');
    }
    checks.push({ name, expr: createSQL.slice(j + 1, end).trim() });
    i = end;
  }
  return checks;
}

export function sqliteBalancedParen(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) { /* skip quoted text */ }
      if (i >= text.length) throw new Error('unterminated quoted value');
    } else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced parentheses');
}

/** The parent table of a `<role>_<table>_seq` column, found without constraints. */
function fkTarget(col: string, tables: Set<string>): string {
  if (!col.endsWith('_seq')) return '';
  const parts = col.slice(0, -4).split('_');
  for (let i = 0; i < parts.length; i++) {
    const t = parts.slice(i).join('_');
    if (tables.has(t)) return t;
  }
  return '';
}

/** A catalog column type in diagram spelling, and whether it is unsigned. */
/** Names a text column that carries the json codec as jsontext. */
function importedJsonText(name: string, type: string): string {
  if (type === 'jsontext' || (!name.startsWith('json_') && !name.startsWith('jsons_'))) return type;
  return ['text', 'longtext', 'mediumtext', 'tinytext'].includes(type) ? 'jsontext' : type;
}

function mermaidType(type: string): [string, boolean] {
  let t = type.toLowerCase();
  const unsigned = t.endsWith(' unsigned');
  if (unsigned) t = t.slice(0, -' unsigned'.length);
  const i = t.indexOf('(');
  if (i >= 0 && t.endsWith(')')) {
    const inner = t.slice(i + 1, -1).replaceAll("'", '').replaceAll(',', '_');
    t = t.slice(0, i) + '(' + inner + ')';
  }
  return [t, unsigned];
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - [...value].length));
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const x = a ?? [];
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** Renders catalog tables as a diagram, keeping hand-written facts of `prev`. */
export function renderMermaid(ts: readonly ImpTable[], prev?: Diagram): string {
  const tables = new Set<string>();
  const primary = new Map<string, string[]>();
  for (const t of ts) {
    tables.add(t.name);
    for (const c of t.columns) if (c.key === 'PRI') primary.set(t.name, [...(primary.get(t.name) ?? []), c.name]);
  }
  const prevCols = new Map<string, DColumn>();
  const prevLabels = new Map<string, DRelation>();
  if (prev) {
    for (const e of prev.entities) for (const c of e.columns) prevCols.set(`${e.name}.${c.name}`, c);
    for (const r of prev.relations) prevLabels.set(`${r.parent}/${r.child}/${r.fks.join(',')}`, r);
  }
  let sb = 'erDiagram\n';
  const rels: Array<{ parent: string; child: string; onDelete: string; fks: string[] }> = [];
  const directives: string[] = [];
  for (const t of ts) {
    sb += `  ${t.name} {\n`;
    const single = new Map<string, ImpIndex>();
    for (const ix of t.indexes) if (ix.columns.length === 1) single.set(ix.columns[0]!, ix);
    const foreignByColumn = new Map<string, { key: ImpForeignKey; index: number }>();
    for (const fk of t.foreignKeys) {
      if (fk.columns.length !== fk.targetColumns.length) continue;
      fk.columns.forEach((column, i) => foreignByColumn.set(column, { key: fk, index: i }));
      if (fk.target !== t.name && sameList(primary.get(fk.target), fk.targetColumns)) {
        rels.push({ parent: fk.target, child: t.name, fks: [...fk.columns], onDelete: fk.onDelete });
      }
    }
    for (const c of t.columns) {
      const [rawType, unsigned] = mermaidType(c.type);
      const typ = importedJsonText(c.name, rawType);
      const keys: string[] = [];
      if (c.key === 'PRI') keys.push('PK');
      const item = foreignByColumn.get(c.name);
      const target = item ? item.key.target : fkTarget(c.name, tables);
      if (target !== '' && target !== t.name) keys.push('FK');
      const ix = single.get(c.name);
      if (ix && ix.unique && c.key !== 'PRI') keys.push('UK');
      const attrs: string[] = [];
      if (c.nullable) attrs.push('?');
      if (c.default === noDefault) { /* no default */ }
      else if (c.default.toUpperCase().startsWith('CURRENT_TIMESTAMP')) attrs.push('=now');
      else if (c.nullable && c.default.toUpperCase() === 'NULL') { /* nullable default */ }
      else {
        let d = c.default;
        if (d.includes(' ') || (!isNumber(d) && !d.startsWith("'"))) d = `'${d}'`;
        attrs.push('=' + d);
      }
      if (c.extra.toLowerCase().includes('on update current_timestamp')) attrs.push('onupdate');
      if (c.extra.includes('auto_increment')) attrs.push('auto');
      if (unsigned && !c.name.startsWith('is_')) attrs.push('unsigned');
      const pc = prevCols.get(`${t.name}.${c.name}`);
      if (pc) {
        if (pc.lazy) attrs.push('lazy');
        if (pc.bool) attrs.push('bool');
        if (pc.int) attrs.push('int');
        attrs.push(...pc.styles);
      }
      let line = `    ${pad(typ, 13)} ${pad(c.name, 28)}`;
      if (keys.length > 0) line += ' ' + keys.join(', ');
      if (attrs.length > 0) line += ' ' + quoted(attrs.join(' '));
      sb += line.replace(/ +$/, '') + '\n';
    }
    sb += '  }\n';
    if (t.comment !== '') directives.push(`  %% table_comment ${t.name} ${quoteDirective(t.comment)}`);
    for (const c of t.columns) if (c.comment !== '') directives.push(`  %% column_comment ${t.name} ${c.name} ${quoteDirective(c.comment)}`);
    for (const ix of t.indexes) {
      const cols = `(${ix.columns.join(', ')})`;
      if (ix.fulltext) directives.push(`  %% fulltext ${t.name} ${cols}`);
      else if (ix.unique && ix.columns.length > 1) directives.push(`  %% unique ${t.name} ${cols}`);
      else if (ix.unique) { /* UK on the column line */ }
      else if (ix.columns.length === 1 && fkTarget(ix.columns[0]!, tables) !== '') { /* implied FK index */ }
      else directives.push(`  %% index ${t.name} ${cols} ${ix.name}`);
    }
    for (const check of t.checks) directives.push(`  %% check ${t.name} ${check.name} : ${check.expr}`);
  }
  if (rels.length > 0) sb += '\n';
  for (const r of rels) {
    let label = r.fks.length > 1 ? `(${r.fks.join(', ')})` : r.fks[0]!;
    const pr = prevLabels.get(`${r.parent}/${r.child}/${r.fks.join(',')}`);
    if (pr && (pr.childName !== '' || pr.parentName !== '')) label += ` (${pr.childName} / ${pr.parentName})`;
    else if (r.fks.length > 1) label += ` (${r.parent} / ${plural(r.child)})`;
    if (r.onDelete !== '') label += ' ' + r.onDelete;
    sb += `  ${pad(r.parent, 14)} ||--o{ ${pad(r.child, 14)} : ${label}\n`;
  }
  if (directives.length > 0) sb += '\n';
  for (const d of directives) sb += d + '\n';
  return sb;
}

function importDeleteAction(action: string): string {
  switch (action.replaceAll('_', ' ').toUpperCase()) {
    case 'CASCADE': return 'cascade';
    case 'SET NULL': return 'setnull';
    default: return '';
  }
}

function quoteDirective(value: string): string {
  return '"' + value.replaceAll('"', '\\\\"') + '"';
}

function isNumber(value: string): boolean {
  if (value === '') return false;
  return [...value].every((r, i) => (r >= '0' && r <= '9') || r === '.' || (i === 0 && r === '-'));
}

function postgresDeleteAction(code: string): string {
  return code === 'c' ? 'cascade' : code === 'n' ? 'setnull' : '';
}

function postgresLogicalIndexName(table: string, physical: string, unique: boolean): string {
  if (unique) return physical;
  return physical.startsWith(table + '_') ? physical.slice(table.length + 1) : physical;
}

function postgresFulltextColumns(definition: string): string[] {
  if (!definition.toLowerCase().includes('to_tsvector')) throw new Error(`unsupported PostgreSQL GIN expression: ${definition}`);
  const columns: string[] = [];
  for (const match of definition.matchAll(/coalesce\s*\(\s*\(?\s*"?([a-z_][a-z0-9_]*)"?\s*,/gi)) {
    if (!columns.includes(match[1]!)) columns.push(match[1]!);
  }
  if (columns.length === 0) throw new Error(`unsupported PostgreSQL GIN expression: ${definition}`);
  return columns;
}

function nullableInt(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function pgTypeText(dataType: string, udt: string, charLenValue: unknown, numPrecValue: unknown, numScaleValue: unknown, dtPrecValue: unknown): string {
  const charLen = nullableInt(charLenValue);
  const numPrec = nullableInt(numPrecValue);
  const numScale = nullableInt(numScaleValue) ?? 0;
  const dtPrec = nullableInt(dtPrecValue);
  switch (dataType) {
    case 'character varying': case 'character': return charLen !== undefined ? `varchar(${charLen})` : 'text';
    case 'integer': return 'int';
    case 'smallint': return 'smallint';
    case 'bigint': return 'bigint';
    case 'boolean': return 'tinyint';
    case 'double precision': case 'real': return 'double';
    case 'numeric': return numPrec !== undefined ? `decimal(${numPrec},${numScale})` : 'decimal';
    case 'timestamp without time zone': case 'timestamp with time zone': return dtPrec !== undefined && dtPrec > 0 ? `datetime(${dtPrec})` : 'datetime';
    case 'date': return 'date';
    case 'time without time zone': case 'time with time zone': return 'time';
    case 'bytea': return 'blob';
    case 'json': case 'jsonb': return 'jsontext';
    case 'inet': return 'varbinary(16)';
    case 'text': return 'text';
  }
  return udt;
}

function pgDefaultText(value: string): string {
  let d = value;
  const i = d.indexOf('::');
  if (i > 0) d = d.slice(0, i);
  d = d.replace(/^'+|'+$/g, '');
  switch (d.toLowerCase()) {
    case 'now()': case 'current_timestamp': return 'CURRENT_TIMESTAMP';
    case 'true': return '1';
    case 'false': return '0';
  }
  return d;
}

/** Drops the migration history table from a catalog. */
export function filterManagedTables(tables: ImpTable[]): ImpTable[] {
  return tables.filter(t => t.name !== 'orm_schema_migrations' && t.name !== 'orm__context');
}

/** Appends the directives of the live ORM triggers on the imported tables to a rendered diagram. */
export async function withTriggerDirectives(db: ToolDb, tables: readonly ImpTable[], text: string): Promise<string> {
  const bodies = (await db.query(triggerBodiesQuery[db.driver]!)).map(row => String(row[0] ?? '')).filter(body => body.includes(triggerMarker));
  for (const line of triggerDirectives(bodies, new Set(tables.map(t => t.name)))) text += `  ${line}\n`;
  return text;
}

/** The manifest the live database represents, without the migration history table. */
export async function liveManifest(db: ToolDb): Promise<SchemaManifest> {
  const tables = filterManagedTables(await readTables(db));
  if (tables.length === 0) return { schema_hash: '', order: null, entities: {} };
  return buildManifest([parseDiagram(await withTriggerDirectives(db, tables, renderMermaid(tables)))], true);
}
