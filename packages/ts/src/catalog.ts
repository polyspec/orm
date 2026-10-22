// The catalog connection (SCH-6a): native table metadata, bounded table pages, validated read-only queries and explicit row
// changes over a MySQL, PostgreSQL or SQLite database selected by its DSN. It follows the Go implementation
// (packages/go/orm/catalog*.go) and the Rust reference (packages/rust/build/src/catalog, docs/spec/interfaces.md).
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import * as codes from './codes.js';
import { driverError, openDriver, parseDsn, sqlitePath, type DriverName, type DriverPool, type DriverSession, type DriverValue } from './driver.js';
import { OrmError } from './runtime_error.js';

/** Budgets of the catalog connection (docs/spec/interfaces.md). A result over its budget is refused, never truncated. */
const METADATA_ROWS = 2048;
const METADATA_BYTES = 4 << 20;
const PAGE_BYTES = 8 << 20;
const SNAPSHOT_BYTES = 8 << 20;
const DEFAULT_QUERY_ROWS = 100000;
const DEFAULT_QUERY_BYTES = 64 << 20;
const SQL_BYTES = 256 << 10;

/** The codes of the catalog connection that the Rust reference names; QUERY_READ_ONLY is the code that tests check. */
const CODE_READ_ONLY = 'QUERY_READ_ONLY';
const CODE_VALUE = 'CATALOG_VALUE';
const CODE_PARAM = 'CATALOG_PARAM';
const CODE_LIMIT = 'CATALOG_LIMIT';
const CODE_METADATA = 'TABLE_METADATA_INVALID';
const CODE_TABLE_REF = 'TABLE_REFERENCE_INVALID';
const CODE_PAGE_CHANGED = 'TABLE_PAGE_METADATA_CHANGED';
const CODE_ROW_CONFLICT = 'ROW_CONFLICT';
const CODE_ROW_SCHEMA = 'ROW_SCHEMA_CHANGED';
const CODE_ROW_WRITE = 'ROW_WRITE_MISMATCH';
const CODE_ROW_SNAPSHOT = 'ROW_SNAPSHOT_INVALID';
const CODE_ROW_AMBIGUOUS = 'ROW_IDENTITY_AMBIGUOUS';
const CODE_ROW_UNSUPPORTED = 'ROW_MUTATION_UNSUPPORTED';
const CODE_COMMIT_REJECTED = 'ROW_COMMIT_REJECTED';
const CODE_COMMIT_UNKNOWN = 'ROW_COMMIT_INDETERMINATE';
const CODE_ROLLBACK_FAILED = 'ROW_ROLLBACK_FAILED';

export interface CatalogTableRef {
  namespace: string;
  name: string;
}

export type CatalogTableKind = 'table' | 'partitioned' | 'view' | 'materialized_view' | 'foreign' | 'virtual' | 'shadow';

export interface CatalogColumn {
  name: string;
  nativeType: string;
  nullable: boolean;
  generated: boolean;
  automaticKey: boolean;
  defaultExpression: string | null;
  expressionDefault: boolean;
}

/** A table: its kind, its columns in physical order, its primary key in constraint order and whether that key is a reliable identity. */
export interface CatalogTableMetadata {
  table: CatalogTableRef;
  kind: CatalogTableKind;
  columns: CatalogColumn[];
  primaryKey: string[];
  reliableRowIdentity: boolean;
}

/** One cell or bound parameter. Integers that fit a JavaScript number are numbers; a larger integer is a bigint and only a grid query returns it. */
export type CatalogValue = null | boolean | number | bigint | string | Uint8Array;

export interface CatalogQueryLimits {
  maxRows?: number;
  maxBytes?: number;
}

export interface CatalogQueryResult {
  rows: CatalogValue[][];
}

export interface CatalogTablePage {
  metadata: CatalogTableMetadata;
  result: { columns: CatalogColumn[]; rows: CatalogValue[][] };
  limit: number;
  offset: number;
  orderBy: string[];
  /** Whether a row follows the page. It is found by a sentinel row; it is not a total count. */
  hasMore: boolean;
  /** The index of the named column in each row of the page, or -1 when the table has no such column. */
  columnIndex(name: string): number;
}

export interface CatalogAssignment {
  name: string;
  value: CatalogValue;
}

export interface CatalogMutationResult {
  columns: string[];
  rows: CatalogValue[][];
}

/** A checked original row. It is not a write authorization: a change re-reads the row by its keys inside its own transaction. */
export class CatalogRowSnapshot {
  public constructor(
    public readonly metadata: CatalogTableMetadata,
    private readonly cells: CatalogValue[],
    private readonly keyIndexes: number[],
    public readonly revision: string,
  ) {}

  /** The primary-key cells in constraint order. */
  public keys(): CatalogValue[] {
    return this.keyIndexes.map(index => this.cells[index] ?? null);
  }

  /** Throws unless the snapshot holds the shape that rowSnapshotFromPage builds. */
  public valid(): void {
    if (this.keyIndexes.length === 0 || this.cells.length !== this.metadata.columns.length) {
      throw new OrmError(CODE_ROW_SNAPSHOT, 'the snapshot was not captured by rowSnapshotFromPage');
    }
  }

  public originalCells(): CatalogValue[] {
    return this.cells;
  }

  public keyIndexList(): number[] {
    return this.keyIndexes;
  }
}

const noop = (): void => undefined;

function err(code: string, message: string, cause?: unknown): OrmError {
  return new OrmError(code, message, cause);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The text of a metadata or result value: a string, or the UTF-8 bytes of a binary value. */
function textOf(value: unknown, what: string): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch (error) {
      throw err(CODE_METADATA, `${what} is not valid UTF-8: ${messageOf(error)}`, error);
    }
  }
  throw err(CODE_METADATA, `expected text for ${what}, got ${typeof value}`);
}

function intOf(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw err(CODE_METADATA, `expected an integer for ${what}, got ${String(value)}`);
}

function boolOf(value: unknown, what: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  throw err(CODE_METADATA, `expected a boolean for ${what}, got ${String(value)}`);
}

/** A name of a namespace, table or column: 1..1024 UTF-8 bytes without NUL. */
function checkName(name: string): void {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (name === '' || bytes > 1024 || name.includes('\0')) throw err(CODE_TABLE_REF, 'expected 1..1024 UTF-8 bytes without NUL');
}

function checkTable(ref: CatalogTableRef): void {
  checkName(ref.namespace);
  checkName(ref.name);
}

function quoteIdent(name: string, dialect: DriverName): string {
  const mark = dialect === 'mysql' ? '`' : '"';
  return mark + name.split(mark).join(mark + mark) + mark;
}

function quoteList(names: readonly string[], dialect: DriverName): string {
  return names.map(name => quoteIdent(name, dialect)).join(',');
}

function qualified(ref: CatalogTableRef, dialect: DriverName): string {
  return `${quoteIdent(ref.namespace, dialect)}.${quoteIdent(ref.name, dialect)}`;
}

function placeholder(index: number, dialect: DriverName): string {
  return dialect === 'postgres' ? `$${index}` : '?';
}

/** Bound parameters: null, boolean, finite number, bigint, string or bytes. */
function checkParams(params: readonly unknown[], code: string): DriverValue[] {
  return params.map((param, index) => {
    if (param === null || typeof param === 'boolean' || typeof param === 'string' || typeof param === 'bigint' || param instanceof Uint8Array) {
      return param;
    }
    if (typeof param === 'number' && Number.isFinite(param)) return param;
    throw err(code, `parameter ${index + 1} has unsupported type ${typeof param} or is not finite`);
  });
}

/** A bigint inside the safe integer range becomes a number; a larger one stays a bigint. */
function plainDriverValue(value: unknown): unknown {
  if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return value;
}

/** A driver value as a catalog value. A grid query keeps an integer outside the safe range as a bigint; a plain query refuses it. */
function catalogValue(value: unknown, grid: boolean): CatalogValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw err(CODE_VALUE, 'a non-finite number is not a catalog value');
    return value;
  }
  if (typeof value === 'bigint') {
    if (grid) return value;
    throw err(CODE_VALUE, `integer ${value.toString()} is outside the JavaScript safe integer range; use readOnlyGridQuery`);
  }
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw err(CODE_VALUE, `unsupported driver value of type ${typeof value}`);
}

/** The canonical key of a cell: its type and its exact value. Two cells are equal exactly when their keys are equal. */
function cellKey(cell: unknown): string {
  if (cell === null) return 'n';
  if (typeof cell === 'boolean') return cell ? 'b1' : 'b0';
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) throw err(CODE_ROW_SNAPSHOT, 'non-finite number cell');
    return `d${Object.is(cell, -0) ? '-0' : String(cell)}`;
  }
  if (typeof cell === 'bigint') return `i${cell.toString()}`;
  if (typeof cell === 'string') return `s${Buffer.byteLength(cell, 'utf8')}:${cell}`;
  if (cell instanceof Uint8Array) return `x${Buffer.from(cell).toString('hex')}`;
  throw err(CODE_ROW_SNAPSHOT, `unsupported cell type ${typeof cell}`);
}

function sameCell(a: unknown, b: unknown): boolean {
  return cellKey(a) === cellKey(b);
}

function sameRow(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((cell, index) => sameCell(cell, b[index]));
}

/** Two descriptors are equal when their canonical JSON is equal; the fields are always built in one order. */
function sameDescriptor(a: CatalogTableMetadata, b: CatalogTableMetadata): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The key columns of a descriptor as column indexes in constraint order; it must have a reliable identity. */
function descriptorKeys(metadata: CatalogTableMetadata): number[] {
  const invalid = (reason: string): OrmError => err(CODE_ROW_SNAPSHOT, `invalid original row or descriptor: ${reason}`);
  if (metadata.kind !== 'table' && metadata.kind !== 'partitioned') throw invalid('the relation is not a table');
  if (!metadata.reliableRowIdentity || metadata.primaryKey.length === 0 || metadata.columns.length === 0 || metadata.columns.length > METADATA_ROWS) {
    throw invalid('no reliable row identity');
  }
  const names = new Set<string>();
  for (const column of metadata.columns) {
    try { checkName(column.name); } catch (error) { throw invalid(messageOf(error)); }
    if (names.has(column.name) || column.nativeType.includes('\0')) throw invalid('duplicate column or invalid native type');
    names.add(column.name);
  }
  const keys = new Set<string>();
  return metadata.primaryKey.map(key => {
    if (keys.has(key)) throw invalid('duplicate key column');
    keys.add(key);
    const index = metadata.columns.findIndex(column => column.name === key);
    const column = metadata.columns[index];
    if (column === undefined || column.nullable) throw invalid('key column is missing or nullable');
    return index;
  });
}

function checkCells(metadata: CatalogTableMetadata, cells: readonly unknown[]): void {
  if (cells.length !== metadata.columns.length) throw err(CODE_ROW_SNAPSHOT, `row has ${cells.length} cells for ${metadata.columns.length} columns`);
  cells.forEach((cell, index) => {
    const column = metadata.columns[index];
    if (cell === null && column !== undefined && !column.nullable) throw err(CODE_ROW_SNAPSHOT, `NULL in non-null column "${column.name}"`);
    cellKey(cell);
  });
}

function revisionOf(metadata: CatalogTableMetadata, cells: readonly unknown[]): string {
  let encoded = JSON.stringify({ tag: 'orm-catalog-row-v1', metadata });
  for (const cell of cells) {
    const key = cellKey(cell);
    encoded += `${Buffer.byteLength(key, 'utf8')}:${key}`;
  }
  if (Buffer.byteLength(encoded, 'utf8') > SNAPSHOT_BYTES) throw err('ROW_SNAPSHOT_LIMIT', 'original row encoding exceeds its budget');
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

/** Checks named assignments against a descriptor, in the order given. */
function checkChanges(metadata: CatalogTableMetadata, values: readonly CatalogAssignment[], code: string): Array<{ index: number; value: DriverValue }> {
  if (values.length === 0 || values.length > metadata.columns.length) throw err(code, 'invalid column assignments');
  const params = checkParams(values.map(assignment => assignment.value), code);
  const seen = new Set<string>();
  return values.map((assignment, position) => {
    const index = metadata.columns.findIndex(column => column.name === assignment.name);
    if (index < 0) throw err(code, `unknown column "${assignment.name}"`);
    const column = metadata.columns[index];
    if (column === undefined) throw err(code, `unknown column "${assignment.name}"`);
    if (seen.has(column.name)) throw err(code, `duplicate column "${column.name}"`);
    if (column.generated) throw err(code, `generated column "${column.name}" is not writable`);
    const value = params[position] ?? null;
    if (value === null && !column.nullable) throw err(code, `NULL in non-null column "${column.name}"`);
    seen.add(column.name);
    return { index, value };
  });
}

/** Read-only statement validation. The words of a query are read with string literals, quoted identifiers and comments skipped. */
const READ_ONLY_START = new Set(['SELECT', 'WITH', 'VALUES']);
const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'CALL', 'DO',
  'INTO', 'LOCK', 'SHARE', 'PROCEDURE', 'LOAD', 'COPY', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE',
]);

function isLetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/** The index after the quoted literal or identifier that starts at start; undefined when it is not terminated. */
function skipQuoted(query: string, start: number, quote: string, backslash: boolean): number | undefined {
  for (let i = start + 1; i < query.length; i++) {
    const c = query.charAt(i);
    if (backslash && c === '\\') {
      i++;
    } else if (c === quote) {
      if (query.charAt(i + 1) === quote) {
        i++;
        continue;
      }
      return i + 1;
    }
  }
  return undefined;
}

/** The upper-cased words and semicolons of a query. It reports undefined for an unterminated literal or comment and for a MySQL executable comment. */
function queryWords(query: string, dialect: DriverName): string[] | undefined {
  const words: string[] = [];
  let i = 0;
  while (i < query.length) {
    const c = query.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i++;
    } else if (c === '-' && query.startsWith('--', i)) {
      const newline = query.indexOf('\n', i);
      if (newline < 0) return words;
      i = newline + 1;
    } else if (c === '/' && query.startsWith('/*', i)) {
      if (query.startsWith('/*!', i) || query.startsWith('/*M!', i)) return undefined;
      const close = query.indexOf('*/', i + 2);
      if (close < 0) return undefined;
      i = close + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      // MySQL reads backslash escapes inside string literals and double-quoted strings; the other dialects do not.
      const next = skipQuoted(query, i, c, dialect === 'mysql' && c !== '`');
      if (next === undefined) return undefined;
      i = next;
    } else if (c === '_' || isLetter(c)) {
      let j = i;
      while (j < query.length && /[A-Za-z0-9_$]/.test(query.charAt(j))) j++;
      words.push(query.slice(i, j).toUpperCase());
      i = j;
    } else if (isDigit(c)) {
      let j = i;
      while (j < query.length && /[A-Za-z0-9_.]/.test(query.charAt(j))) j++;
      i = j;
    } else {
      if (c === ';') words.push(';');
      i++;
    }
  }
  return words;
}

function validateReadOnly(query: string, dialect: DriverName): void {
  const refused = (): OrmError => err(CODE_READ_ONLY, 'expected one supported non-locking read query');
  if (query === '' || Buffer.byteLength(query, 'utf8') > SQL_BYTES) throw refused();
  const words = queryWords(query, dialect);
  if (words === undefined || words.length === 0) throw refused();
  if (!READ_ONLY_START.has(words[0] ?? '')) throw refused();
  words.forEach((word, index) => {
    if (word === ';') {
      // Only one trailing semicolon is allowed; anything after it would be a second statement.
      if (index !== words.length - 1) throw refused();
      return;
    }
    if (WRITE_WORDS.has(word)) throw refused();
  });
}

const KIND_SQL: Record<DriverName, string> = {
  mysql: 'SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
  postgres: 'SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2',
  sqlite: 'SELECT type FROM pragma_table_list WHERE schema=? AND name=?',
};

/** The columns of a relation in physical order: name, native type, nullable, generated, primary-key ordinal, automatic key, default and whether the default is an expression. */
const COLUMNS_SQL: Record<DriverName, string> = {
  mysql: "SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE='YES',(c.GENERATION_EXPRESSION IS NOT NULL AND c.GENERATION_EXPRESSION<>''),COALESCE(pk.ORDINAL_POSITION,0),(c.EXTRA LIKE '%auto_increment%'),c.COLUMN_DEFAULT,(c.EXTRA LIKE '%DEFAULT_GENERATED%') FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE pk ON pk.CONSTRAINT_SCHEMA=c.TABLE_SCHEMA AND pk.TABLE_NAME=c.TABLE_NAME AND pk.COLUMN_NAME=c.COLUMN_NAME AND pk.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",
  postgres: 'SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>\'\' OR a.attidentity=\'a\'),COALESCE(k.ord,0),(a.attidentity<>\'\'),pg_get_expr(d.adbin,d.adrelid),(d.adbin IS NOT NULL) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum',
  sqlite: 'SELECT name,type,NOT "notnull",hidden<>0,pk,0,dflt_value,(dflt_value IS NOT NULL) FROM pragma_table_xinfo(?,?) ORDER BY cid',
};

function catalogKind(dialect: DriverName, native: string): CatalogTableKind {
  if ((dialect === 'mysql' && native === 'BASE TABLE') || (dialect === 'postgres' && native === 'r') || (dialect === 'sqlite' && native === 'table')) return 'table';
  if ((dialect === 'mysql' && (native === 'VIEW' || native === 'SYSTEM VIEW')) || (dialect === 'postgres' && native === 'v') || (dialect === 'sqlite' && native === 'view')) return 'view';
  if (dialect === 'postgres' && native === 'p') return 'partitioned';
  if (dialect === 'postgres' && native === 'm') return 'materialized_view';
  if (dialect === 'postgres' && native === 'f') return 'foreign';
  if (dialect === 'sqlite' && native === 'virtual') return 'virtual';
  if (dialect === 'sqlite' && native === 'shadow') return 'shadow';
  throw err('TABLE_KIND_UNSUPPORTED', `relation kind "${native}" of ${dialect}`);
}

/** A bound session: one pooled connection inside one transaction. It is discarded when it ends, so a session setting never returns to the pool. */
class Session {
  public constructor(public readonly dialect: DriverName, private readonly session: DriverSession) {}

  /** Runs a statement that returns rows. A bounded result over maxRows or maxBytes is refused. */
  public async rows(sql: string, params: readonly unknown[], maxRows: number, maxBytes: number): Promise<unknown[][]> {
    const bound = checkParams(params, CODE_PARAM);
    const result = bound.length === 0
      ? await this.session.control(sql, [], noop)
      : await this.session.execute(sql, bound, undefined, noop);
    if (result.rows.length > maxRows) throw err(CODE_LIMIT, `result has more than ${maxRows} rows`);
    let budget = 0;
    const rows = result.rows.map(row => row.map(plainDriverValue));
    for (const row of rows) {
      for (const value of row) {
        budget += typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value instanceof Uint8Array ? value.length : 8;
      }
    }
    if (budget > maxBytes) throw err(CODE_LIMIT, `result has more than ${maxBytes} bytes of values`);
    return rows;
  }

  /** Runs a statement that changes rows and returns the number of rows it affected. */
  public async exec(sql: string, params: readonly unknown[]): Promise<number> {
    const bound = checkParams(params, CODE_PARAM);
    const result = bound.length === 0
      ? await this.session.control(sql, [], noop)
      : await this.session.execute(sql, bound, undefined, noop);
    return result.affected;
  }

  public async control(sql: string): Promise<void> {
    await this.session.control(sql, [], noop);
  }

  /** Returns the connection to the pool, or closes it when discard is set. */
  public release(discard: boolean): void {
    this.session.release(discard);
  }

  /** Reads one table descriptor: the kind, the columns, the key in constraint order and the identity flag. */
  public async describe(ref: CatalogTableRef): Promise<CatalogTableMetadata> {
    checkTable(ref);
    if (this.dialect === 'sqlite' && ref.namespace !== 'main') throw err('TABLE_NAMESPACE_UNSUPPORTED', 'SQLite requires main');
    const kindRows = await this.rows(KIND_SQL[this.dialect], [ref.namespace, ref.name], 2, METADATA_BYTES);
    if (kindRows.length === 0) throw err('TABLE_NOT_FOUND', `${ref.namespace}.${ref.name}`);
    const [kindRow] = kindRows;
    if (kindRows.length !== 1 || kindRow === undefined || kindRow.length !== 1) throw err(CODE_METADATA, 'ambiguous relation');
    const kind = catalogKind(this.dialect, textOf(kindRow[0], 'relation kind'));

    // SQLite table-valued pragmas take the table name first and the schema second.
    const args = this.dialect === 'sqlite' ? [ref.name, ref.namespace] : [ref.namespace, ref.name];
    const rows = await this.rows(COLUMNS_SQL[this.dialect], args, METADATA_ROWS, METADATA_BYTES);

    const columns: CatalogColumn[] = [];
    const keys: Array<{ ordinal: number; index: number }> = [];
    for (const row of rows) {
      if (row.length !== 8) throw err(CODE_METADATA, `column shape of ${row.length} values`);
      const name = textOf(row[0], 'column name');
      checkName(name);
      if (columns.some(existing => existing.name === name)) throw err(CODE_METADATA, `duplicate column "${name}"`);
      const ordinal = intOf(row[4], 'key ordinal');
      if (ordinal < 0) throw err(CODE_METADATA, 'negative key ordinal');
      let defaultExpression: string | null;
      if (row[6] === null) defaultExpression = null;
      else defaultExpression = textOf(row[6], `default of column "${name}"`);
      const column: CatalogColumn = {
        name,
        nativeType: textOf(row[1], `native type of column "${name}"`),
        nullable: boolOf(row[2], 'nullable'),
        generated: boolOf(row[3], 'generated'),
        automaticKey: boolOf(row[5], 'automatic key'),
        defaultExpression,
        expressionDefault: boolOf(row[7], 'expression default'),
      };
      if (ordinal > 0) keys.push({ ordinal, index: columns.length });
      columns.push(column);
    }
    keys.sort((a, b) => a.ordinal - b.ordinal);
    keys.forEach((key, position) => {
      if (key.ordinal !== position + 1) throw err(CODE_METADATA, 'key order');
    });

    // A SQLite INTEGER primary key without a separate primary-key index is the rowid alias: never NULL, generated by the database.
    const onlyKey = keys[0];
    if (this.dialect === 'sqlite' && kind === 'table' && keys.length === 1 && onlyKey !== undefined) {
      const keyColumn = columns[onlyKey.index];
      if (keyColumn !== undefined && keyColumn.nativeType.toUpperCase() === 'INTEGER') {
        const [indexRow] = await this.rows("SELECT count(*) FROM pragma_index_list(?,?) WHERE origin='pk'", args, 1, METADATA_BYTES);
        if (indexRow === undefined || indexRow.length !== 1) throw err(CODE_METADATA, 'primary index count');
        if (intOf(indexRow[0], 'primary index count') === 0) {
          keyColumn.nullable = false;
          keyColumn.automaticKey = true;
        }
      }
    }

    let reliable = (kind === 'table' || kind === 'partitioned') && keys.length > 0;
    const primaryKey: string[] = [];
    for (const key of keys) {
      const column = columns[key.index];
      if (column === undefined) throw err(CODE_METADATA, 'key column index');
      if (column.nullable) reliable = false;
      primaryKey.push(column.name);
    }
    return { table: ref, kind, columns, primaryKey, reliableRowIdentity: reliable };
  }

  /** The rows that match a descriptor's key, at most two. A lock takes FOR UPDATE on a server that supports it; SQLite's write transaction already holds the lock. */
  public async lookup(metadata: CatalogTableMetadata, keys: readonly CatalogValue[], lock: boolean): Promise<CatalogValue[][]> {
    const suffix = lock && this.dialect !== 'sqlite' ? ' FOR UPDATE' : '';
    const predicate = metadata.primaryKey
      .map((name, index) => `${quoteIdent(name, this.dialect)}=${placeholder(index + 1, this.dialect)}`)
      .join(' AND ');
    const sql = `SELECT ${quoteList(metadata.columns.map(column => column.name), this.dialect)} FROM ${qualified(metadata.table, this.dialect)}` +
      ` WHERE ${predicate} LIMIT 2${suffix}`;
    const rows = await this.rows(sql, keys, 2, PAGE_BYTES);
    return rows.map(row => {
      if (row.length !== metadata.columns.length) throw err(CODE_ROW_WRITE, 'row shape differs from descriptor');
      return row.map(cell => catalogValue(cell, false));
    });
  }

  /** Refuses a MySQL row change unless the server, the account and the table are verified (mutation.rs, mysql_safety). */
  public async mysqlSafety(metadata: CatalogTableMetadata): Promise<void> {
    const unsupported = (reason: string): OrmError => err(CODE_ROW_UNSUPPORTED, reason);
    const [partial] = await this.rows('SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)', [], 1, 4096);
    if (partial === undefined || partial.length !== 1 || partial[0] !== 0) throw unsupported('MySQL partial-revoke visibility requires verification');

    const [account] = await this.rows('SELECT CURRENT_USER()', [], 1, 4096);
    if (account === undefined || account.length !== 1) throw unsupported('unverifiable MySQL account');
    const text = textOf(account[0], 'MySQL account');
    const at = text.lastIndexOf('@');
    if (at < 0) throw unsupported('unverifiable MySQL account');
    const grantee = `'${text.slice(0, at)}'@'${text.slice(at + 1)}'`;

    const grants = await this.rows(
      "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND PRIVILEGE_TYPE='TRIGGER' " +
        "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER' " +
        "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER'",
      [grantee, grantee, metadata.table.namespace, grantee, metadata.table.namespace, metadata.table.name],
      16,
      4096,
    );
    const trigger = grants.some(row => row.length === 1 && row[0] === 'TRIGGER');
    if (!trigger) throw unsupported('MySQL trigger visibility is unverified');

    const [engine] = await this.rows('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
      [metadata.table.namespace, metadata.table.name], 2, 4096);
    if (engine === undefined || engine.length !== 1 || typeof engine[0] !== 'string' || engine[0].toLowerCase() !== 'innodb') {
      throw unsupported('MySQL requires InnoDB');
    }

    const triggers = await this.rows('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? LIMIT 1',
      [metadata.table.namespace, metadata.table.name], 1, 4096);
    if (triggers.length !== 0) throw unsupported('MySQL triggers require effect verification');
  }
}

const BEGIN_SQL: Record<DriverName, { read: string; write: string }> = {
  mysql: { read: 'START TRANSACTION READ ONLY', write: 'START TRANSACTION' },
  postgres: { read: 'BEGIN READ ONLY', write: 'BEGIN' },
  sqlite: { read: 'BEGIN', write: 'BEGIN IMMEDIATE' },
};

/** A native catalog connection to a MySQL, PostgreSQL or SQLite database selected by its DSN. */
export class CatalogConnection {
  public constructor(public readonly dialect: DriverName, private readonly pool: DriverPool) {}

  /** Releases the connection pool. */
  public async close(): Promise<void> {
    await this.pool.close();
  }

  /** Opens a session in a read-only transaction, or a writable one. */
  private async begin(readOnly: boolean): Promise<Session> {
    const session = new Session(this.dialect, await this.pool.reserve());
    try {
      // SQLite has one connection that every session shares, so each session sets query_only itself and does not inherit it.
      if (this.dialect === 'sqlite') await session.control(`PRAGMA query_only=${readOnly ? 'ON' : 'OFF'}`);
      await session.control(readOnly ? BEGIN_SQL[this.dialect].read : BEGIN_SQL[this.dialect].write);
    } catch (error) {
      session.release(true);
      throw driverError(this.dialect, error);
    }
    return session;
  }

  /** Runs work in a fresh read-only session, rolls the session back and returns the value. */
  private async read<T>(work: (session: Session) => Promise<T>): Promise<T> {
    const session = await this.begin(true);
    let value: T;
    try {
      value = await work(session);
    } catch (error) {
      throw await this.endSession(session, error);
    }
    const failure = await this.endSession(session, undefined);
    if (failure !== undefined) throw failure;
    return value;
  }

  /** Runs work in a writable transaction. A failed work rolls back; a rejected commit rolls back; any other commit failure is an unknown outcome that must not be retried. */
  private async write<T>(work: (session: Session) => Promise<T>): Promise<T> {
    const session = await this.begin(false);
    let value: T;
    try {
      value = await work(session);
    } catch (error) {
      throw await this.endSession(session, error);
    }
    try {
      await session.control('COMMIT');
    } catch (error) {
      const mapped = driverError(this.dialect, error);
      if (mapped.code === codes.DUPLICATE_KEY || mapped.code === codes.FOREIGN_KEY || mapped.code === codes.CONSTRAINT || mapped.code === codes.DEADLOCK) {
        throw await this.endSession(session, err(CODE_COMMIT_REJECTED, `native commit rejected: ${mapped.message}`, mapped));
      }
      session.release(true);
      throw err(CODE_COMMIT_UNKNOWN, `commit outcome unknown; do not retry: ${mapped.message}`, mapped);
    }
    session.release(true);
    return value;
  }

  /** Rolls back, releases the connection discarded and returns the error to throw, joined with a failed rollback. */
  private async endSession(session: Session, error: unknown): Promise<OrmError | undefined> {
    let failure: OrmError | undefined = error === undefined ? undefined : driverError(this.dialect, error);
    try {
      await session.control('ROLLBACK');
    } catch (rollbackError) {
      const rolled = driverError(this.dialect, rollbackError);
      failure = failure === undefined
        ? err(CODE_ROLLBACK_FAILED, `rollback: ${rolled.message}`, rolled)
        : err(CODE_ROLLBACK_FAILED, `${failure.message}; rollback: ${rolled.message}`, failure);
    }
    session.release(true);
    return failure;
  }

  /** The namespace of the connection: the current schema of PostgreSQL, the current database of MySQL, and main for SQLite. */
  public async currentNamespace(): Promise<string> {
    if (this.dialect === 'sqlite') return 'main';
    const query = this.dialect === 'postgres' ? 'SELECT current_schema()' : 'SELECT DATABASE()';
    return this.read(async session => {
      const rows = await session.rows(query, [], 2, METADATA_BYTES);
      const [row] = rows;
      if (rows.length !== 1 || row === undefined || row.length !== 1) throw err('TABLE_NAMESPACE_UNAVAILABLE', 'the connection reported no single namespace');
      const name = row[0];
      if (typeof name !== 'string') throw err('TABLE_NAMESPACE_UNAVAILABLE', 'the connection reported no text namespace');
      checkName(name);
      return name;
    });
  }

  /** Reads the metadata of an explicitly qualified table. */
  public async describeTable(table: CatalogTableRef): Promise<CatalogTableMetadata> {
    return this.read(session => session.describe(table));
  }

  /** Reads one bounded page of a table in primary-key order. The descriptor must be the same before and after the read. */
  public async tablePage(table: CatalogTableRef, limit: number, offset: number): Promise<CatalogTablePage> {
    checkTable(table);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      throw err('TABLE_PAGE_INVALID', 'limit requires 1..1000 and offset 0..1000000');
    }
    return this.read(async session => {
      const metadata = await session.describe(table);
      if (metadata.columns.length === 0) throw err('TABLE_PAGE_UNSUPPORTED', 'relation has no selectable columns');
      let sql = `SELECT ${quoteList(metadata.columns.map(column => column.name), this.dialect)} FROM ${qualified(table, this.dialect)}`;
      if (metadata.primaryKey.length > 0) sql += ` ORDER BY ${quoteList(metadata.primaryKey, this.dialect)}`;
      // One extra row is the sentinel that reports hasMore.
      sql += ` LIMIT ${limit + 1} OFFSET ${offset}`;
      const raw = await session.rows(sql, [], limit + 1, PAGE_BYTES);
      if (raw.some(row => row.length !== metadata.columns.length)) throw err(CODE_PAGE_CHANGED, 'prepared columns differ from descriptor');
      const after = await session.describe(table);
      if (!sameDescriptor(after, metadata)) throw err(CODE_PAGE_CHANGED, 'descriptor changed during read');
      let rows = raw.map(row => row.map(cell => catalogValue(cell, false)));
      const hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);
      const columns = metadata.columns.map(column => ({ ...column }));
      return {
        metadata,
        result: { columns, rows },
        limit,
        offset,
        orderBy: [...metadata.primaryKey],
        hasMore,
        columnIndex: (name: string): number => metadata.columns.findIndex(column => column.name === name),
      };
    });
  }

  /** Runs one read query (SELECT, WITH or VALUES) in a fresh read-only session. Integers outside the safe range are refused. */
  public async readOnlyQuery(query: string, params: readonly unknown[], limits: CatalogQueryLimits = {}): Promise<CatalogQueryResult> {
    return { rows: await this.runReadOnly(query, params, limits, false) };
  }

  /** Runs one read query like readOnlyQuery; an integer outside the safe range is returned as a bigint and no value is narrowed. */
  public async readOnlyGridQuery(query: string, params: readonly unknown[], limits: CatalogQueryLimits = {}): Promise<CatalogQueryResult> {
    return { rows: await this.runReadOnly(query, params, limits, true) };
  }

  private async runReadOnly(query: string, params: readonly unknown[], limits: CatalogQueryLimits, grid: boolean): Promise<CatalogValue[][]> {
    validateReadOnly(query, this.dialect);
    if ((limits.maxRows ?? 0) < 0 || (limits.maxBytes ?? 0) < 0) throw err('QUERY_LIMIT_INVALID', 'limits must not be negative');
    const maxRows = limits.maxRows || DEFAULT_QUERY_ROWS;
    const maxBytes = limits.maxBytes || DEFAULT_QUERY_BYTES;
    const bound = checkParams(params, CODE_PARAM);
    return this.read(async session => {
      const raw = await session.rows(query, bound, maxRows, maxBytes);
      return raw.map(row => row.map(cell => catalogValue(cell, grid)));
    });
  }

  /** Captures the row at index of a page. The table must have a reliable identity, and the page must be a page of that table as tablePage reads it. */
  public rowSnapshotFromPage(page: CatalogTablePage, index: number): CatalogRowSnapshot {
    const invalid = (reason: string): OrmError => err(CODE_ROW_SNAPSHOT, `invalid original row or descriptor: ${reason}`);
    try { checkTable(page.metadata.table); } catch (error) { throw invalid(messageOf(error)); }
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000 || page.offset < 0 || page.offset > 1000000) {
      throw err(CODE_ROW_SNAPSHOT, 'invalid page bounds');
    }
    const rows = page.result.rows;
    const orderMatches = page.orderBy.length === page.metadata.primaryKey.length && page.orderBy.every((name, i) => name === page.metadata.primaryKey[i]);
    if (rows.length > page.limit || (page.hasMore && rows.length !== page.limit) || !orderMatches) {
      throw err(CODE_ROW_SNAPSHOT, 'page rows or order do not match its bounds');
    }
    const keyIndexes = descriptorKeys(page.metadata);
    const sameColumns = page.result.columns.length === page.metadata.columns.length &&
      page.result.columns.every((column, i) => column.name === page.metadata.columns[i]?.name);
    if (!sameColumns) throw err(CODE_ROW_SNAPSHOT, 'projection differs from descriptor');
    const row = rows[index];
    if (index < 0 || row === undefined) throw err(CODE_ROW_SNAPSHOT, `row index ${index} outside the page`);
    const cells = [...row];
    checkCells(page.metadata, cells);
    return new CatalogRowSnapshot(page.metadata, cells, keyIndexes, revisionOf(page.metadata, cells));
  }

  /** Inserts one row with explicit primary-key values. It rejects an existing key, requires exactly one affected row and re-reads the row before it commits. */
  public async insertRow(declared: CatalogTableMetadata, values: readonly CatalogAssignment[]): Promise<CatalogMutationResult> {
    const keyIndexes = descriptorKeys(declared);
    const changes = checkChanges(declared, values, 'ROW_INSERT_INVALID');
    const provided = new Map(changes.map(change => [change.index, change.value] as const));
    const keys = keyIndexes.map(index => {
      if (!provided.has(index)) throw err('ROW_INSERT_INVALID', `explicit primary-key value of "${declared.columns[index]?.name ?? ''}" is required`);
      return provided.get(index) ?? null;
    });
    return this.write(async session => {
      if (this.dialect === 'postgres') {
        // The lock an INSERT takes, held before the schema check so that no DDL changes the table in between.
        await session.control(`LOCK TABLE ${qualified(declared.table, this.dialect)} IN ROW EXCLUSIVE MODE`);
      }
      const existing = await session.lookup(declared, keys, true);
      if (existing.length !== 0) throw err(CODE_ROW_CONFLICT, 'insertion key already exists');
      const descriptor = await session.describe(declared.table);
      if (!sameDescriptor(descriptor, declared)) throw err(CODE_ROW_SCHEMA, 'insertion descriptor changed');
      if (this.dialect === 'mysql') await session.mysqlSafety(descriptor);
      const names = changes.map(change => quoteIdent(descriptor.columns[change.index]?.name ?? '', this.dialect));
      const marks = changes.map((_, index) => placeholder(index + 1, this.dialect));
      const args = changes.map(change => change.value);
      const affected = await session.exec(
        `INSERT INTO ${qualified(descriptor.table, this.dialect)} (${names.join(',')}) VALUES (${marks.join(',')})`,
        args,
      );
      if (affected !== 1) throw err(CODE_ROW_WRITE, `expected exactly one inserted row, got ${affected}`);
      const after = await session.lookup(descriptor, keys, false);
      if (after.length !== 1) throw err(CODE_ROW_WRITE, 'expected exactly one inserted row');
      const afterDescriptor = await session.describe(declared.table);
      if (!sameDescriptor(afterDescriptor, descriptor)) throw err(CODE_ROW_SCHEMA, 'insertion descriptor changed');
      const [stored] = after;
      if (stored === undefined) throw err(CODE_ROW_WRITE, 'expected exactly one inserted row');
      for (const change of changes) {
        if (!sameCell(stored[change.index], change.value)) {
          throw err(CODE_ROW_WRITE, `stored inserted values of "${descriptor.columns[change.index]?.name ?? ''}" differ`);
        }
      }
      return { columns: descriptor.columns.map(column => column.name), rows: after };
    });
  }

  /** Updates the row of an original snapshot. Inside the transaction it locks the row by its original keys, compares it with the snapshot and writes; then it re-reads the row and requires the written values. */
  public async updateRow(original: CatalogRowSnapshot, values: readonly CatalogAssignment[]): Promise<CatalogMutationResult> {
    original.valid();
    const changes = checkChanges(original.metadata, values, 'ROW_UPDATE_INVALID');
    const updated = [...original.originalCells()];
    for (const change of changes) updated[change.index] = change.value;
    try { checkCells(original.metadata, updated); } catch (error) {
      throw err('ROW_UPDATE_INVALID', `invalid updated row: ${messageOf(error)}`, error);
    }
    try { revisionOf(original.metadata, updated); } catch (error) {
      throw err('ROW_UPDATE_LIMIT', `updated row budget exceeded: ${messageOf(error)}`, error);
    }
    const keys = original.keys();
    const keyIndexes = original.keyIndexList();
    return this.write(async session => {
      const current = await session.lookup(original.metadata, keys, true);
      const descriptor = await session.describe(original.metadata.table);
      if (!sameDescriptor(descriptor, original.metadata)) throw err(CODE_ROW_SCHEMA, 'original descriptor changed');
      checkCurrent(current, original.originalCells());
      if (this.dialect === 'mysql') await session.mysqlSafety(descriptor);
      const sets = changes.map((change, index) => `${quoteIdent(descriptor.columns[change.index]?.name ?? '', this.dialect)}=${placeholder(index + 1, this.dialect)}`);
      const args: DriverValue[] = [...changes.map(change => change.value), ...keys.map(key => key ?? null)];
      const predicate = descriptor.primaryKey
        .map((name, index) => `${quoteIdent(name, this.dialect)}=${placeholder(changes.length + index + 1, this.dialect)}`)
        .join(' AND ');
      const affected = await session.exec(
        `UPDATE ${qualified(descriptor.table, this.dialect)} SET ${sets.join(',')} WHERE ${predicate}`,
        args,
      );
      // MySQL reports zero for an update that changes nothing; the re-read below is the authority there.
      if (affected > 1 || (affected === 0 && this.dialect !== 'mysql')) throw err(CODE_ROW_WRITE, `unexpected affected row count ${affected}`);
      const newKeys = keyIndexes.map(index => updated[index] ?? null);
      const after = await session.lookup(descriptor, newKeys, false);
      if (after.length !== 1) throw err(CODE_ROW_WRITE, `expected exactly one updated row, got ${after.length}`);
      const afterDescriptor = await session.describe(original.metadata.table);
      if (!sameDescriptor(afterDescriptor, descriptor)) throw err(CODE_ROW_SCHEMA, 'original descriptor changed');
      const [stored] = after;
      if (stored === undefined) throw err(CODE_ROW_WRITE, 'expected exactly one updated row');
      descriptor.columns.forEach((column, index) => {
        if (column.generated) return; // A generated column may be recomputed by the database.
        if (!sameCell(stored[index], updated[index])) throw err(CODE_ROW_WRITE, `stored ordinary values of "${column.name}" differ`);
      });
      return { columns: descriptor.columns.map(column => column.name), rows: after };
    });
  }

  /** Deletes the row of an original snapshot and returns the number of rows deleted. */
  public async deleteRow(original: CatalogRowSnapshot): Promise<number> {
    original.valid();
    const keys = original.keys();
    return this.write(async session => {
      const current = await session.lookup(original.metadata, keys, true);
      const descriptor = await session.describe(original.metadata.table);
      if (!sameDescriptor(descriptor, original.metadata)) throw err(CODE_ROW_SCHEMA, 'original descriptor changed');
      checkCurrent(current, original.originalCells());
      if (this.dialect === 'mysql') await session.mysqlSafety(descriptor);
      const predicate = descriptor.primaryKey.map((name, index) => `${quoteIdent(name, this.dialect)}=${placeholder(index + 1, this.dialect)}`).join(' AND ');
      const affected = await session.exec(`DELETE FROM ${qualified(descriptor.table, this.dialect)} WHERE ${predicate}`, keys);
      if (affected !== 1) throw err(CODE_ROW_WRITE, `expected exactly one deleted row, got ${affected}`);
      const after = await session.lookup(descriptor, keys, false);
      if (after.length !== 0) throw err(CODE_ROW_WRITE, 'deleted row remains');
      const afterDescriptor = await session.describe(original.metadata.table);
      if (!sameDescriptor(afterDescriptor, descriptor)) throw err(CODE_ROW_SCHEMA, 'original descriptor changed');
      return affected;
    });
  }
}

/** Compares the rows that a key read returned with the original cells of a snapshot. */
function checkCurrent(current: readonly CatalogValue[][], original: readonly CatalogValue[]): void {
  if (current.length === 0) throw err(CODE_ROW_CONFLICT, 'original row is missing');
  if (current.length > 1) throw err(CODE_ROW_AMBIGUOUS, 'key selected multiple rows');
  const [row] = current;
  if (row === undefined || !sameRow(row, original)) throw err(CODE_ROW_CONFLICT, 'original values changed');
}

/** Connects to the database that a mysql, postgres or sqlite DSN selects. A markdown DSN is refused, and a SQLite file must exist. */
export async function connectCatalog(dsn: string): Promise<CatalogConnection> {
  const parsed = parseDsn(dsn);
  if (parsed.driver === 'markdown') throw err(codes.CONFIG, 'CATALOG_DSN: a markdown corpus has no database catalog; give a mysql, postgres or sqlite DSN');
  if (parsed.driver === 'sqlite') {
    let regular: boolean;
    try {
      // lstat does not follow a symbolic link: a link is not a regular file.
      regular = lstatSync(sqlitePath(new URL(dsn))).isFile();
    } catch (error) {
      throw err(codes.CONFIG, `CATALOG_SQLITE_FILE: ${messageOf(error)}`, error);
    }
    if (!regular) throw err(codes.CONFIG, 'CATALOG_SQLITE_FILE: expected an existing regular file');
  }
  const bounds = { size: 10, idleSize: 10, lifetimeMs: 0 };
  const pool = openDriver(dsn, parsed, bounds, 256);
  try {
    (await pool.reserve()).release(false);
  } catch (error) {
    await pool.close();
    throw error;
  }
  return new CatalogConnection(parsed.driver, pool);
}
