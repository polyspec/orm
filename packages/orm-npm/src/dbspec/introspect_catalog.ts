// introspection의 중립 중간 model과 문서 만들기 (docs/dialects.md "Introspection").
// dialect reader가 catalog을 채우고, document가 dbspec text를 쓰고 parse해서
// parse가 거부한 줄의 객체를 미지원으로 보고하고 뺀다.
import { typeText } from './emit.js';
import type { DbspecAction, DbspecDocument, DbspecType } from './model.js';
import { parseDocument } from './parse.js';

/**
 * An object that introspection cannot read into dbspec (docs/dialects.md
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
  /** dbspec default text (`now` 또는 literal), 없으면 ''. */
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

export interface ICheck {
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

/** dbspec text 한 줄이 나타내는 객체다. kind는 DbspecUnsupported의 kind다. */
interface LineObject {
  kind: string;
  table: string;
  name: string;
}

/** Go의 strings.Compare와 같은 UTF-8 byte 순서다. */
export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 문자열을 dbspec 문자열 literal로 쓴다. */
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

  /** type이 정해지지 않은 column을 뺀다. */
  dropColumn(table: string, column: string): void {
    const t = this.table(table)!;
    const i = t.columns.findIndex(c => c.name === column);
    if (i >= 0) t.columns.splice(i, 1);
  }

  /**
   * 중간 model을 dbspec text로 쓰고 parse한다. parse가 어떤 줄을 거부하면 그
   * 줄의 객체를 미지원으로 보고하고 빼서 다시 만든다. 빠진 객체를 참조하던
   * 객체는 다음 parse에서 거부되므로 같은 방식으로 빠진다. 객체에 속하지 않는
   * 줄의 diagnostic은 reader의 결함이므로 error다.
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
      // 거부된 table의 객체는 table과 함께 빠지므로 따로 보고하지 않는다.
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
        const o = objects.get(d.line)!;
        const key = `${o.kind}\x00${o.table}\x00${o.name}`;
        if (removed.has(key) || (o.kind !== 'table' && rejected.has(o.table))) continue;
        removed.add(key);
        this.report(o.kind, o.table, o.name, `${d.rule}: ${d.message}`);
        this.remove(o);
      }
    }
  }

  /** 객체 하나를 뺀다. table이나 primary key를 빼면 table 전체가 빠진다. */
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

  /** primary key가 없는 table을 뺀다. 그 table을 참조하던 foreign key는 parse가 거부해 빠진다. */
  private dropTablesWithoutKey(): void {
    this.tables = this.tables.filter(t => {
      if (t.primary.length > 0) return true;
      this.report('table', t.name, t.name, 'the table has no primary key');
      return false;
    });
  }

  /**
   * table을 이름 순으로 쓴 dbspec text와, 줄 번호마다 그 줄의 객체를 돌려준다.
   * 닫는 괄호와 primary key 줄은 table에 속한다.
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
  return s.trim().split(/\s+/)[0]!;
}

/** catalog의 참조 action을 dbspec action으로 바꾼다. 없으면 null이다. */
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

/** renderer CHECK의 이름 <table>$<column>이다. */
export function rendererCheckName(table: string, column: string): string {
  return `${table}$${column}`;
}

/** table의 column 이름마다 type이다. */
export function tableTypes(t: ITable): Map<string, DbspecType> {
  return new Map(t.columns.map(c => [c.name, c.type]));
}

/** Go의 strings.Cut(s, sep): 처음 sep의 앞과 뒤, 그리고 sep이 있었는지. */
export function cut(s: string, sep: string): [string, string, boolean] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, '', false] : [s.slice(0, i), s.slice(i + sep.length), true];
}

/** catalog query가 돌려준 row 하나다. 각 값은 기대한 JavaScript type이어야 한다. */
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

  /** PostgreSQL boolean, 또는 MySQL과 SQLite의 0과 1이다. */
  flag(i: number): boolean {
    const v = this.values[i];
    if (typeof v === 'boolean') return v;
    if (v === 0 || v === 1 || v === 0n || v === 1n) return v === 1 || v === 1n;
    throw this.invalid(i, 'a boolean, 0 or 1');
  }
}

/** query 하나를 보내 모든 row를 값 배열로 돌려준다. query 실패는 reject된다. */
export type CatalogQuery = (sql: string) => Promise<CatalogRow[]>;
