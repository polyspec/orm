// The neutral intermediate model of introspection and document building (docs/spec/dialects.md "Introspection").
// The dialect reader fills the catalog, and the document writes the dbspec text and parses it, so
// an object on a line that the parse rejects is reported as unsupported and removed.
import { present } from '../present.js';
import { typeText } from './emit.js';
import type { DbspecAction, DbspecDocument, DbspecType } from './model.js';
import { parseDocument } from './parse.js';

/**
 * An object that introspection cannot read into dbspec (docs/spec/dialects.md
 * "Introspection", "Unsupported objects"): its kind, its table and name
 * where it has them ('' otherwise), and the reason.
 */
export interface DbspecUnsupported {
  readonly kind: string;
  readonly table: string;
  readonly name: string;
  readonly reason: string;
}

export interface IColumn {
  name: string;
  type: DbspecType;
  nullable: boolean;
  identity: boolean;
  /** The dbspec default text (`now` or a literal), or '' if there is none. */
  dflt: string;
}

export interface IKey {
  name: string;
  columns: string[];
  desc: boolean[];
}

export interface IForeignKey {
  name: string;
  columns: string[];
  table: string;
  refs: string[];
  onDelete: DbspecAction;
  onUpdate: DbspecAction;
}

interface ICheck {
  name: string;
  predicate: string;
}

export interface ITable {
  name: string;
  columns: IColumn[];
  primary: string[];
  uniques: IKey[];
  indexes: IKey[];
  fks: IForeignKey[];
  checks: ICheck[];
  settings: string[];
}

/** The object that one dbspec text line represents. kind is the kind of DbspecUnsupported. */
interface LineObject {
  kind: string;
  table: string;
  name: string;
}

/** The UTF-8 byte order, the same as Go's strings.Compare. */
export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Writes a string as a dbspec string literal. */
export function quote(s: string): string {
  return "'" + s.replaceAll("'", "''") + "'";
}

export class Catalog {
  tables: ITable[] = [];
  unsupported: DbspecUnsupported[] = [];

  report(kind: string, table: string, name: string, reason: string): void {
    this.unsupported.push({ kind, table, name, reason });
  }

  table(name: string): ITable | undefined {
    return this.tables.find(t => t.name === name);
  }

  addTable(name: string, primary: string[] = [], fks: IForeignKey[] = []): void {
    this.tables.push({ name, columns: [], primary, uniques: [], indexes: [], fks, checks: [], settings: [] });
  }

  /** Removes the columns whose type is not determined. */
  dropColumn(table: string, column: string): void {
    const t = present(this.table(table), 'this.table(table)');
    const i = t.columns.findIndex(c => c.name === column);
    if (i >= 0) t.columns.splice(i, 1);
  }

  /**
   * Writes the intermediate model as dbspec text and parses it. If the parse rejects a line, the
   * object on that line is reported as unsupported and removed, and the document is rebuilt. An object that referred to the removed object
   * is then rejected by the next parse, so it is removed the same way. A diagnostic on a line that belongs to no object
   * is a reader defect, so it is an error.
   */
  document(name: string): { document: DbspecDocument; unsupported: DbspecUnsupported[] } {
    this.dropTablesWithoutKey();
    for (;;) {
      const { text, objects } = this.text(name);
      const parsed = parseDocument(text, Object.freeze({}));
      if (parsed.document !== null) {
        const key = (u: DbspecUnsupported): string => `${u.table}\x00${u.kind}\x00${u.name}`;
        this.unsupported.sort((a, b) => byteOrder(key(a), key(b)));
        return { document: parsed.document, unsupported: this.unsupported };
      }
      // Objects of a rejected table are removed together with the table, so they are not reported separately.
      const rejected = new Set<string>();
      for (const d of parsed.diagnostics) {
        const o = objects.get(d.line);
        if (o === undefined) {
          throw new Error(`introspected document does not parse: ${JSON.stringify(parsed.diagnostics)}\n${text}`);
        }
        if (o.kind === 'table') rejected.add(o.table);
      }
      const removed = new Set<string>();
      for (const d of parsed.diagnostics) {
        const o = present(objects.get(d.line), 'objects.get(d.line)');
        const key = `${o.kind}\x00${o.table}\x00${o.name}`;
        if (removed.has(key) || (o.kind !== 'table' && rejected.has(o.table))) continue;
        removed.add(key);
        this.report(o.kind, o.table, o.name, `${d.rule}: ${d.message}`);
        this.remove(o);
      }
    }
  }

  /** Removes one object. Removing a table or a primary key removes the whole table. */
  private remove(o: LineObject): void {
    const t = this.table(o.table);
    if (t === undefined) throw new Error(`introspected table ${o.table} is not in the catalog`);
    switch (o.kind) {
      case 'table':
        this.tables = this.tables.filter(x => x !== t);
        return;
      case 'column':
        t.columns = t.columns.filter(x => x.name !== o.name);
        return;
      case 'unique':
        t.uniques = t.uniques.filter(x => x.name !== o.name);
        return;
      case 'index':
        t.indexes = t.indexes.filter(x => x.name !== o.name);
        return;
      case 'foreign_key':
        t.fks = t.fks.filter(x => x.name !== o.name);
        return;
      case 'check':
        t.checks = t.checks.filter(x => x.name !== o.name);
        return;
      case 'trigger':
        t.settings = t.settings.filter(x => firstField(x) !== o.name);
        return;
    }
    throw new Error(`unknown introspected object kind ${o.kind}`);
  }

  /** Removes a table without a primary key. A foreign key that referred to that table is rejected by parse, so it is removed too. */
  private dropTablesWithoutKey(): void {
    this.tables = this.tables.filter(t => {
      if (t.primary.length > 0) return true;
      this.report('table', t.name, t.name, 'the table has no primary key');
      return false;
    });
  }

  /**
   * Returns the dbspec text with the tables written in name order, and for each line number, the object on that line.
   * The closing bracket and the primary key line belong to the table.
   */
  private text(name: string): { text: string; objects: Map<number, LineObject> } {
    const tables = [...this.tables].sort((a, b) => byteOrder(a.name, b.name));
    const lines = ['dbspec 1 ' + name];
    const objects = new Map<number, LineObject>();
    const add = (line: string, o: LineObject): void => {
      lines.push(line);
      objects.set(lines.length, o);
    };
    for (const t of tables) {
      const table: LineObject = { kind: 'table', table: t.name, name: t.name };
      lines.push('');
      add(`table ${t.name} {`, table);
      for (const col of t.columns) {
        let s = `  ${col.name} ${typeText(col.type)}`;
        if (col.nullable) s += ' null';
        if (col.identity) s += ' identity';
        if (col.dflt !== '') s += ' default ' + col.dflt;
        add(s, { kind: 'column', table: t.name, name: col.name });
      }
      add(`  primary key (${t.primary.join(', ')})`, table);
      for (const u of t.uniques) add(`  unique ${u.name} (${u.columns.join(', ')})`, { kind: 'unique', table: t.name, name: u.name });
      for (const x of t.indexes) {
        const columns = x.columns.map((col, i) => (x.desc[i] ? col + ' desc' : col));
        add(`  index ${x.name} (${columns.join(', ')})`, { kind: 'index', table: t.name, name: x.name });
      }
      for (const f of t.fks) {
        add(
          `  foreign key ${f.name} (${f.columns.join(', ')}) references ${f.table} (${f.refs.join(', ')}) on delete ${f.onDelete} on update ${f.onUpdate}`,
          { kind: 'foreign_key', table: t.name, name: f.name },
        );
      }
      for (const k of t.checks) add(`  check ${k.name} (${k.predicate})`, { kind: 'check', table: t.name, name: k.name });
      if (t.settings.length > 0) {
        add('  settings {', table);
        for (const s of t.settings) add('    ' + s, { kind: 'trigger', table: t.name, name: firstField(s) });
        add('  }', table);
      }
      add('}', table);
    }
    return { text: lines.join('\n') + '\n', objects };
  }
}

function firstField(s: string): string {
  return present(s.trim().split(/\s+/)[0], 's.trim().split(/\\s+/)[0]');
}

/** Converts a catalog reference action to a dbspec action. Returns null if there is none. */
export function actionName(rule: string): DbspecAction | null {
  switch (rule.toUpperCase()) {
    case 'RESTRICT':
      return 'restrict';
    case 'CASCADE':
      return 'cascade';
    case 'SET NULL':
      return 'set_null';
  }
  return null;
}


/** The type of each column name of a table. */
export function tableTypes(t: ITable): Map<string, DbspecType> {
  return new Map(t.columns.map(c => [c.name, c.type]));
}


/** One row returned by a catalog query. Each value must be the expected JavaScript type. */
export class CatalogRow {
  constructor(
    private readonly query: string,
    private readonly values: readonly unknown[],
  ) {}

  private invalid(i: number, expected: string): Error {
    const value = this.values[i];
    const shown = value === null ? 'null' : typeof value;
    return new TypeError(`catalog query column ${i + 1} is ${shown}, not ${expected}: ${this.query.split('\n')[0]}`);
  }

  text(i: number): string {
    const v = this.values[i];
    if (typeof v !== 'string') throw this.invalid(i, 'a string');
    return v;
  }

  nullableText(i: number): string | null {
    const v = this.values[i];
    if (v === null) return null;
    if (typeof v !== 'string') throw this.invalid(i, 'a string or null');
    return v;
  }

  integer(i: number): number {
    const v = this.values[i];
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (typeof v === 'bigint' && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
    throw this.invalid(i, 'an integer');
  }

  /** A PostgreSQL boolean, or the 0 and 1 of MySQL and SQLite. */
  flag(i: number): boolean {
    const v = this.values[i];
    if (typeof v === 'boolean') return v;
    if (v === 0 || v === 1 || v === 0n || v === 1n) return v === 1 || v === 1n;
    throw this.invalid(i, 'a boolean, 0 or 1');
  }
}

/** Sends one query and returns all rows as arrays of values. A query failure is rejected. */
export type CatalogQuery = (sql: string) => Promise<CatalogRow[]>;
