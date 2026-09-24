// CREATE statements for a manifest (docs/dialects.md). The output is the
// same text the schema tool writes for `ddl`.
import { OrmError } from '../runtime_error.js';
import { indentJson, type Column, type Entity, type LoadedManifest, type Manifest } from './manifest.js';
import { triggerObjects, triggerText } from './triggers.js';

export type Quote = (name: string) => string;

export interface ForeignKey {
  name: string;
  columns: string[];
  target: string;
  targetCols: string[];
  onDelete: string;
  deferred: boolean;
}

const metadataPrefix = '-- orm-schema-v1 ';

function fail(message: string): never { throw new OrmError('CONFIG', message); }

/** The message of a DDL error without its code. */
export function ddlErrorText(error: unknown): string {
  if (error instanceof OrmError && error.code === 'CONFIG') return error.message.slice('CONFIG: '.length);
  return (error as Error).message;
}

export function sqlQuote(s: string): string { return s.replaceAll("'", "''"); }

export function quoteQualified(q: string, name: string): string {
  return name.split('.').map(part => q + part.replaceAll(q, q + q) + q).join('.');
}

export function ddlTable(table: string, dialect: string): string {
  return dialect === 'sqlite' ? table.replaceAll('.', '__') : table;
}

export function ddlBase(table: string): string {
  const parts = table.split('.');
  return parts[parts.length - 1]!;
}

export function ddlIndexName(table: string, index: string, dialect: string): string {
  if (dialect === 'sqlite') return `${ddlTable(table, dialect)}_${index}`;
  return `${ddlBase(table)}_${index}`;
}

export function byteOrder(a: string, b: string): number {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return Buffer.compare(x, y);
}

export function sorted(values: Iterable<string>): string[] { return [...values].sort(byteOrder); }

function ddlSchemas(m: Manifest): string[] {
  const out = new Set<string>();
  for (const name of m.order) {
    const parts = m.entities[name]!.table.split('.');
    if (parts.length === 2) out.add(parts[0]!);
  }
  return sorted(out);
}

export function joinQuoted(cols: readonly string[], q: Quote): string { return cols.map(q).join(', '); }

export function isNumber(s: string): boolean {
  if (s === '') return false;
  return [...s].every((r, i) => (r >= '0' && r <= '9') || r === '.' || (i === 0 && r === '-'));
}

export const mysqlUUID = 'char(36)';
export const mysqlJSONText = 'longtext';

export function ddlType(c: Column, dialect: string): string {
  if (dialect === 'mysql' && (c.raw ?? '') !== '') {
    // MySQL has no uuid type; clients bind uuid values as text.
    if (c.raw!.toLowerCase() === 'uuid') return mysqlUUID;
    // jsontext keeps the stored text, which a document type would normalize.
    if (c.type === 'jsontext') return mysqlJSONText;
    // MySQL takes the enum values as string literals.
    if (c.type === 'enum') return `enum(${(c.enum ?? []).map(v => `'${sqlQuote(v)}'`).join(',')})`;
    let t = c.raw!.replaceAll('_', ',');
    if (c.unsigned && !t.includes('unsigned')) t += ' unsigned';
    return t;
  }
  const prec = (n: number | undefined) => (n ?? 0) > 0 ? `(${n})` : '';
  if (dialect === 'postgres') {
    switch (c.type) {
      case 'i32': return 'integer';
      case 'i64': return 'bigint';
      case 'f64': return 'double precision';
      case 'decimal': return `numeric(${c.precision ?? 0},${c.scale ?? 0})`;
      case 'bool': return 'boolean';
      case 'string': case 'enum':
        if ((c.raw ?? '').toLowerCase() === 'uuid') return 'uuid';
        return (c.len ?? 0) > 0 ? `varchar(${c.len})` : 'text';
      case 'text': return 'text';
      case 'bytes': return 'bytea';
      case 'date': return 'date';
      case 'time': return 'time';
      case 'datetime': return `timestamp${prec(c.precision)} with time zone`;
      // json keeps the stored text, so object member order survives.
      // The ordered-json text is stored as written.
      case 'jsontext': return 'text';
      case 'inet': return 'inet';
      case 'point': return 'point';
    }
  }
  if (dialect === 'sqlite') {
    switch (c.type) {
      case 'i32': case 'i64': case 'bool': return 'INTEGER';
      case 'f64': case 'decimal': return 'REAL';
      case 'bytes': case 'inet': return 'BLOB';
      default: return 'TEXT';
    }
  }
  return fail(`no ${dialect} type for ${c.type}`);
}

function columnLine(c: Column, dialect: string, q: Quote): string {
  let line = `  ${ddlColumn(c, dialect, q)}`;
  if ((c.comment ?? '') !== '' && dialect === 'mysql') line += ` COMMENT '${sqlQuote(c.comment!)}'`;
  return line;
}

/** One column definition without table constraints or comment. */
export function ddlColumn(c: Column, dialect: string, q: Quote): string {
  const type = ddlType(c, dialect);
  let line = `${q(c.name)} ${type}`;
  if (!c.nullable) line += ' NOT NULL';
  if (c.default !== undefined) line += ` DEFAULT ${defaultExpression(c, type, dialect)}`;
  if (c.on_update && dialect === 'mysql') {
    line += ' ON UPDATE CURRENT_TIMESTAMP';
    if ((c.precision ?? 0) > 0) line += `(${c.precision})`;
  }
  if (c.auto && dialect === 'mysql') line += ' AUTO_INCREMENT';
  if (c.auto && dialect === 'postgres') line += ' GENERATED BY DEFAULT AS IDENTITY';
  return line;
}

/**
 * A column default. MySQL accepts a literal default for TEXT, BLOB, JSON, and
 * geometry columns only in the expression form DEFAULT (value).
 */
export function defaultExpression(c: Column, type: string, dialect: string): string {
  const v = c.default!;
  // text timestamps with six fraction digits, the form the executor binds and compares
  if (v === 'now' && dialect === 'sqlite') return "(strftime('%Y-%m-%d %H:%M:%f', 'now') || '000')";
  if (v === 'now') return dialect === 'mysql' && (c.precision ?? 0) > 0 ? `CURRENT_TIMESTAMP(${c.precision})` : 'CURRENT_TIMESTAMP';
  if (v === 'null') return 'NULL';
  if (isNumber(v) && c.type === 'bool' && dialect === 'postgres') return v === '0' ? 'false' : 'true';
  const expr = isNumber(v) ? v : `'${sqlQuote(v.replace(/^'+|'+$/g, ''))}'`;
  if (dialect === 'mysql' && /text|blob|json|geometry|point|linestring|polygon/.test(type.toLowerCase())) return `(${expr})`;
  return expr;
}

export function foreignKeyTargetEntity(m: Manifest, target: string): Entity | undefined {
  if (Object.hasOwn(m.entities, target)) return m.entities[target];
  return Object.values(m.entities).find(e => e.table === target);
}

function relationMatchesColumnReference(e: Entity, keys: readonly { local: string; target: string }[], target: string): boolean {
  if (keys.length === 0) return false;
  return keys.every(key => {
    const column = e.columns.find(c => c.name === key.local);
    return column?.ref !== undefined && column.ref.entity === target && column.ref.column === key.target;
  });
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function entityForeignKeys(m: Manifest, e: Entity): Map<string, ForeignKey> {
  const out = new Map<string, ForeignKey>();
  const consumed = new Set<string>();
  for (const rel of Object.values(e.relations ?? {})) {
    if (rel.kind !== 'one' || (!rel.foreign_key && !relationMatchesColumnReference(e, rel.keys, rel.target))) continue;
    if (rel.keys.length === 0 || rel.keys.some(key => !e.columns.some(c => c.name === key.local))) continue;
    const columns = rel.keys.map(k => k.local);
    out.set(columns.join('\x1f'), { name: `fk_${e.table}_${columns.join('_')}`, columns, target: rel.target, targetCols: rel.keys.map(k => k.target), onDelete: rel.on_delete ?? '', deferred: false });
    for (const c of columns) consumed.add(c);
  }
  for (const c of e.columns) {
    if (!c.ref || consumed.has(c.name)) continue;
    out.set(c.name, { name: `fk_${e.table}_${c.name}`, columns: [c.name], target: c.ref.entity, targetCols: [c.ref.column], onDelete: '', deferred: false });
  }
  for (const fk of m.external_fks ?? []) {
    if (fk.entity !== e.name) continue;
    const name = fk.name ?? `fk_${e.table.replaceAll('.', '_')}_${fk.columns.join('_')}`;
    let matched = false;
    for (const existing of out.values()) {
      const target = m.entities[existing.target]?.table ?? existing.target;
      if (target === fk.target_table && sameList(existing.columns, fk.columns) && sameList(existing.targetCols, fk.target_columns)) {
        existing.name = name;
        existing.deferred = fk.deferred ?? false;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    out.set(`external:${fk.columns.join('\x1f')}\x1e${fk.target_table}`, {
      name, columns: [...fk.columns], target: fk.target_table, targetCols: [...fk.target_columns], onDelete: fk.on_delete ?? '', deferred: fk.deferred ?? false,
    });
  }
  return out;
}

export function sortedForeignKeys(m: Manifest, e: Entity): ForeignKey[] {
  const byKey = entityForeignKeys(m, e);
  return sorted(byKey.keys()).map(key => byKey.get(key)!);
}

export function foreignKeyClause(fk: ForeignKey, m: Manifest, dialect: string, q: Quote): string {
  const target = m.entities[fk.target]?.table ?? fk.target;
  let stmt = `CONSTRAINT ${q(fk.name.replaceAll('.', '_'))} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(target)} (${fk.targetCols.map(q).join(', ')})`;
  switch (fk.onDelete) {
    case 'cascade': stmt += ' ON DELETE CASCADE'; break;
    case 'setnull': stmt += ' ON DELETE SET NULL'; break;
    default: stmt += ' ON DELETE RESTRICT';
  }
  if (fk.deferred && (dialect === 'postgres' || dialect === 'sqlite')) stmt += ' DEFERRABLE INITIALLY DEFERRED';
  return stmt;
}

export function quotedCheckExpression(expr: string, q: Quote): string {
  let out = '';
  while (expr.length > 0) {
    const start = expr.indexOf('`');
    if (start < 0) { out += expr; break; }
    out += expr.slice(0, start);
    const rest = expr.slice(start + 1);
    const end = rest.indexOf('`');
    if (end < 0) fail('CHECK expression has an unterminated backtick identifier');
    const name = rest.slice(0, end);
    if (name === '' || name.includes('\x00')) fail('CHECK expression has an invalid backtick identifier');
    out += q(name);
    expr = rest.slice(end + 1);
  }
  return out;
}

/** A parent-before-child order for inline foreign keys. */
function ddlEntityOrder(m: Manifest): string[] {
  const position = new Map(m.order.map((name, i) => [name, i]));
  const names = [...m.order];
  for (const name of Object.keys(m.entities)) {
    if (!position.has(name)) { position.set(name, position.size); names.push(name); }
  }
  const state = new Map<string, number>();
  const result: string[] = [];
  const visit = (name: string): void => {
    if (state.get(name) === 1) fail(`foreign key cycle includes ${name}; deferred cyclic constraints are required`);
    if (state.get(name) === 2) return;
    state.set(name, 1);
    const e = m.entities[name]!;
    const deps = new Set<string>();
    for (const c of e.columns) if (c.ref && c.ref.entity !== name && Object.hasOwn(m.entities, c.ref.entity)) deps.add(c.ref.entity);
    for (const rel of Object.values(e.relations ?? {})) if (rel.foreign_key && rel.target !== name && Object.hasOwn(m.entities, rel.target)) deps.add(rel.target);
    for (const dep of [...deps].sort((a, b) => position.get(a)! - position.get(b)!)) visit(dep);
    state.set(name, 2);
    result.push(name);
  };
  for (const name of names) visit(name);
  return result;
}

/** CREATE statements that drop and recreate every table. */
export function renderDDL(loaded: LoadedManifest, dialect: string): string {
  const m = loaded.manifest;
  const q: Quote = dialect === 'mysql' ? s => quoteQualified('`', s) : s => quoteQualified('"', ddlTable(s, dialect));
  let sb = `-- generated by ormgen ddl (${dialect}) from schema_hash ${m.schema_hash}\n`;
  sb += metadataPrefix + Buffer.from(indentJson(loaded.compact)).toString('base64').replace(/=+$/, '') + '\n';
  if (dialect === 'sqlite') {
    sb += 'CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));\n';
  }
  if (dialect === 'postgres') for (const name of ddlSchemas(m)) sb += `CREATE SCHEMA IF NOT EXISTS ${q(name)};\n`;
  // MySQL keeps a qualified table in the database named by its schema.
  if (dialect === 'mysql') for (const name of ddlSchemas(m)) sb += `CREATE DATABASE IF NOT EXISTS ${q(name)};\n`;
  const order = ddlEntityOrder(m);
  for (let i = order.length - 1; i >= 0; i--) sb += `\nDROP TABLE IF EXISTS ${q(ddlTable(m.entities[order[i]!]!.table, dialect))};\n`;
  const position = new Map(order.map((name, i) => [name, i]));
  const deferred: Array<{ table: string; fk: ForeignKey }> = [];
  order.forEach((name, current) => {
    const e = m.entities[name]!;
    sb += `\nCREATE TABLE ${q(ddlTable(e.table, dialect))} (\n`;
    const lines = e.columns.map(c => {
      try { return columnLine(c, dialect, q); } catch (error) { return fail(`${e.table}.${c.name}: ${ddlErrorText(error)}`); }
    });
    const pk0 = e.pk[0]!;
    if (dialect === 'sqlite' && e.pk.length === 1 && e.auto === pk0) {
      // the rowid alias is declared inline
      lines.forEach((l, i) => { if (l.startsWith(`  ${q(pk0)} `)) lines[i] = `  ${q(pk0)} INTEGER PRIMARY KEY AUTOINCREMENT`; });
    } else {
      lines.push(`  PRIMARY KEY (${joinQuoted(e.pk, q)})`);
    }
    for (const uk of e.unique ?? []) lines.push(`  CONSTRAINT ${q(`uq_${ddlBase(e.table)}_${uk.join('_')}`)} UNIQUE (${joinQuoted(uk, q)})`);
    for (const fk of sortedForeignKeys(m, e)) {
      const target = foreignKeyTargetEntity(m, fk.target);
      if (target && dialect !== 'sqlite' && position.get(target.name)! > current) {
        deferred.push({ table: e.table, fk });
        continue;
      }
      lines.push(`  ${foreignKeyClause(fk, m, dialect, q)}`);
    }
    for (const check of e.checks ?? []) {
      let expr: string;
      try { expr = quotedCheckExpression(check.expr, q); } catch (error) { return fail(`${e.table} check ${check.name}: ${ddlErrorText(error)}`); }
      lines.push(`  CONSTRAINT ${q(check.name)} CHECK (${expr})`);
    }
    const indexNames = sorted(Object.keys(e.indexes ?? {}));
    if (dialect === 'mysql') {
      for (const ix of indexNames) lines.push(`  KEY ${q(ix)} (${joinQuoted(e.indexes![ix]!, q)})`);
      for (const cols of e.fulltext ?? []) lines.push(`  FULLTEXT KEY ${q(`ft_${cols.join('_')}`)} (${joinQuoted(cols, q)})`);
    }
    sb += lines.join(',\n') + '\n)';
    if (dialect === 'mysql') sb += ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    sb += ';\n';
    if ((e.comment ?? '') !== '') {
      if (dialect === 'mysql') sb += `ALTER TABLE ${q(e.table)} COMMENT = '${sqlQuote(e.comment!)}';\n`;
      else if (dialect === 'postgres') sb += `COMMENT ON TABLE ${q(e.table)} IS '${sqlQuote(e.comment!)}';\n`;
      else sb += `INSERT OR REPLACE INTO orm_schema_comments (table_name, column_name, comment) VALUES ('${sqlQuote(e.table)}', '', '${sqlQuote(e.comment!)}');\n`;
    }
    for (const c of e.columns) {
      if ((c.comment ?? '') === '') continue;
      if (dialect === 'postgres') sb += `COMMENT ON COLUMN ${q(e.table)}.${q(c.name)} IS '${sqlQuote(c.comment!)}';\n`;
      else if (dialect === 'sqlite') sb += `INSERT OR REPLACE INTO orm_schema_comments (table_name, column_name, comment) VALUES ('${sqlQuote(e.table)}', '${sqlQuote(c.name)}', '${sqlQuote(c.comment!)}');\n`;
    }
    if (dialect !== 'mysql') {
      for (const ix of indexNames) sb += `CREATE INDEX ${q(ddlIndexName(e.table, ix, dialect))} ON ${q(e.table)} (${joinQuoted(e.indexes![ix]!, q)});\n`;
      if (dialect === 'postgres') {
        for (const cols of e.fulltext ?? []) {
          const doc = cols.map(c => `coalesce(${q(c)}, '')`).join(" || ' ' || ");
          sb += `CREATE INDEX ${q(ddlIndexName(e.table, `ft_${cols.join('_')}`, dialect))} ON ${q(e.table)} USING GIN (to_tsvector('simple', ${doc}));\n`;
        }
      }
    }
  });
  for (const item of deferred) sb += `ALTER TABLE ${q(item.table)} ADD ${foreignKeyClause(item.fk, m, dialect, q)};\n`;
  for (const o of triggerObjects(m, dialect)) sb += `\n${triggerText(o)}\n`;
  return sb;
}

/** The apply-safe form: no table is dropped and tables and indexes are created when missing. */
export function renderCreateDDL(loaded: LoadedManifest, dialect: string): string {
  return renderDDL(loaded, dialect).split('\n')
    .filter(line => !line.startsWith('DROP TABLE IF EXISTS '))
    .map(line => line
      .replace('CREATE TABLE `', 'CREATE TABLE IF NOT EXISTS `')
      .replace('CREATE TABLE "', 'CREATE TABLE IF NOT EXISTS "')
      .replace('CREATE INDEX `', 'CREATE INDEX IF NOT EXISTS `')
      .replace('CREATE INDEX "', 'CREATE INDEX IF NOT EXISTS "'))
    .join('\n');
}

function isTagChar(c: string, first: boolean): boolean {
  return c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (!first && c >= '0' && c <= '9');
}

/** Splits SQL text into statements, keeping quoted text, comments, and dollar-quoted bodies intact. */
export function splitSQL(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let dollarTag = '';
  let words: string[] = [];
  let depth = 0;
  const flush = (end: number) => {
    let s = text.slice(start, end).trim();
    while (s.startsWith('--')) {
      const i = s.indexOf('\n');
      s = i >= 0 ? s.slice(i + 1).trim() : '';
    }
    if (s !== '') out.push(s);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) {
      if (c === '*' && text[i + 1] === '/') { blockComment = false; i++; }
      continue;
    }
    if (dollarTag !== '') {
      if (text.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = ''; }
      continue;
    }
    if (quote !== '') {
      if (c === quote) {
        if (text[i + 1] === quote) { i++; continue; }
        if (i > 0 && text[i - 1] === '\\' && quote === "'") continue;
        quote = '';
      } else if (c === '\\' && quote === "'") i++;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') { lineComment = true; i++; continue; }
    if (c === '/' && text[i + 1] === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '$') {
      const end = text.indexOf('$', i + 1);
      if (end >= 0) {
        const body = text.slice(i + 1, end);
        if ([...body].every((ch, j) => isTagChar(ch, j === 0))) {
          dollarTag = text.slice(i, end + 1);
          i = end;
          continue;
        }
      }
    }
    if (wordStart(text, i)) {
      let end = i;
      while (end < text.length && wordByte(text[end]!)) end++;
      const word = text.slice(i, end).toUpperCase();
      if (words.length < 2) words.push(word);
      if (words.length === 2 && words[0] === 'CREATE' && words[1] === 'TRIGGER') {
        if (word === 'BEGIN' || word === 'CASE') depth++;
        else if (word === 'END' && !['IF', 'LOOP', 'WHILE', 'REPEAT'].includes(nextWord(text, end).toUpperCase()) && depth > 0) depth--;
      }
      i = end - 1;
      continue;
    }
    if (c === ';' && depth === 0) { flush(i); start = i + 1; words = []; }
  }
  flush(text.length);
  return out;
}

function wordByte(b: string): boolean {
  return b === '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9');
}

function wordStart(text: string, i: number): boolean {
  const b = text[i]!;
  if (!(b === '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z'))) return false;
  if (i === 0) return true;
  const p = text[i - 1]!;
  return !wordByte(p) && p !== '$' && p !== '.' && p !== '@';
}

function nextWord(text: string, i: number): string {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  let end = i;
  while (end < text.length && wordByte(text[end]!)) end++;
  return text.slice(i, end);
}
