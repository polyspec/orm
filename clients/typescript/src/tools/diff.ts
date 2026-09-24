// Migration SQL between two manifests (`orm-gen diff`, docs/schema.md §4).
import type { Column, Entity, LoadedManifest, Manifest } from '../engine/manifest.js';
import {
  ddlColumn, ddlErrorText, ddlType, defaultExpression, mysqlJSONText, mysqlUUID, entityForeignKeys, foreignKeyClause, isNumber, joinQuoted, renderedCheckExpression, boundedIdentifier, ddlCheckName,
  renderDDL, sortedForeignKeys, sqlQuote, type ForeignKey, type Quote,
} from '../engine/ddl.js';
import { byteOrder, quoted } from '../schema/json.js';
import { encodeManifest, type SchemaColumn, type SchemaEntity, type SchemaManifest } from '../schema/build.js';
import { manifestMetadata } from './source.js';
import { diffTriggers } from '../engine/triggers.js';

interface Change { sql: string; destructive: boolean; }

export function loadedOf(m: SchemaManifest): LoadedManifest {
  return { manifest: m as unknown as Manifest, compact: encodeManifest(m) };
}

function asEntity(e: SchemaEntity): Entity { return e as unknown as Entity; }
function asColumn(c: SchemaColumn): Column { return c as unknown as Column; }
function asManifest(m: SchemaManifest): Manifest { return m as unknown as Manifest; }

function entities(m: SchemaManifest): Record<string, SchemaEntity> { return m.entities ?? {}; }
function entityOf(m: SchemaManifest, name: string): SchemaEntity | undefined {
  return m.entities !== null && Object.hasOwn(m.entities, name) ? m.entities[name] : undefined;
}
function columns(e: SchemaEntity): SchemaColumn[] { return e.columns ?? []; }
function str(s: string | undefined): string { return s ?? ''; }
function sortedNames(values: Iterable<string>): string[] { return [...values].sort(byteOrder); }

function sameList(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Renders the statements that change `from` into `to`. */
export function renderDiff(from: SchemaManifest, to: SchemaManifest, dialect: string, allowDestructive: boolean): string {
  if (dialect !== 'mysql' && dialect !== 'postgres' && dialect !== 'sqlite') throw new Error(`unknown dialect ${quoted(dialect)}`);
  const quote: Quote = dialect === 'mysql' ? s => '`' + s + '`' : s => '"' + s + '"';
  validateRenameSources(from, to);
  const changes: Change[] = [];
  const rebuilt = new Set<string>();
  for (const { old: oldEnt, next: newEnt } of matchDiffEntities(from, to)) {
    if (!oldEnt) {
      const one: SchemaManifest = { schema_hash: to.schema_hash, order: [newEnt!.name], entities: { [newEnt!.name]: newEnt! } };
      const create = removeDropStatement(ddl(one, dialect));
      changes.push({ sql: create.trim(), destructive: false });
      continue;
    }
    if (!newEnt) {
      changes.push({ sql: `DROP TABLE ${quote(oldEnt.table)};`, destructive: true });
      continue;
    }
    let tableRename = '';
    if (oldEnt.table !== newEnt.table) {
      if (str(newEnt.renamed_from) !== oldEnt.name && str(oldEnt.renamed_from) !== newEnt.name) {
        throw new Error(`table rename ${oldEnt.table} -> ${newEnt.table} requires explicit migration`);
      }
      tableRename = `ALTER TABLE ${quote(oldEnt.table)} RENAME TO ${quote(newEnt.table)};`;
    }
    if (dialect === 'sqlite') {
      validateSQLiteAddedColumns(oldEnt, newEnt);
      if (sqliteNeedsRebuild(from, to, oldEnt, newEnt)) {
        rebuilt.add(oldEnt.table);
        rebuilt.add(newEnt.table);
        changes.push({ sql: renderSQLiteRebuild(from, to, oldEnt, newEnt, quote), destructive: true });
        continue;
      }
    }
    const [drops, adds] = diffIndexesAndForeignKeys(from, to, oldEnt, newEnt, dialect, quote);
    const [checkDrops, checkAdds] = diffChecks(oldEnt, newEnt, dialect, quote);
    changes.push(...drops, ...checkDrops);
    if (tableRename !== '') changes.push({ sql: tableRename, destructive: false });
    for (const [o, n] of matchDiffColumns(oldEnt, newEnt)) {
      const col = n ? n.name : o!.name;
      if (!o) {
        let def = column(n!, dialect, quote);
        if (dialect === 'mysql' && str(n!.comment) !== '') def += ` COMMENT '${sqlQuote(n!.comment!)}'`;
        changes.push({ sql: `ALTER TABLE ${quote(newEnt.table)} ADD COLUMN ${def};`, destructive: false });
        if (dialect !== 'mysql' && str(n!.comment) !== '') changes.push({ sql: alterComment(newEnt.table, n!, dialect, quote), destructive: false });
      } else if (!n) {
        changes.push({ sql: `ALTER TABLE ${quote(oldEnt.table)} DROP COLUMN ${quote(col)};`, destructive: true });
      } else {
        if (o.name !== n.name) changes.push({ sql: `ALTER TABLE ${quote(newEnt.table)} RENAME COLUMN ${quote(o.name)} TO ${quote(n.name)};`, destructive: false });
        const changed = dialect === 'sqlite' ? !sqliteColumnsEquivalent(o, n) : columnChanged(o, n, dialect);
        if (changed) {
          let stmts: string[];
          try { stmts = alterColumn(newEnt.table, o, n, dialect, quote); } catch (error) {
            throw new Error(`column ${newEnt.table}.${col} changed from type=${o.type} raw=${o.raw} nullable=${Boolean(o.nullable)} default=${colDefault(o)} to type=${n.type} raw=${n.raw} nullable=${Boolean(n.nullable)} default=${colDefault(n)}: ${ddlErrorText(error)}`);
          }
          for (const stmt of stmts) changes.push({ sql: stmt, destructive: true });
        }
      }
      if (o && n && str(o.comment) !== str(n.comment)) changes.push({ sql: alterComment(newEnt.table, n, dialect, quote), destructive: false });
    }
    if (str(oldEnt.comment) !== str(newEnt.comment)) changes.push({ sql: alterTableComment(newEnt.table, str(newEnt.comment), dialect, quote), destructive: false });
    changes.push(...adds, ...checkAdds);
  }
  let triggers: { drops: string[]; creates: string[] };
  try { triggers = diffTriggers(asManifest(from), asManifest(to), dialect, rebuilt); } catch (error) { throw new Error(ddlErrorText(error)); }
  changes.unshift(...triggers.drops.map(sql => ({ sql, destructive: false })));
  changes.push(...triggers.creates.map(sql => ({ sql, destructive: false })));
  for (const c of changes) {
    if (c.destructive && !allowDestructive) throw new Error(`destructive schema change requires --allow-destructive: ${c.sql}`);
  }
  let out = `-- generated by ormgen diff (${dialect}) from ${from.schema_hash} to ${to.schema_hash}\n`;
  out += manifestMetadata(to);
  if (changes.length === 0) out += '-- no changes\n';
  for (const c of changes) out += c.sql + '\n';
  return out;
}

function ddl(m: SchemaManifest, dialect: string): string {
  try { return renderDDL(loadedOf(m), dialect); } catch (error) { throw new Error(ddlErrorText(error)); }
}

function column(c: SchemaColumn, dialect: string, quote: Quote): string {
  try { return ddlColumn(asColumn(c), dialect, quote); } catch (error) { throw new Error(ddlErrorText(error)); }
}

function typeOf(c: SchemaColumn, dialect: string): string {
  try { return ddlType(asColumn(c), dialect); } catch (error) { throw new Error(ddlErrorText(error)); }
}

function validateSQLiteAddedColumns(old: SchemaEntity, next: SchemaEntity): void {
  for (const [previous, c] of matchDiffColumns(old, next)) {
    if (!c || previous) continue;
    if (!c.nullable && (c.default === undefined || c.default === null) && !c.auto) {
      throw new Error(`sqlite table ${next.table} cannot add required column ${c.name} without a default during a data-preserving migration`);
    }
  }
}

function sqliteNeedsRebuild(from: SchemaManifest, to: SchemaManifest, old: SchemaEntity, next: SchemaEntity): boolean {
  if (!sameList(old.pk, next.pk) || !columnGroupsEqual(old.unique, next.unique) || !checksEqual(old.checks, next.checks)) return true;
  for (const [o, n] of matchDiffColumns(old, next)) {
    if (!o || !n) {
      if (!n) return true;
      continue;
    }
    if (!sqliteColumnsEquivalent(o, n)) return true;
  }
  const oldFKs = foreignKeys(from, old);
  const newFKs = foreignKeys(to, next);
  if (oldFKs.size !== newFKs.size) return true;
  for (const [key, left] of oldFKs) {
    const right = newFKs.get(key);
    if (!right || !foreignKeysEqual(left, right, false)) return true;
  }
  return false;
}

function checksEqual(left: readonly { name: string; expr: string }[] | null | undefined, right: readonly { name: string; expr: string }[] | null | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  const keys = (values: readonly { name: string; expr: string }[]) => values.map(v => v.name + '\x00' + v.expr).sort(byteOrder);
  return sameList(keys(a), keys(b));
}

function diffChecks(oldEnt: SchemaEntity, newEnt: SchemaEntity, dialect: string, quote: Quote): [Change[], Change[]] {
  if (dialect === 'sqlite' && !checksEqual(oldEnt.checks, newEnt.checks)) throw new Error('sqlite CHECK constraint changes require a verified table rebuild');
  const oldChecks = new Map((oldEnt.checks ?? []).map(c => [c.name, c]));
  const newChecks = new Map((newEnt.checks ?? []).map(c => [c.name, c]));
  const drops: Change[] = [];
  const adds: Change[] = [];
  for (const name of sortedNames(new Set([...oldChecks.keys(), ...newChecks.keys()]))) {
    const oldCheck = oldChecks.get(name);
    const newCheck = newChecks.get(name);
    if (oldCheck && (!newCheck || oldCheck.expr !== newCheck.expr)) {
      drops.push({ sql: `ALTER TABLE ${quote(oldEnt.table)} DROP CONSTRAINT ${quote(ddlCheckName(oldEnt.table, name, dialect))};`, destructive: true });
    }
    if (newCheck && (!oldCheck || oldCheck.expr !== newCheck.expr)) {
      let expr: string;
      try { expr = renderedCheckExpression(newCheck.expr, dialect, quote); } catch (error) { throw new Error(`${newEnt.table} check ${name}: ${ddlErrorText(error)}`); }
      adds.push({ sql: `ALTER TABLE ${quote(newEnt.table)} ADD CONSTRAINT ${quote(ddlCheckName(newEnt.table, name, dialect))} CHECK (${expr});`, destructive: false });
    }
  }
  return [drops, adds];
}

export function sqliteTypeMatches(want: string, live: string): boolean {
  if (want === live) return true;
  switch (live) {
    case 'i32': return want === 'i32' || want === 'i64' || want === 'bool';
    case 'f64': return want === 'f64' || want === 'decimal';
    case 'text': return ['string', 'text', 'jsontext', 'datetime', 'date', 'time', 'enum', 'point'].includes(want);
    case 'bytes': return want === 'bytes' || want === 'inet';
    default: return false;
  }
}

function sqliteColumnsEquivalent(left: SchemaColumn, right: SchemaColumn): boolean {
  const typeMatch = sqliteTypeMatches(right.type, left.type) || sqliteTypeMatches(left.type, right.type);
  return typeMatch && Boolean(left.nullable) === Boolean(right.nullable) && normalizedDefault(left) === normalizedDefault(right) && Boolean(left.auto) === Boolean(right.auto);
}

function normalizedDefault(c: SchemaColumn): string {
  if (c.default === undefined || c.default === null) return '';
  return trimQuotes(c.default, '\'"');
}

function trimQuotes(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) start++;
  while (end > start && chars.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

function columnGroupsEqual(left: readonly string[][] | null | undefined, right: readonly string[][] | null | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  const keys = (groups: readonly string[][]) => groups.map(g => g.join('\x00')).sort(byteOrder);
  return sameList(keys(a), keys(b));
}

function renderSQLiteRebuild(from: SchemaManifest, to: SchemaManifest, old: SchemaEntity, next: SchemaEntity, quote: Quote): string {
  const temp = '__orm_rebuild_' + next.table;
  const lines = columns(next).map(c => '  ' + column(c, 'sqlite', quote));
  const pk = next.pk ?? [];
  if (pk.length === 1 && next.auto === pk[0]) {
    lines.forEach((line, i) => { if (line.startsWith(`  ${quote(pk[0]!)} `)) lines[i] = `  ${quote(pk[0]!)} INTEGER PRIMARY KEY AUTOINCREMENT`; });
  } else {
    lines.push(`  PRIMARY KEY (${joinQuoted(pk, quote)})`);
  }
  for (const unique of next.unique ?? []) lines.push(`  CONSTRAINT ${quote(boundedIdentifier(`uq_${next.table}_${unique.join('_')}`, 'sqlite'))} UNIQUE (${joinQuoted(unique, quote)})`);
  for (const fk of sortedForeignKeys(asManifest(to), asEntity(next), 'sqlite')) lines.push('  ' + foreignKeyClause(fk, asManifest(to), 'sqlite', quote));
  for (const check of next.checks ?? []) {
    let expr: string;
    try { expr = renderedCheckExpression(check.expr, 'sqlite', quote); } catch (error) { throw new Error(`${next.table} check ${check.name}: ${ddlErrorText(error)}`); }
    lines.push(`  CONSTRAINT ${quote(check.name)} CHECK (${expr})`);
  }
  const targetCols: string[] = [];
  const sourceCols: string[] = [];
  for (const [o, n] of matchDiffColumns(old, next)) {
    if (!o || !n) continue;
    targetCols.push(quote(n.name));
    sourceCols.push(quote(o.name));
  }
  let b = `SELECT 'orm-sqlite-rebuild table=${old.table} target=${next.table} temp=${temp}';\n`;
  b += 'PRAGMA defer_foreign_keys = ON;\n';
  b += `CREATE TABLE ${quote(temp)} (\n${lines.join(',\n')}\n);\n`;
  if (targetCols.length > 0) b += `INSERT INTO ${quote(temp)} (${targetCols.join(', ')}) SELECT ${sourceCols.join(', ')} FROM ${quote(old.table)};\n`;
  b += `DROP TABLE ${quote(old.table)};\n`;
  b += `ALTER TABLE ${quote(temp)} RENAME TO ${quote(next.table)};\n`;
  for (const name of sortedNames(Object.keys(next.indexes ?? {}))) {
    b += `CREATE INDEX ${quote(`${next.table}_${name}`)} ON ${quote(next.table)} (${joinQuoted(next.indexes![name]!, quote)});\n`;
  }
  b += 'CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));\n';
  b += `DELETE FROM orm_schema_comments WHERE table_name='${sqlQuote(old.table)}';\n`;
  if (str(next.comment) !== '') b += `INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('${sqlQuote(next.table)}','','${sqlQuote(next.comment!)}');\n`;
  for (const c of columns(next)) {
    if (str(c.comment) !== '') b += `INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('${sqlQuote(next.table)}','${sqlQuote(c.name)}','${sqlQuote(c.comment!)}');\n`;
  }
  return b.trim();
}

function validateRenameSources(from: SchemaManifest, to: SchemaManifest): void {
  for (const next of Object.values(entities(to))) {
    let old = entityOf(from, next.name);
    const alreadyRenamed = old !== undefined;
    if (str(next.renamed_from) !== '' && !alreadyRenamed) {
      old = entityOf(from, next.renamed_from!);
      if (!old) throw new Error(`table ${next.name} rename source ${next.renamed_from} does not exist`);
    }
    if (!old) continue;
    const oldColumns = new Set(columns(old).map(c => c.name));
    for (const c of columns(next)) {
      if (str(c.renamed_from) !== '' && !oldColumns.has(c.name) && !oldColumns.has(c.renamed_from!)) {
        throw new Error(`column ${next.name}.${c.name} rename source ${c.renamed_from} does not exist`);
      }
    }
  }
}

function matchDiffEntities(from: SchemaManifest, to: SchemaManifest): Array<{ old?: SchemaEntity; next?: SchemaEntity }> {
  const used = new Set<string>();
  const pairs: Array<{ old?: SchemaEntity; next?: SchemaEntity }> = [];
  for (const name of sortedNames(Object.keys(entities(to)))) {
    const next = entities(to)[name]!;
    let old = entityOf(from, name);
    if (!old && str(next.renamed_from) !== '') old = entityOf(from, next.renamed_from!);
    if (!old) old = Object.values(entities(from)).find(candidate => candidate.renamed_from === name);
    if (old) used.add(old.name);
    pairs.push({ old, next });
  }
  for (const name of sortedNames(Object.keys(entities(from)).filter(n => !used.has(n)))) pairs.push({ old: entities(from)[name]! });
  return pairs;
}

function matchDiffColumns(old: SchemaEntity, next: SchemaEntity): Array<[SchemaColumn | undefined, SchemaColumn | undefined]> {
  const oldByName = new Map(columns(old).map(c => [c.name, c]));
  const used = new Set<string>();
  const out: Array<[SchemaColumn | undefined, SchemaColumn | undefined]> = [];
  for (const n of columns(next)) {
    let o = oldByName.get(n.name);
    if (!o && str(n.renamed_from) !== '') o = oldByName.get(n.renamed_from!);
    if (!o) o = columns(old).find(candidate => candidate.renamed_from === n.name);
    if (o) used.add(o.name);
    out.push([o, n]);
  }
  for (const o of columns(old)) if (!used.has(o.name)) out.push([o, undefined]);
  return out;
}

function removeDropStatement(s: string): string {
  return s.split('\n').filter(line => !line.startsWith('DROP TABLE IF EXISTS ') && !line.startsWith('-- generated by')).join('\n');
}

/**
 * A physical column difference. The update time is a column property only on
 * MySQL; the other dialects assign it in the planned UPDATE statement.
 */
/** The type, raw type, and length a dialect stores; a MySQL uuid column is char(36). */
export function columnStorage(c: SchemaColumn, dialect: string): [string, string, number] {
  if (dialect === 'mysql' && str(c.raw).toLowerCase() === 'uuid') return [c.type, mysqlUUID, 36];
  if (c.type === 'jsontext' || c.type === 'text') return ['text', dialect === 'mysql' ? mysqlJSONText : 'text', 0];
  return [c.type, str(c.raw), c.len ?? 0];
}

function columnChanged(a: SchemaColumn, b: SchemaColumn, dialect: string): boolean {
  const onUpdate = dialect === 'mysql' && Boolean(a.on_update) !== Boolean(b.on_update);
  const [aType, aRaw, aLen] = columnStorage(a, dialect);
  const [bType, bRaw, bLen] = columnStorage(b, dialect);
  return aType !== bType || aRaw !== bRaw || Boolean(a.nullable) !== Boolean(b.nullable) || colDefault(a) !== colDefault(b)
    || Boolean(a.auto) !== Boolean(b.auto) || onUpdate || Boolean(a.unsigned) !== Boolean(b.unsigned)
    || aLen !== bLen || (a.precision ?? 0) !== (b.precision ?? 0) || (a.scale ?? 0) !== (b.scale ?? 0);
}

function colDefault(c: SchemaColumn): string {
  return c.default ?? '';
}

function hasDefault(c: SchemaColumn): boolean { return c.default !== undefined && c.default !== null; }

function alterColumn(table: string, old: SchemaColumn, next: SchemaColumn, dialect: string, quote: Quote): string[] {
  switch (dialect) {
    case 'mysql':
    {
      let def = column(next, dialect, quote);
      if (str(next.comment) !== '') def += ` COMMENT '${sqlQuote(next.comment!)}'`;
      return [`ALTER TABLE ${quote(table)} MODIFY COLUMN ${def};`];
    }
    case 'postgres': {
      const out: string[] = [];
      const oldType = typeOf(old, dialect);
      const newType = typeOf(next, dialect);
      const prefix = `ALTER TABLE ${quote(table)} ALTER COLUMN ${quote(next.name)} `;
      if (oldType !== newType) out.push(`${prefix}TYPE ${newType};`);
      if (Boolean(old.nullable) !== Boolean(next.nullable)) out.push(prefix + (next.nullable ? 'DROP NOT NULL;' : 'SET NOT NULL;'));
      if (colDefault(old) !== colDefault(next) || hasDefault(old) !== hasDefault(next)) {
        out.push(hasDefault(next) ? `${prefix}SET DEFAULT ${ddlDefault(next, dialect)};` : `${prefix}DROP DEFAULT;`);
      }
      if (Boolean(old.auto) !== Boolean(next.auto)) out.push(prefix + (next.auto ? 'ADD GENERATED BY DEFAULT AS IDENTITY;' : 'DROP IDENTITY IF EXISTS;'));
      if (out.length === 0) throw new Error('postgres does not support the requested attribute change');
      return out;
    }
    case 'sqlite':
      throw new Error('sqlite does not support deterministic ALTER COLUMN; recreate the table explicitly');
    default:
      throw new Error(`unknown dialect ${quoted(dialect)}`);
  }
}

function ddlDefault(c: SchemaColumn, dialect: string): string {
  if (!hasDefault(c)) throw new Error(`column ${c.name} has no default`);
  try { return defaultExpression(asColumn(c), ddlType(asColumn(c), dialect), dialect); } catch (error) { throw new Error(ddlErrorText(error)); }
}

interface DiffIndex { name: string; kind: string; cols: string[]; }

function diffIndexesAndForeignKeys(from: SchemaManifest, to: SchemaManifest, oldEnt: SchemaEntity, newEnt: SchemaEntity, dialect: string, quote: Quote): [Change[], Change[]] {
  const oldIndexes = entityIndexes(oldEnt, dialect);
  const newIndexes = entityIndexes(newEnt, dialect);
  const indexDrops: Change[] = [];
  const indexAdds: Change[] = [];
  const foreignDrops: Change[] = [];
  const foreignAdds: Change[] = [];
  for (const key of sortedNames(new Set([...oldIndexes.keys(), ...newIndexes.keys()]))) {
    const o = oldIndexes.get(key);
    const n = newIndexes.get(key);
    if (o && n && o.kind === n.kind && sameList(o.cols, n.cols)) continue;
    if (o) indexDrops.push({ sql: dropIndex(oldEnt.table, o, dialect, quote), destructive: false });
    if (n) indexAdds.push({ sql: createIndex(newEnt.table, n, dialect, quote), destructive: false });
  }
  const oldFKs = foreignKeys(from, oldEnt, dialect);
  const newFKs = foreignKeys(to, newEnt, dialect);
  for (const key of sortedNames(new Set([...oldFKs.keys(), ...newFKs.keys()]))) {
    const o = oldFKs.get(key);
    const n = newFKs.get(key);
    if (o && n && foreignKeysEqual(o, n, dialect !== 'sqlite')) continue;
    if (dialect === 'sqlite') throw new Error('sqlite foreign key changes require a verified table rebuild');
    if (o) foreignDrops.push({ sql: `ALTER TABLE ${quote(oldEnt.table)} ${dialect === 'mysql' ? 'DROP FOREIGN KEY' : 'DROP CONSTRAINT'} ${quote(o.name)};`, destructive: false });
    if (n) foreignAdds.push({ sql: `ALTER TABLE ${quote(newEnt.table)} ADD ${foreignKeyClause(n, asManifest(to), dialect, quote)};`, destructive: false });
  }
  return [[...foreignDrops, ...indexDrops], [...indexAdds, ...foreignAdds]];
}

function foreignKeys(m: SchemaManifest, e: SchemaEntity, dialect = ''): Map<string, ForeignKey> {
  return entityForeignKeys(asManifest(m), asEntity(e), dialect);
}

function foreignKeysEqual(left: ForeignKey, right: ForeignKey, compareName: boolean): boolean {
  return (!compareName || left.name === right.name) && sameList(left.columns, right.columns) && left.target === right.target
    && sameList(left.targetCols, right.targetCols) && left.onDelete === right.onDelete && left.deferred === right.deferred;
}

/**
 * The physical indexes of an entity. SQLite evaluates full-text conditions
 * without an index, so it has no full-text objects.
 */
function entityIndexes(e: SchemaEntity, dialect: string): Map<string, DiffIndex> {
  const out = new Map<string, DiffIndex>();
  for (const [name, cols] of Object.entries(e.indexes ?? {})) out.set('index:' + name, { name, kind: 'index', cols: [...cols] });
  for (const cols of e.unique ?? []) {
    const name = boundedIdentifier(`uq_${e.table}_${cols.join('_')}`, dialect);
    out.set('unique:' + name, { name, kind: 'unique', cols: [...cols] });
  }
  for (const cols of e.fulltext ?? []) {
    if (dialect === 'sqlite') break;
    const name = 'ft_' + cols.join('_');
    out.set('fulltext:' + name, { name, kind: 'fulltext', cols: [...cols] });
  }
  return out;
}

function dropIndex(table: string, index: DiffIndex, dialect: string, quote: Quote): string {
  if (index.kind === 'unique') {
    if (dialect === 'postgres') return `ALTER TABLE ${quote(table)} DROP CONSTRAINT ${quote(index.name)};`;
    if (dialect === 'sqlite') throw new Error('sqlite unique constraint changes require a verified table rebuild');
  }
  const name = dialect !== 'mysql' && index.kind !== 'unique' ? `${table}_${index.name}` : index.name;
  if (dialect === 'mysql') return `DROP INDEX ${quote(name)} ON ${quote(table)};`;
  return `DROP INDEX ${quote(name)};`;
}

function createIndex(table: string, index: DiffIndex, dialect: string, quote: Quote): string {
  if (index.kind === 'unique') {
    if (dialect === 'postgres') return `ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(index.name)} UNIQUE (${joinQuoted(index.cols, quote)});`;
    if (dialect === 'sqlite') throw new Error('sqlite unique constraint changes require a verified table rebuild');
  }
  const name = dialect !== 'mysql' && index.kind !== 'unique' ? `${table}_${index.name}` : index.name;
  switch (index.kind) {
    case 'index': return `CREATE INDEX ${quote(name)} ON ${quote(table)} (${joinQuoted(index.cols, quote)});`;
    case 'unique': return `CREATE UNIQUE INDEX ${quote(name)} ON ${quote(table)} (${joinQuoted(index.cols, quote)});`;
    case 'fulltext':
      if (dialect === 'mysql') return `CREATE FULLTEXT INDEX ${quote(name)} ON ${quote(table)} (${joinQuoted(index.cols, quote)});`;
      if (dialect === 'postgres') {
        const doc = index.cols.map(c => `coalesce(${quote(c)}, '')`).join(" || ' ' || ");
        return `CREATE INDEX ${quote(name)} ON ${quote(table)} USING GIN (to_tsvector('simple', ${doc}));`;
      }
  }
  throw new Error(`unknown index kind ${quoted(index.kind)}`);
}

function alterTableComment(table: string, comment: string, dialect: string, quote: Quote): string {
  const q = sqlQuote(comment);
  if (dialect === 'mysql') return `ALTER TABLE ${quote(table)} COMMENT = '${q}';`;
  if (dialect === 'postgres') return comment === '' ? `COMMENT ON TABLE ${quote(table)} IS NULL;` : `COMMENT ON TABLE ${quote(table)} IS '${q}';`;
  if (comment === '') return `DELETE FROM orm_schema_comments WHERE table_name='${sqlQuote(table)}' AND column_name='';`;
  return `INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('${sqlQuote(table)}','','${q}');`;
}

function alterComment(table: string, c: SchemaColumn, dialect: string, quote: Quote): string {
  const comment = str(c.comment);
  const q = sqlQuote(comment);
  if (dialect === 'mysql') return `ALTER TABLE ${quote(table)} MODIFY COLUMN ${column(c, dialect, quote)} COMMENT '${q}';`;
  if (dialect === 'postgres') {
    return comment === '' ? `COMMENT ON COLUMN ${quote(table)}.${quote(c.name)} IS NULL;` : `COMMENT ON COLUMN ${quote(table)}.${quote(c.name)} IS '${q}';`;
  }
  if (comment === '') return `DELETE FROM orm_schema_comments WHERE table_name='${sqlQuote(table)}' AND column_name='${sqlQuote(c.name)}';`;
  return `CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));\nINSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('${sqlQuote(table)}','${sqlQuote(c.name)}','${q}');`;
}
