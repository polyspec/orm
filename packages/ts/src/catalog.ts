import { isUtf8 } from 'node:buffer';
// The catalog connection (SCH-6a): native table metadata, bounded table pages, validated read-only queries, typed grid reads
// and explicit row changes over a MySQL, PostgreSQL or SQLite database selected by its DSN. Values follow the Go catalog
// (packages/go/orm/catalog*.go, catalogValue and catalogBytesValue); grid cells follow the Rust reference (packages/rust/build/src/tool_db/grid.rs
// and src/catalog, docs/spec/interfaces.md "Rust native grid query specification").
import { createHash } from 'node:crypto';
import { quote } from './message.js';
import { lstatSync } from 'node:fs';
import * as codes from './codes.js';
import { driverError, openDriver, parseDsn, sqlitePath, sqliteStoredCells, sqliteStoredRead, type DriverColumn, type DriverName, type DriverPool, type DriverResult, type DriverSession, type DriverValue } from './driver.js';
import { mariadbDefault } from './dbspec/introspect_mysql.js';
import { openMarkdown } from './markdown.js';
import { OrmError } from './runtime_error.js';

/** Budgets of the catalog connection (docs/spec/interfaces.md). A result over its budget is refused, never truncated. */
const METADATA_ROWS = 2048;
const METADATA_BYTES = 4 << 20;
const PAGE_BYTES = 8 << 20;
const SNAPSHOT_BYTES = 8 << 20;
const DEFAULT_QUERY_ROWS = 100000;
const DEFAULT_QUERY_BYTES = 64 << 20;

/** The error codes of the catalog connection, registered in docs/spec/errors.yaml. */
const CODE_READ_ONLY = 'QUERY_READ_ONLY';
const CODE_QUERY_LIMIT = 'QUERY_LIMIT_INVALID';
const CODE_LIMIT = 'CATALOG_LIMIT';
const CODE_VALUE = 'CATALOG_VALUE';
const CODE_PARAM = 'CATALOG_PARAM';
const CODE_METADATA = 'TABLE_METADATA_INVALID';
const CODE_TABLE_REF = 'TABLE_REFERENCE_INVALID';
const CODE_TABLE_NOT_FOUND = 'TABLE_NOT_FOUND';
const CODE_KIND = 'TABLE_KIND_UNSUPPORTED';
const CODE_NAMESPACE = 'TABLE_NAMESPACE_UNSUPPORTED';
const CODE_NAMESPACE_UNAVAILABLE = 'TABLE_NAMESPACE_UNAVAILABLE';
const CODE_PAGE_INVALID = 'TABLE_PAGE_INVALID';
const CODE_PAGE_UNSUPPORTED = 'TABLE_PAGE_UNSUPPORTED';
const CODE_PAGE_CHANGED = 'TABLE_PAGE_METADATA_CHANGED';
const CODE_SNAPSHOT = 'ROW_SNAPSHOT_INVALID';
const CODE_SNAPSHOT_LIMIT = 'ROW_SNAPSHOT_LIMIT';
const CODE_INSERT_INVALID = 'ROW_INSERT_INVALID';
const CODE_IDENTITY_REQUIRED = 'ROW_INSERT_IDENTITY_REQUIRED';
const CODE_ENCODE = 'CODEC_ENCODE';
// The driver code of a write that the server refuses in a read-only scope (codes.ts READ_ONLY).
const DRIVER_READ_ONLY = 'READ_ONLY';

/** A write that the database's read-only scope refuses, such as a routine that writes, fails with QUERY_READ_ONLY (INT-104). */
function refusedWrite(error: unknown): never {
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DRIVER_READ_ONLY) {
    throw err(CODE_READ_ONLY, error instanceof Error ? error.message : DRIVER_READ_ONLY);
  }
  throw error;
}
const CODE_UPDATE_INVALID = 'ROW_UPDATE_INVALID';
const CODE_UPDATE_LIMIT = 'ROW_UPDATE_LIMIT';
const CODE_CONFLICT = 'ROW_CONFLICT';
const CODE_AMBIGUOUS = 'ROW_IDENTITY_AMBIGUOUS';
const CODE_SCHEMA = 'ROW_SCHEMA_CHANGED';
const CODE_WRITE = 'ROW_WRITE_MISMATCH';
const CODE_UNSUPPORTED = 'ROW_MUTATION_UNSUPPORTED';
const CODE_COMMIT_REJECTED = 'ROW_COMMIT_REJECTED';
const CODE_COMMIT_UNKNOWN = 'ROW_COMMIT_INDETERMINATE';
const CODE_ROLLBACK = 'ROW_ROLLBACK_FAILED';
const CODE_TEMPORAL_VALUE = 'GRID_TEMPORAL_VALUE';
const CODE_TEMPORAL_PRECISION = 'GRID_TEMPORAL_PRECISION';

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
  /** SQLite only: the fraction digits that the dbspec CHECK of a TIME or DATETIME column fixes; null when no CHECK fixes them. */
  checkPrecision: number | null;
}

/** A table: its kind, its columns in physical order, its primary key in constraint order and whether that key is a reliable identity. */
export interface CatalogTableMetadata {
  table: CatalogTableRef;
  kind: CatalogTableKind;
  columns: CatalogColumn[];
  primaryKey: string[];
  reliableRowIdentity: boolean;
}

/**
 * A floating-point value of a read (INT-183): its number, and whether it is a 4-byte float (MySQL FLOAT, PostgreSQL real), whose number
 * holds a single-precision value. A float is never a plain number, so a REAL that SQLite stores as 2.0 stays a float and is not read as
 * the integer 2 (INT-152).
 */
export class CatalogFloat {
  public constructor(
    public readonly value: number,
    public readonly single: boolean,
  ) {}
}

/**
 * One value of a plain read. An integer inside the JavaScript safe range is a number; a larger one is a bigint, so no integer
 * is rounded. A float is a CatalogFloat, NaN and the infinities included. Binary values are Uint8Array copies, decimals are their plain
 * text, and temporal values are their dbspec text.
 */
export type CatalogValue = null | boolean | number | bigint | string | Uint8Array | CatalogFloat;

/**
 * One cell of a grid read, typed by the native type of its column (the Rust GridCell). Integer is a signed value and unsigned a MySQL
 * unsigned value; a float keeps its IEEE-754 bits, so signed zero and the nonfinite values survive; a decimal is its plain text.
 */
export type CatalogGridCell =
  | { kind: 'null' }
  | { kind: 'integer'; value: bigint }
  | { kind: 'unsigned'; value: bigint }
  | { kind: 'float32'; bits: number }
  | { kind: 'float64'; bits: bigint }
  | { kind: 'decimal'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'binary'; value: Uint8Array }
  | { kind: 'date'; value: string }
  | { kind: 'time'; value: string }
  | { kind: 'datetime'; value: string };

export interface CatalogQueryLimits {
  maxRows?: number;
  maxBytes?: number;
}

/** A plain read: the column names in order and the rows. */
export interface CatalogQueryResult {
  columns: string[];
  rows: CatalogValue[][];
}

/** A grid read: each column with its native type name, and the rows of typed cells. */
export interface CatalogGridResult {
  columns: Array<{ name: string; nativeType: string }>;
  rows: CatalogGridCell[][];
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
      throw err(CODE_SNAPSHOT, 'the snapshot was not captured by rowSnapshotFromPage');
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
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;

function err(code: string, message: string, cause?: unknown): OrmError {
  return new OrmError(code, message, cause);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The catalog value rules (docs/spec/interfaces.md "Catalog value rules", INT-165 to INT-185): each rule has one code and one text.
 * The text names no value, no column label and no type that a driver reports; the read that converts a value names its column by its
 * 1-based position (atColumn).
 */
const RULES = {
  timestamp: [CODE_VALUE, 'MySQL TIMESTAMP follows a time zone'],
  zoned: [CODE_VALUE, 'PostgreSQL timestamptz and timetz are unsupported'],
  numeric: [CODE_VALUE, 'PostgreSQL numeric is not finite'],
  native: [CODE_VALUE, 'unsupported native type'],
  driverValue: [CODE_VALUE, 'unsupported driver value'],
  decode: [CODE_VALUE, 'the driver could not decode the value'],
  dateRange: [CODE_TEMPORAL_VALUE, 'date outside 0001-01-01 to 9999-12-31'],
  calendar: [CODE_TEMPORAL_VALUE, 'date is not a calendar date'],
  timeRange: [CODE_TEMPORAL_VALUE, 'time outside 00:00:00 to 23:59:59.999999'],
  storedDate: [CODE_TEMPORAL_VALUE, 'the stored value is not a dbspec date'],
  storedTime: [CODE_TEMPORAL_VALUE, 'the stored value is not a dbspec time'],
  storedDatetime: [CODE_TEMPORAL_VALUE, 'the stored value is not a dbspec datetime'],
  checkDigits: [CODE_TEMPORAL_PRECISION, 'the fraction digits are not the count that its dbspec CHECK fixes'],
  precision: [CODE_TEMPORAL_PRECISION, 'temporal value has more fraction digits than its precision'],
  nativePrecision: [CODE_TEMPORAL_PRECISION, 'native type declares more than 6 fraction digits'],
  boolean: [CODE_VALUE, 'a boolean column holds a value that is not a boolean'],
} as const;

type ValueRule = keyof typeof RULES;

/** The refusal of a catalog value rule, thrown by a conversion before the read names its column (atColumn). */
class ValueRefusal extends Error {
  public constructor(public readonly rule: ValueRule, public override readonly cause?: unknown) {
    super(RULES[rule][1]);
  }
}

function refuse(rule: ValueRule, cause?: unknown): ValueRefusal {
  return new ValueRefusal(rule, cause);
}

/**
 * The error of a conversion of the value in the column at index (0-based): a refusal becomes `<CODE>: column <n>: <text>` with the
 * 1-based n, keeping the failure that caused it (INT-165); a decode failure is `<CODE>: <text>` with no column and keeps its failure as
 * its cause (INT-172); any other error is unchanged.
 */
function atColumn(index: number, error: unknown): unknown {
  if (!(error instanceof ValueRefusal)) return error;
  const [code, text] = RULES[error.rule];
  if (error.rule === 'decode') return err(code, text, error.cause);
  return err(code, `column ${index + 1}: ${text}`, error.cause);
}

/**
 * The cell kind of a native type of a MySQL or PostgreSQL result column, as its driver names it (driver.ts mysqlColumn and pgColumn):
 * the kinds of INT-185, `year` for a MySQL YEAR (INT-166), the refused types of INT-167 and INT-168, `none` for a type with no cell (INT-170), and `resolve` for a
 * PostgreSQL type that only the server's catalog describes (an array, a range, a multirange, an enum, a composite, a pseudo-type).
 */
type CellClass = 'integer' | 'unsigned' | 'float32' | 'float64' | 'decimal' | 'text' | 'boolean' | 'binary' | 'date' | 'time' | 'datetime' | 'year' | 'timestamp' | 'zoned' | 'none' | 'resolve';

const MYSQL_CLASSES: Record<string, CellClass> = {
  TINYINT: 'integer', SMALLINT: 'integer', MEDIUMINT: 'integer', INT: 'integer', BIGINT: 'integer',
  FLOAT: 'float32', DOUBLE: 'float64', DECIMAL: 'decimal',
  DATE: 'date', TIME: 'time', DATETIME: 'datetime', TIMESTAMP: 'timestamp', YEAR: 'year',
  // The server writes a JSON value in its normalized utf8mb4 form, and an ENUM or a SET as the text of its members (INT-185).
  CHAR: 'text', VARCHAR: 'text', TEXT: 'text', ENUM: 'text', SET: 'text', JSON: 'text',
  // A bit value is a binary string, and a geometry 4 bytes of its SRID followed by its WKB (INT-185).
  BLOB: 'binary', BINARY: 'binary', VARBINARY: 'binary', BIT: 'binary', GEOMETRY: 'binary',
};

/**
 * The cell kinds of the PostgreSQL base types of pg_catalog by their names (INT-185): a type whose output no session setting changes
 * is a text cell; interval (IntervalStyle), money (lc_monetary), the geometric types (extra_float_digits) and the OID alias types that
 * a schema qualifies (search_path) have none.
 */
const POSTGRES_CLASSES: Record<string, CellClass> = {
  INT2: 'integer', INT4: 'integer', INT8: 'integer', FLOAT4: 'float32', FLOAT8: 'float64', NUMERIC: 'decimal', BOOL: 'boolean', BYTEA: 'binary',
  DATE: 'date', TIME: 'time', TIMESTAMP: 'datetime', TIMESTAMPTZ: 'zoned', TIMETZ: 'zoned',
  CHAR: 'text', NAME: 'text', TEXT: 'text', BPCHAR: 'text', VARCHAR: 'text', OID: 'text', UUID: 'text', JSON: 'text', JSONB: 'text', XML: 'text',
  BIT: 'text', VARBIT: 'text', INET: 'text', CIDR: 'text', MACADDR: 'text', MACADDR8: 'text', TSVECTOR: 'text', TSQUERY: 'text', PG_LSN: 'text',
  INTERVAL: 'none', MONEY: 'none', POINT: 'none', LINE: 'none', LSEG: 'none', BOX: 'none', PATH: 'none', POLYGON: 'none', CIRCLE: 'none',
  REGCLASS: 'none', REGTYPE: 'none', REGPROC: 'none', REGPROCEDURE: 'none', REGOPER: 'none', REGOPERATOR: 'none', REGCONFIG: 'none',
  REGDICTIONARY: 'none', REGCOLLATION: 'none',
};

/** The cell kind of the native type of a MySQL or PostgreSQL result column. */
function cellClass(dialect: DriverName, type: string): CellClass {
  if (dialect === 'mysql') {
    const unsigned = type.endsWith(' UNSIGNED');
    const found = MYSQL_CLASSES[unsigned ? type.slice(0, -' UNSIGNED'.length) : type];
    if (found === 'integer' && unsigned) return 'unsigned';
    return found ?? 'none';
  }
  if (type.startsWith('OID:')) return 'resolve';
  return POSTGRES_CLASSES[type] ?? 'none';
}

/** The PostgreSQL type OID of a result column whose type only the server's catalog describes, or undefined. */
function unresolvedOid(dialect: DriverName, column: DriverColumn): number | undefined {
  if (dialect !== 'postgres' || !column.type.startsWith('OID:')) return undefined;
  return Number(column.type.slice('OID:'.length));
}

/** The result column that stands for a resolved PostgreSQL type: a text cell, or a type with no cell. */
function resolvedColumn(column: DriverColumn, text: boolean): DriverColumn {
  return { name: column.name, type: text ? 'TEXT' : 'UNSUPPORTED' };
}

/**
 * Reads the server's catalog for the PostgreSQL types of oids and the types that they are made of: the element of an array, the base of
 * a domain, the subtype of a range, the range of a multirange and the fields of a composite. Each row is oid, schema, name, typtype,
 * typcategory, element, base, range subtype, multirange range and the field types of a composite as a comma-separated text.
 */
const POSTGRES_TYPES_SQL = `WITH RECURSIVE t(oid) AS (
  SELECT unnest($1::oid[])
  UNION
  SELECT n.next FROM t JOIN pg_type p ON p.oid = t.oid CROSS JOIN LATERAL (
    SELECT p.typelem WHERE p.typcategory = 'A' AND p.typelem <> 0
    UNION ALL SELECT p.typbasetype WHERE p.typtype = 'd'
    UNION ALL SELECT r.rngsubtype FROM pg_range r WHERE r.rngtypid = p.oid
    UNION ALL SELECT r.rngtypid FROM pg_range r WHERE r.rngmultitypid = p.oid
    UNION ALL SELECT a.atttypid FROM pg_attribute a WHERE p.typtype = 'c' AND a.attrelid = p.typrelid AND a.attnum > 0 AND NOT a.attisdropped
  ) n(next)
)
SELECT p.oid::text, ns.nspname::text, p.typname::text, p.typtype::text, p.typcategory::text, p.typelem::text, p.typbasetype::text,
  (SELECT r.rngsubtype::text FROM pg_range r WHERE r.rngtypid = p.oid),
  (SELECT r.rngtypid::text FROM pg_range r WHERE r.rngmultitypid = p.oid),
  (SELECT string_agg(a.atttypid::text, ',' ORDER BY a.attnum) FROM pg_attribute a WHERE p.typtype = 'c' AND a.attrelid = p.typrelid AND a.attnum > 0 AND NOT a.attisdropped)
FROM t JOIN pg_type p ON p.oid = t.oid JOIN pg_namespace ns ON ns.oid = p.typnamespace`;

/** Whether a built-in PostgreSQL type has a text cell, by its oid, as postgresText found it; a built-in type does not change. */
const POSTGRES_BUILTIN_TEXT = new Map<number, boolean>();

/** Whether a built-in PostgreSQL type holds a multirange, by its oid, as holdsMultirange found it; a built-in type does not change. */
const POSTGRES_BUILTIN_MULTIRANGE = new Map<number, boolean>();

/** One row of POSTGRES_TYPES_SQL. */
interface PostgresType {
  schema: string;
  name: string;
  typtype: string;
  category: string;
  element: number;
  base: number;
  subtype: number | undefined;
  range: number | undefined;
  fields: number[] | undefined;
}

/** The element kinds whose text no session setting changes, so that an array, a range or a composite of them is a text cell (INT-185). */
const SETTING_FREE: ReadonlySet<CellClass> = new Set(['integer', 'decimal', 'boolean', 'text']);

/**
 * Whether the PostgreSQL type oid has a text cell by INT-185: an enum does; a domain takes its base type; an array, a range, a multirange
 * or a composite does when the text of each element or field is setting-free; a base type of pg_catalog takes its POSTGRES_CLASSES kind;
 * any other type, a pseudo-type and a base type of an extension included, has none.
 */
function postgresText(oid: number, types: ReadonlyMap<number, PostgresType>, seen: ReadonlySet<number> = new Set()): boolean {
  const type = types.get(oid);
  if (type === undefined || seen.has(oid)) return false;
  const inner = new Set([...seen, oid]);
  const component = (part: number | undefined): boolean => part !== undefined && part !== 0 && settingFree(part, types, inner);
  if (type.typtype === 'e') return true;
  if (type.typtype === 'd') return postgresText(type.base, types, inner);
  if (type.typtype === 'r') return component(type.subtype);
  if (type.typtype === 'm') return component(type.range);
  if (type.typtype === 'c') return type.fields !== undefined && type.fields.every(field => component(field));
  if (type.typtype === 'b' && type.category === 'A' && type.element !== 0) return component(type.element);
  if (type.typtype === 'b' && type.schema === 'pg_catalog') return POSTGRES_CLASSES[type.name.toUpperCase()] === 'text';
  return false;
}

/**
 * Whether the PostgreSQL type oid is a multirange or an array, a range, a domain or a composite that holds one: a column of such a type
 * is refused by its type, whether its value is NULL or not (INT-185), so that every runtime refuses the statement at its first such
 * column.
 */
function holdsMultirange(oid: number, types: ReadonlyMap<number, PostgresType>, seen: ReadonlySet<number> = new Set()): boolean {
  const type = types.get(oid);
  if (type === undefined || seen.has(oid)) return false;
  const inner = new Set([...seen, oid]);
  const part = (next: number | undefined): boolean => next !== undefined && next !== 0 && holdsMultirange(next, types, inner);
  if (type.typtype === 'm') return true;
  if (type.typtype === 'd') return part(type.base);
  if (type.typtype === 'r') return part(type.subtype);
  if (type.typtype === 'c') return (type.fields ?? []).some(field => part(field));
  if (type.typtype === 'b' && type.category === 'A') return part(type.element);
  return false;
}

/** Whether the text of the PostgreSQL type oid, as an element or a field, follows no session setting. */
function settingFree(oid: number, types: ReadonlyMap<number, PostgresType>, seen: ReadonlySet<number>): boolean {
  const type = types.get(oid);
  if (type === undefined) return false;
  if (type.typtype === 'b' && type.schema === 'pg_catalog' && type.category !== 'A') {
    const found = POSTGRES_CLASSES[type.name.toUpperCase()];
    return found !== undefined && SETTING_FREE.has(found);
  }
  if (type.typtype === 'd') return settingFree(type.base, types, seen);
  return postgresText(oid, types, seen);
}

/** The rows of POSTGRES_TYPES_SQL by oid. */
function postgresTypes(rows: readonly unknown[][]): Map<number, PostgresType> {
  const number = (value: unknown): number | undefined => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined);
  const text = (value: unknown, what: string): string => {
    if (typeof value !== 'string') throw err(CODE_METADATA, `expected text for the ${what} of a PostgreSQL type`);
    return value;
  };
  const types = new Map<number, PostgresType>();
  for (const row of rows) {
    const oid = number(row[0]);
    if (oid === undefined) throw err(CODE_METADATA, 'expected the oid of a PostgreSQL type');
    types.set(oid, {
      schema: text(row[1], 'schema'),
      name: text(row[2], 'name'),
      typtype: text(row[3], 'typtype'),
      category: text(row[4], 'category'),
      element: number(row[5]) ?? 0,
      base: number(row[6]) ?? 0,
      subtype: number(row[7]),
      range: number(row[8]),
      fields: typeof row[9] === 'string' ? row[9].split(',').map(field => number(field) ?? 0) : undefined,
    });
  }
  return types;
}

/** A value of an integer column as a bigint: a number, a bigint or the decimal digits that a driver sends (INT-171 otherwise). */
function hostInteger(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw refuse('driverValue');
}

/** An integer for a plain read: a number inside the safe range, otherwise the exact bigint. */
function integerValue(value: bigint): number | bigint {
  return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value;
}

/** A signed 64-bit integer of a signed column, or an unsigned 64-bit one of an unsigned column; INT-171 otherwise. */
function checkedInteger(value: unknown, unsigned: boolean): bigint {
  const number = hostInteger(value);
  if (unsigned ? number < 0n || number > U64_MAX : number < I64_MIN || number > I64_MAX) throw refuse('driverValue');
  return number;
}

/** The float of a double column: a number, or the text of a PostgreSQL float8, NaN and the infinities included (INT-171 otherwise). */
function hostFloat64(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^(-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|NaN|-?Infinity)$/.test(value)) return Number(value);
  throw refuse('driverValue');
}

/** The single-precision bits of a 4-byte float, which arrives as its exact text (driver.ts, exact); INT-171 otherwise. */
function hostFloat32(value: unknown): number {
  if (typeof value !== 'string') throw refuse('driverValue');
  return float32BitsOfText(value);
}

/** The text of a decimal column; a PostgreSQL NaN or infinity is INT-169 where it has no cell, and any other text INT-171. */
function hostDecimal(value: unknown, finite: boolean): string {
  if (typeof value !== 'string') throw refuse('driverValue');
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  if (value === 'NaN' || value === 'Infinity' || value === '-Infinity') {
    if (finite) throw refuse('numeric');
    return value;
  }
  throw refuse('driverValue');
}

/** A boolean: a boolean, or the `t` and `f` of a PostgreSQL bool (INT-171 otherwise). */
function hostBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 't' || value === 'f') return value === 't';
  throw refuse('driverValue');
}

/**
 * The bytes of the text that PostgreSQL sends for a bytea in the form of bytea_output: hex (`\x` and two hex digits a byte) or escape
 * (a printable ASCII character, `\\` or `\` and three octal digits a byte). A text in neither form fails, so that no byte is lost.
 */
function byteaBytes(text: string): Uint8Array {
  if (text.startsWith('\\x')) {
    const hex = text.slice(2);
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new TypeError('the hex form of the bytea text is not pairs of hex digits');
    return new Uint8Array(Buffer.from(hex, 'hex'));
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) {
      if (text.charAt(i + 1) === '\\') {
        bytes.push(0x5c);
        i += 1;
        continue;
      }
      const octal = text.slice(i + 1, i + 4);
      if (!/^[0-3][0-7]{2}$/.test(octal)) throw new TypeError('the bytea text has a backslash that starts no escape');
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else if (code >= 0x20 && code < 0x7f) {
      bytes.push(code);
    } else {
      throw new TypeError('the bytea text has a character that its escape form writes as an octal escape');
    }
  }
  return Uint8Array.from(bytes);
}

/** The bytes of a binary column: driver bytes, or the text of a PostgreSQL bytea (INT-172 with the failure when it does not decode). */
function hostBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== 'string') throw refuse('driverValue');
  try {
    return byteaBytes(value);
  } catch (error) {
    throw refuse('decode', error);
  }
}

/** A text: a string, or driver bytes, which are the text when they are valid UTF-8 and stay bytes when not (INT-153). */
function hostText(value: unknown): string | Uint8Array {
  if (typeof value === 'string') return value;
  if (!(value instanceof Uint8Array)) throw refuse('driverValue');
  if (!isUtf8(value)) return new Uint8Array(value);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch (error) {
    throw refuse('decode', error);
  }
}

/** The temporal text that a driver sends for a column of a temporal kind (INT-171 when it is not a string). */
function hostTemporal(value: unknown): string {
  if (typeof value !== 'string') throw refuse('driverValue');
  return value;
}

/** The float bits of a number as an IEEE-754 double. */
function float64Bits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}

/** The number of bits of a non-negative integer. */
function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/** Whether num/den is at least 2^e. */
function atLeastPowerOfTwo(num: bigint, den: bigint, e: number): boolean {
  return e >= 0 ? num >= den << BigInt(e) : num << BigInt(-e) >= den;
}

/** num * 2^s / den rounded to the nearest integer, ties to even. */
function roundScaled(num: bigint, den: bigint, s: number): bigint {
  const scaledNum = s >= 0 ? num << BigInt(s) : num;
  const scaledDen = s >= 0 ? den : den << BigInt(-s);
  let q = scaledNum / scaledDen;
  const twice = (scaledNum % scaledDen) * 2n;
  if (twice > scaledDen || (twice === scaledDen && q % 2n === 1n)) q += 1n;
  return q;
}

/**
 * The IEEE-754 single bits of a decimal text as PostgreSQL and MySQL print a float4 or FLOAT. The value is rounded once, to nearest
 * with ties to even, by exact integer arithmetic; a rounding through a double would round twice and could differ.
 */
function float32BitsOfText(text: string): number {
  const specials: Record<string, bigint> = { NaN: 0x7fc00000n, Infinity: 0x7f800000n, '-Infinity': 0xff800000n };
  const special = specials[text];
  if (special !== undefined) return Number(special);
  const match = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (match === null) throw refuse('driverValue');
  const sign = match[1] === '-' ? 1n << 31n : 0n;
  const fraction = match[3] ?? '';
  const exponent10 = Number(match[4] ?? '0') - fraction.length;
  const mantissa = BigInt(match[2] + fraction);
  if (mantissa === 0n) return Number(sign);
  let num = mantissa;
  let den = 1n;
  if (exponent10 >= 0) num *= 10n ** BigInt(exponent10);
  else den = 10n ** BigInt(-exponent10);
  // 2^e2 <= num/den < 2^(e2+1)
  let e2 = bitLength(num) - bitLength(den);
  while (!atLeastPowerOfTwo(num, den, e2)) e2 -= 1;
  while (atLeastPowerOfTwo(num, den, e2 + 1)) e2 += 1;
  if (e2 >= -126) {
    // A normal value: q = x * 2^(23 - e2) lies in [2^23, 2^24) before rounding.
    let q = roundScaled(num, den, 23 - e2);
    if (q === 1n << 24n) {
      q = 1n << 23n;
      e2 += 1;
    }
    if (e2 > 127) return Number(sign | 0x7f800000n);
    return Number(sign | (BigInt(e2 + 127) << 23n) | (q - (1n << 23n)));
  }
  // A subnormal value: q counts units of 2^-149 and may round up to the smallest normal.
  const q = roundScaled(num, den, 149);
  if (q === 1n << 23n) return Number(sign | (1n << 23n));
  return Number(sign | q);
}

/** The float value of single-precision bits. */
function float32FromBits(bits: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits);
  return view.getFloat32(0);
}

/** The calendar check of a date: a year from 1 to 9999 (INT-173), then a month and a day of the calendar (INT-174). */
function checkDate(year: number, month: number, day: number): void {
  if (year < 1 || year > 9999) throw refuse('dateRange');
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw refuse('calendar');
}

/** The time check of a time of day: 00:00:00 to 23:59:59.999999 (INT-175). */
function checkTime(hours: number, minutes: number, seconds: number): void {
  if (hours > 23 || minutes > 59 || seconds > 59) throw refuse('timeRange');
}

const DRIVER_DATE = /^(\d{4,})-(\d{2})-(\d{2})$/;
const DRIVER_TIME = /^(-)?(\d{2,3}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const DRIVER_DATETIME = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * A date that MySQL or PostgreSQL sends, as the dbspec text `YYYY-MM-DD`: a PostgreSQL infinity, BC date or year past 9999 and the MySQL
 * zero date are outside the range (INT-173), and any other text is no driver date (INT-171).
 */
function driverDate(text: string): string {
  if (text === 'infinity' || text === '-infinity' || text.endsWith(' BC')) throw refuse('dateRange');
  const match = DRIVER_DATE.exec(text);
  if (match === null) throw refuse('driverValue');
  checkDate(Number(match[1]), Number(match[2]), Number(match[3]));
  return text;
}

/**
 * A time that MySQL or PostgreSQL sends, as the dbspec text `HH:MM:SS.ffffff` with six fraction digits: a MySQL time past a day or
 * negative and a PostgreSQL 24:00:00 are outside the day (INT-175), and a digit past six fraction digits is no driver time (INT-171).
 */
function driverTime(text: string): string {
  const match = DRIVER_TIME.exec(text);
  if (match === null) throw refuse('driverValue');
  const [, negative, hours = '', minutes = '', seconds = '', fraction = ''] = match;
  if (negative !== undefined || hours.length > 2) throw refuse('timeRange');
  checkTime(Number(hours), Number(minutes), Number(seconds));
  if (fraction.length > 6) throw refuse('driverValue');
  return `${hours}:${minutes}:${seconds}.${fraction.padEnd(6, '0')}`;
}

/** A datetime that MySQL or PostgreSQL sends, as the dbspec text `YYYY-MM-DD HH:MM:SS.ffffff` in UTC. */
function driverDatetime(text: string): string {
  if (text === 'infinity' || text === '-infinity' || text.endsWith(' BC')) throw refuse('dateRange');
  const match = DRIVER_DATETIME.exec(text);
  if (match === null) throw refuse('driverValue');
  return `${driverDate(match[1] ?? '')} ${driverTime(match[2] ?? '')}`;
}

/** The dbspec text of a MySQL or PostgreSQL temporal value of a kind, with six fraction digits. */
function driverTemporal(value: unknown, kind: 'date' | 'time' | 'datetime'): string {
  const text = hostTemporal(value);
  if (kind === 'date') return driverDate(text);
  return kind === 'time' ? driverTime(text) : driverDatetime(text);
}

/**
 * The fraction digits of a described temporal column: the digits of its native type (MySQL time(3), PostgreSQL timestamp(3) without
 * time zone), or 0 for MySQL and 6 for PostgreSQL when the type names none. A precision above 6 or that is not a number is INT-181.
 */
function declaredPrecision(dialect: DriverName, type: string): number {
  const match = /\(([^)]*)\)/.exec(type);
  if (match === null) return dialect === 'postgres' ? 6 : 0;
  const digits = match[1] ?? '';
  if (!/^\d+$/.test(digits) || Number(digits) > 6) throw refuse('nativePrecision');
  return Number(digits);
}

/**
 * A temporal value of a described column in its declared precision p (INT-103): exactly p fraction digits, and INT-180 for a non-zero
 * digit beyond p.
 */
function describedTemporal(value: unknown, kind: 'date' | 'time' | 'datetime', type: string, dialect: DriverName): string {
  const text = driverTemporal(value, kind);
  if (kind === 'date') return text;
  const precision = declaredPrecision(dialect, type);
  const dot = text.lastIndexOf('.');
  const head = text.slice(0, dot);
  const digits = text.slice(dot + 1);
  if (!/^0*$/.test(digits.slice(precision))) throw refuse('precision');
  return precision === 0 ? head : `${head}.${digits.slice(0, precision)}`;
}

/** A value of a SQLite result by its storage class (INT-152, INT-184): an integer, a REAL, a text or a blob. */
function sqliteValue(value: unknown): CatalogValue {
  if (value === null) return null;
  if (typeof value === 'bigint') return integerValue(value);
  if (typeof value === 'number') return new CatalogFloat(value, false);
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw refuse('driverValue');
}

/** A grid cell of a SQLite result: the storage class of its value, a REAL a Float64 cell (INT-152, INT-183). */
function sqliteGridCell(value: unknown): CatalogGridCell {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'bigint') {
    if (value < I64_MIN || value > I64_MAX) throw refuse('driverValue');
    return { kind: 'integer', value };
  }
  if (typeof value === 'number') return { kind: 'float64', bits: float64Bits(value) };
  if (typeof value === 'string') return { kind: 'text', value };
  if (value instanceof Uint8Array) return { kind: 'binary', value: new Uint8Array(value) };
  throw refuse('driverValue');
}

/** A grid cell of a result column by the cell kind of its native type (INT-165 to INT-185). */
function gridCell(value: unknown, column: DriverColumn, dialect: DriverName): CatalogGridCell {
  if (value === null) return { kind: 'null' };
  if (dialect === 'sqlite') return sqliteGridCell(value);
  const kind = cellClass(dialect, column.type);
  switch (kind) {
    case 'integer':
    case 'unsigned':
      return { kind, value: checkedInteger(value, kind === 'unsigned') };
    case 'float32':
      return { kind: 'float32', bits: hostFloat32(value) };
    case 'float64':
      return { kind: 'float64', bits: float64Bits(hostFloat64(value)) };
    case 'decimal':
      return { kind: 'decimal', value: hostDecimal(value, true) };
    case 'boolean':
      return { kind: 'boolean', value: hostBoolean(value) };
    case 'binary':
      return { kind: 'binary', value: hostBytes(value) };
    case 'text': {
      const text = hostText(value);
      return typeof text === 'string' ? { kind: 'text', value: text } : { kind: 'binary', value: text };
    }
    case 'year':
      // The server flags a YEAR UNSIGNED, which does not make it an unsigned cell (INT-166).
      return { kind: 'integer', value: checkedInteger(value, false) };
    case 'date':
    case 'time':
    case 'datetime':
      return { kind, value: driverTemporal(value, kind) };
    case 'timestamp':
    case 'zoned':
      throw refuse(kind);
    case 'none':
    case 'resolve':
      throw refuse('native');
  }
}

/**
 * A value of a plain read by the cell kind of its native type: an integer, a float of the runtime, a non-finite one included (INT-183),
 * a decimal as its text, a temporal value as the text of its grid cell (INT-153), and bytes for a binary value and for a text that is not
 * valid UTF-8. A type with no cell is INT-170; MySQL YEAR is its integer, and a MySQL TIMESTAMP and a PostgreSQL timestamptz or timetz
 * are the text that the server sends in the session's UTC.
 */
function plainValue(value: unknown, column: DriverColumn, dialect: DriverName): CatalogValue {
  if (value === null) return null;
  if (dialect === 'sqlite') return sqliteValue(value);
  const kind = cellClass(dialect, column.type);
  switch (kind) {
    case 'integer':
    case 'unsigned':
    case 'year':
      return integerValue(checkedInteger(value, kind === 'unsigned'));
    case 'float32':
      return new CatalogFloat(float32FromBits(hostFloat32(value)), true);
    case 'float64':
      return new CatalogFloat(hostFloat64(value), false);
    case 'decimal':
      return hostDecimal(value, false);
    case 'boolean':
      return hostBoolean(value);
    case 'binary':
      return hostBytes(value);
    case 'text':
      return hostText(value);
    case 'date':
    case 'time':
    case 'datetime':
      return driverTemporal(value, kind);
    case 'timestamp':
    case 'zoned':
      return hostTemporal(value);
    case 'none':
    case 'resolve':
      throw refuse('native');
  }
}

/**
 * A value of a described table (INT-165): the refused types of INT-167 to INT-170, a non-finite PostgreSQL numeric (INT-169), a boolean
 * column (INT-182), the declared precision of a MySQL or PostgreSQL temporal column (INT-103) and the dbspec text of a SQLite one.
 */
function describedValue(value: unknown, column: DriverColumn, described: CatalogColumn | undefined, dialect: DriverName): CatalogValue {
  if (described === undefined) return plainValue(value, column, dialect);
  if (dialect === 'sqlite') {
    const stored = sqliteValue(value);
    const boolean = describedBoolean(stored, described, dialect);
    if (boolean !== undefined) return boolean;
    return sqliteTemporal(stored, described);
  }
  if (value === null) return null;
  const kind = cellClass(dialect, column.type);
  switch (kind) {
    case 'timestamp':
    case 'zoned':
      throw refuse(kind);
    case 'none':
    case 'resolve':
      throw refuse('native');
    case 'decimal':
      return hostDecimal(value, true);
    case 'date':
    case 'time':
    case 'datetime':
      return describedTemporal(value, kind, described.nativeType, dialect);
    default: {
      const plain = plainValue(value, column, dialect);
      return describedBoolean(plain, described, dialect) ?? plain;
    }
  }
}

/**
 * A boolean column read as a bool by its column type (DIA-29): a MySQL tinyint(1) and a SQLite BOOLEAN arrive as the integer 0 or 1, a
 * PostgreSQL boolean already as a bool. Any other value of such a column is INT-182; any other column returns undefined.
 */
function describedBoolean(plain: CatalogValue, described: CatalogColumn, dialect: DriverName): boolean | undefined | null {
  const native = described.nativeType.trim().toLowerCase();
  const isBoolean = dialect === 'mysql' ? native === 'tinyint(1)' : native === 'boolean';
  if (!isBoolean) return undefined;
  if (plain === null) return null;
  if (typeof plain === 'boolean') return plain;
  if (plain === 0 || plain === 1) return plain === 1;
  throw refuse('boolean');
}

/** A cell of a described table with its size in the read budget. */
function describedCell(value: unknown, column: DriverColumn, described: CatalogColumn | undefined, dialect: DriverName): { cell: CatalogValue; size: number } {
  const cell = describedValue(value, column, described, dialect);
  return { cell, size: sizeOf(cell) };
}

const STORED_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STORED_TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
const STORED_DATETIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

/**
 * A SQLite temporal column of a described table: the stored value must be a text of the dbspec form of its declared DATE, TIME or
 * DATETIME (INT-176 to INT-178), then within the range of a date and a time (INT-173 to INT-175), and its fraction must have the digits
 * that the table's dbspec CHECK fixes (INT-179). Any other declared type keeps its stored value unchecked (INT-184).
 */
function sqliteTemporal(stored: CatalogValue, described: CatalogColumn): CatalogValue {
  const declared = described.nativeType.toUpperCase();
  if (stored === null || (declared !== 'DATE' && declared !== 'TIME' && declared !== 'DATETIME')) return stored;
  const text = typeof stored === 'string' ? stored : '';
  if (declared === 'DATE') {
    const match = STORED_DATE.exec(text);
    if (match === null) throw refuse('storedDate');
    checkDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return text;
  }
  let fraction: string;
  if (declared === 'TIME') {
    const match = STORED_TIME.exec(text);
    if (match === null) throw refuse('storedTime');
    checkTime(Number(match[1]), Number(match[2]), Number(match[3]));
    fraction = match[4] ?? '';
  } else {
    const match = STORED_DATETIME.exec(text);
    if (match === null) throw refuse('storedDatetime');
    checkDate(Number(match[1]), Number(match[2]), Number(match[3]));
    checkTime(Number(match[4]), Number(match[5]), Number(match[6]));
    fraction = match[7] ?? '';
  }
  // INT-103 and DIA-24: a SQLite DATETIME or TIME with no CHECK has precision 0.
  if (fraction.length !== (described.checkPrecision ?? 0)) throw refuse('checkDigits');
  return text;
}

/**
 * The fraction digits that the dbspec CHECK of a SQLite column fixes (dbspec/render.ts): a GLOB of p `[0-9]` groups, or no fraction for
 * p = 0. Null when no CHECK of the table's definition names the column.
 */
function checkPrecisionOf(tableSql: string, column: string): number | null {
  const quoted = `"${column.split('"').join('""')}"`;
  for (const clause of checkClauses(tableSql)) {
    if (!clause.includes(quoted)) continue;
    const glob = /GLOB '((?:\[0-9\])*)'/.exec(clause);
    if (glob !== null) return (glob[1] ?? '').length / 5;
    if (/IS (time|datetime)\(/.test(clause)) return 0;
  }
  return null;
}

/** The text inside each CHECK ( ... ) of a table definition, balanced over its parentheses. */
function checkClauses(tableSql: string): string[] {
  const clauses: string[] = [];
  const opening = /CHECK\s*\(/gi;
  let found: RegExpExecArray | null;
  while ((found = opening.exec(tableSql)) !== null) {
    const start = found.index + found[0].length;
    let depth = 1;
    let i = start;
    while (i < tableSql.length && depth > 0) {
      const c = tableSql.charAt(i);
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    clauses.push(tableSql.slice(start, i - 1));
  }
  return clauses;
}

/** The byte size of a converted cell: UTF-8 bytes of text, the length of binary, and 8 for every number, boolean and NULL. */
function sizeOf(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value instanceof Uint8Array) return value.length;
  return 8;
}

/** The byte size of a grid cell: UTF-8 bytes of its text, the length of binary, and 8 for every number, boolean and NULL. */
function gridSize(cell: CatalogGridCell): number {
  switch (cell.kind) {
    case 'text':
    case 'decimal':
    case 'date':
    case 'time':
    case 'datetime':
      return Buffer.byteLength(cell.value, 'utf8');
    case 'binary':
      return cell.value.length;
    default:
      return 8;
  }
}

/** The canonical key of a cell: its type and its exact value. Two cells are equal exactly when their keys are equal. */
function cellKey(cell: unknown): string {
  if (cell === null) return 'n';
  if (typeof cell === 'boolean') return cell ? 'b1' : 'b0';
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) throw err(CODE_SNAPSHOT, 'non-finite number cell');
    return `d${Object.is(cell, -0) ? '-0' : String(cell)}`;
  }
  if (typeof cell === 'bigint') return `i${cell.toString()}`;
  // A float is its kind and its IEEE-754 bits, so signed zero and NaN are values (INT-107).
  if (cell instanceof CatalogFloat) return `f${cell.single ? 32 : 64}:${float64Bits(cell.value).toString()}`;
  if (typeof cell === 'string') return `s${Buffer.byteLength(cell, 'utf8')}:${cell}`;
  if (cell instanceof Uint8Array) return `x${Buffer.from(cell).toString('hex')}`;
  throw err(CODE_SNAPSHOT, 'unsupported cell type');
}

function sameCell(a: unknown, b: unknown): boolean {
  return cellKey(a) === cellKey(b);
}

/**
 * Whether a stored cell holds the value that a write gave: a float holds a number when its number is that number, and any other cell
 * when it is the same cell, an integer whatever its host form.
 */
function sameWritten(stored: unknown, written: unknown): boolean {
  // A bound integer is a bigint (checkParams), and a read returns a safe integer as a number.
  const value = typeof written === 'bigint' ? integerValue(written) : written;
  if (stored instanceof CatalogFloat && typeof value === 'number') return Object.is(stored.value, value);
  return sameCell(stored, value);
}

function sameRow(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((cell, index) => sameCell(cell, b[index]));
}

/** Two descriptors are equal when their canonical JSON is equal; the fields are always built in one order. */
function sameDescriptor(a: CatalogTableMetadata, b: CatalogTableMetadata): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkName(name: string): void {
  if (name === '' || Buffer.byteLength(name, 'utf8') > 1024 || name.includes('\0')) {
    throw err(CODE_TABLE_REF, 'expected 1..1024 UTF-8 bytes without NUL');
  }
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

/** Locates a MySQL insert by its explicit input only; generated expressions are never evaluated by the client. */
function mysqlInputLocatorSql(metadata: CatalogTableMetadata, changes: readonly { index: number; value: DriverValue }[], dialect: DriverName): string {
  const predicates = changes.map(change => {
    const column = metadata.columns[change.index];
    if (column === undefined) throw err(CODE_SCHEMA, 'insertion descriptor changed');
    const quoted = quoteIdent(column.name, dialect);
    return change.value === null ? `${quoted} IS NULL` : `${quoted}=?`;
  });
  return `SELECT ${quoteList(metadata.columns.map(column => column.name), dialect)} FROM ${qualified(metadata.table, dialect)} WHERE ${predicates.join(' AND ')} LIMIT 2 FOR UPDATE`;
}

function mysqlInputLocatorParams(changes: readonly { index: number; value: DriverValue }[]): DriverValue[] {
  return changes.filter(change => change.value !== null).map(change => change.value);
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
    // A safe integer number is an integer value, as a read returns one (CatalogValue), so it binds as an integer and SQLite stores no
    // REAL for it; any other finite number and a CatalogFloat bind as a double.
    if (typeof param === 'number' && Number.isSafeInteger(param)) return BigInt(param);
    if (typeof param === 'number' && Number.isFinite(param)) return param;
    if (param instanceof CatalogFloat && Number.isFinite(param.value)) return param.value;
    throw err(code, `parameter ${index + 1} has unsupported type ${typeof param} or is not finite`);
  });
}

/** The descriptor's key columns as column indexes in constraint order; it must have a reliable identity. */
function descriptorKeys(metadata: CatalogTableMetadata): number[] {
  const invalid = (reason: string): OrmError => err(CODE_SNAPSHOT, `invalid original row or descriptor: ${reason}`);
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
  if (cells.length !== metadata.columns.length) throw err(CODE_SNAPSHOT, `row has ${cells.length} cells for ${metadata.columns.length} columns`);
  cells.forEach((cell, index) => {
    const column = metadata.columns[index];
    if (cell === null && column !== undefined && !column.nullable) throw err(CODE_SNAPSHOT, `NULL in non-null column "${column.name}"`);
    cellKey(cell);
  });
}

function revisionOf(metadata: CatalogTableMetadata, cells: readonly unknown[]): string {
  let encoded = JSON.stringify({ tag: 'orm-catalog-row-v1', metadata });
  for (const cell of cells) {
    const key = cellKey(cell);
    encoded += `${Buffer.byteLength(key, 'utf8')}:${key}`;
  }
  if (Buffer.byteLength(encoded, 'utf8') > SNAPSHOT_BYTES) throw err(CODE_SNAPSHOT_LIMIT, 'original row encoding exceeds its budget');
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

/** Checks named assignments against a descriptor, in the order given. */
/** The fraction digits a time or datetime column of the dialect holds (INT-101): its declared precision, the dialect default, or the SQLite CHECK; null for every other column. */
function declaredTemporalPrecision(column: CatalogColumn, dialect: string): number | null {
  const base = column.nativeType.trim().toLowerCase();
  if (!/^(time|datetime|timestamp)\b/.test(base)) return null;
  const declared = /\((\d+)\)/.exec(base);
  if (declared !== null) return Number(declared[1]);
  if (dialect === 'sqlite') return column.checkPrecision;
  return dialect === 'postgres' ? 6 : 0;
}

function checkChanges(metadata: CatalogTableMetadata, values: readonly CatalogAssignment[], code: string, dialect: string): Array<{ index: number; value: DriverValue }> {
  // A key of defaults alone takes no assignment (INT-123).
  if ((values.length === 0 && code !== CODE_INSERT_INVALID) || values.length > metadata.columns.length) throw err(code, 'invalid column assignments');
  const params = checkParams(values.map(assignment => assignment.value), CODE_PARAM);
  const seen = new Set<string>();
  return values.map((assignment, position) => {
    const index = metadata.columns.findIndex(column => column.name === assignment.name);
    const column = metadata.columns[index];
    if (index < 0 || column === undefined) throw err(code, `unknown column "${assignment.name}"`);
    if (seen.has(column.name)) throw err(code, `duplicate column ${quote(column.name)}`);
    if (column.generated) throw err(code, `generated column "${column.name}" is not writable`);
    const value = params[position] ?? null;
    if (value === null && !column.nullable) throw err(code, `NULL in non-null column "${column.name}"`);
    if (exceedsDeclaredCapacity(column, value)) throw err(code, `value exceeds the declared capacity of column "${column.name}"`);
    if (typeof value === 'string') {
      // A write beyond the declared precision fails before any statement, with CODEC_ENCODE (errors.yaml).
      const precision = declaredTemporalPrecision(column, dialect);
      const digits = /\.(\d+)$/.exec(value)?.[1]?.length ?? 0;
      if (precision !== null && digits > precision) throw err(CODE_ENCODE, `${column.name} holds ${digits} fraction digits; its declared precision is ${precision}`);
    }
    seen.add(column.name);
    return { index, value };
  });
}

/** Whether an assigned text or byte value exceeds the length declared by its native column type. */
function exceedsDeclaredCapacity(column: CatalogColumn, value: DriverValue): boolean {
  if (typeof value === 'string') {
    const textCapacity = /^(?:varchar|character varying)\s*\((\d+)\)/i.exec(column.nativeType);
    if (textCapacity !== null) return Array.from(value).length > Number(textCapacity[1]);
    const byteCapacity = /^(?:varbinary|binary)\s*\((\d+)\)/i.exec(column.nativeType);
    return byteCapacity !== null && Buffer.byteLength(value, 'utf8') > Number(byteCapacity[1]);
  }
  if (value instanceof Uint8Array) {
    const match = /^(?:varbinary|binary)\s*\((\d+)\)/i.exec(column.nativeType);
    return match !== null && value.byteLength > Number(match[1]);
  }
  return false;
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
function queryWords(query: string, dialect: DriverName, semicolon?: (at: number) => void): string[] | undefined {
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
      if (c === ';') {
        words.push(';');
        semicolon?.(i);
      }
      i++;
    }
  }
  return words;
}

/** The query of a SQLite statement without what ends it, the text that sqliteStoredRead reads again. */
function sqliteQueryText(sql: string): string {
  let end = sql.length;
  queryWords(sql, 'sqlite', at => { end = at; });
  return sql.slice(0, end);
}

function validateReadOnly(query: string, dialect: DriverName): void {
  const refused = (): OrmError => err(CODE_READ_ONLY, 'expected one supported non-locking read query');
  if (query === '') throw refused();
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
  // The key ordinal is a correlated subquery that names the table by constants: a join of KEY_COLUMN_USAGE makes MariaDB open every
  // table of every database (DIA-210). The parameters are the namespace and the name, twice. The native type is COLUMN_TYPE in
  // the form of MySQL 8.4, which MariaDB writes with an integer display width (DIA-204).
  mysql: "SELECT c.COLUMN_NAME,CASE WHEN c.COLUMN_TYPE='year(4)' THEN 'year' WHEN c.DATA_TYPE IN ('tinyint','smallint','mediumint','int','bigint') AND c.COLUMN_TYPE<>'tinyint(1)' AND c.COLUMN_TYPE NOT LIKE '%zerofill' AND LOCATE('(',c.COLUMN_TYPE)>0 THEN CONCAT(c.DATA_TYPE,SUBSTRING(c.COLUMN_TYPE,LOCATE(')',c.COLUMN_TYPE)+1)) ELSE c.COLUMN_TYPE END,c.IS_NULLABLE='YES',(c.GENERATION_EXPRESSION IS NOT NULL AND c.GENERATION_EXPRESSION<>''),COALESCE((SELECT k.ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.CONSTRAINT_NAME='PRIMARY' AND k.COLUMN_NAME=c.COLUMN_NAME),0),(c.EXTRA LIKE '%auto_increment%'),c.COLUMN_DEFAULT,(c.EXTRA LIKE '%DEFAULT_GENERATED%') FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",
  postgres: 'SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>\'\' OR a.attidentity=\'a\'),COALESCE(k.ord,0),(a.attidentity<>\'\'),CASE WHEN length(a.attgenerated)=0 THEN pg_get_expr(d.adbin,d.adrelid) END,(d.adbin IS NOT NULL AND length(a.attgenerated)=0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum',
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
  throw err(CODE_KIND, `relation kind ${quote(native)} of ${dialect}`);
}

/** The PostgreSQL settings that the output of a cell depends on by INT-185, as the columns of current_setting (INT-186). */
const POSTGRES_OUTPUT_SETTINGS = "current_setting('DateStyle'), current_setting('IntervalStyle'), current_setting('TimeZone'), " +
  "current_setting('extra_float_digits'), current_setting('bytea_output'), current_setting('lc_monetary'), current_setting('search_path')";

/** The number of the PostgreSQL output settings that each row of a read of cells carries (INT-186). */
const POSTGRES_OUTPUT_SETTING_COUNT = 7;

/**
 * Sets, for the transaction of a PostgreSQL session, the output settings under which the output of every cell kind is its exact text
 * (INT-186): ISO leaves the order of date input as it was.
 */
const POSTGRES_FIXED_OUTPUT_SQL = "SELECT set_config('DateStyle', 'ISO', true), set_config('extra_float_digits', '1', true), set_config('bytea_output', 'hex', true)";

/** The refusal of a read whose statement changed an output setting: it names no column, since it refuses the read as a whole (INT-186). */
function settingChanged(): OrmError {
  return err(CODE_VALUE, 'the query changed a setting that the output of its values depends on');
}

/**
 * The statement of a PostgreSQL read of cells, so that each row carries the output settings under which the server writes it (INT-186):
 * a MATERIALIZED CTE keeps a plan of its own, so the outer projection of a row runs right before the server sends that row and runs its
 * output functions. The one trailing semicolon that a read query may hold (validateReadOnly) cannot stand inside the CTE.
 */
function postgresSettingsRead(sql: string): string {
  let end = sql.length;
  queryWords(sql, 'postgres', at => { end = at; });
  return `WITH catalog_read AS MATERIALIZED (\n${sql.slice(0, end)}\n) SELECT catalog_read.*, ${POSTGRES_OUTPUT_SETTINGS} FROM catalog_read`;
}

/** A bound session: one pooled connection inside one transaction. It returns to the pool when it ends with an acknowledged COMMIT or ROLLBACK (CFG-35) and is discarded otherwise, so a session setting never returns to the pool. */
class Session {
  /** Set when a read stopped a statement before its end: the connection then holds rows that were not read, and only a discard is safe. */
  public stopped = false;
  /** Set when a MySQL stop killed its statement and the scan read the end of it: the connection is usable (CFG-35). */
  private killed = false;
  /** Kills the statement of a MySQL connection id through the kill connection of the catalog; set on MySQL only (CFG-35). */
  public kill: ((threadId: number) => Promise<boolean>) | undefined;

  /** The PostgreSQL output settings when the transaction began (INT-186); undefined on MySQL and SQLite. */
  private settings: string[] | undefined;

  /** server is the server of a mysql connection, which the connection read by VERSION() (DIA-201); postgres or sqlite otherwise. */
  public constructor(public readonly dialect: DriverName, private readonly session: DriverSession, private readonly server: DriverPool['server']) {}

  /** Fixes the PostgreSQL output settings for the transaction and reads the seven of INT-186 as the baseline of every read of cells. */
  public async fixOutputSettings(): Promise<void> {
    await this.control(POSTGRES_FIXED_OUTPUT_SQL);
    this.settings = await this.outputSettings();
  }

  /** The values of the PostgreSQL output settings in the transaction of the session. */
  private async outputSettings(): Promise<string[]> {
    const { rows } = await this.rawRows(`SELECT ${POSTGRES_OUTPUT_SETTINGS}`, [], 1, METADATA_BYTES);
    const [row] = rows;
    const settings = (row ?? []).filter((value): value is string => typeof value === 'string');
    if (rows.length !== 1 || row?.length !== POSTGRES_OUTPUT_SETTING_COUNT || settings.length !== POSTGRES_OUTPUT_SETTING_COUNT) {
      throw err(CODE_METADATA, 'current_setting returned no single row of settings');
    }
    return settings;
  }

  /**
   * Refuses a PostgreSQL session whose output settings, read after its rows and before its transaction ends, differ from their values
   * when the transaction began (INT-186): a change that no row carries, as in a result of no rows. A local setting reverts when the
   * transaction ends, so the check runs inside it.
   */
  public async settingsUnchanged(): Promise<void> {
    const baseline = this.settings;
    if (baseline === undefined) return;
    const now = await this.outputSettings();
    if (now.some((value, index) => value !== baseline[index])) throw settingChanged();
  }

  /**
   * Streams one statement and converts each row as it arrives. The stream stops at the first row past maxRows or past maxBytes, and
   * the read then fails with CATALOG_LIMIT; no row past the budget is converted or kept. Each cell is counted by its converted size
   * (sizeOf and gridSize). A conversion error stops the stream and is thrown after it. With keep, the first keep rows are
   * converted and the row after them is not: the stream stops there and past reports it, as the sentinel row of a page does. A read of
   * cells (cells) on PostgreSQL runs as postgresSettingsRead and refuses a row whose output settings differ from the baseline before any
   * of its values is converted (INT-186); the columns of the settings are no columns of the result and count against no budget.
   */
  public async collect<T>(
    sql: string,
    params: readonly unknown[],
    maxRows: number,
    maxBytes: number,
    convert: (value: unknown, column: DriverColumn, index: number) => { cell: T; size: number },
    keep?: number,
    cells = true,
  ): Promise<{ columns: DriverColumn[]; rows: T[][]; past: boolean }> {
    const bound = checkParams(params, CODE_PARAM);
    const baseline = cells ? this.settings : undefined;
    const width = baseline === undefined ? 0 : POSTGRES_OUTPUT_SETTING_COUNT;
    const statement = baseline === undefined ? sql : postgresSettingsRead(sql);
    const out: { columns: DriverColumn[]; rows: T[][]; past: boolean } = { columns: [], rows: [], past: false };
    let bytes = 0;
    let overflow: string | undefined;
    let failure: unknown;
    let lossy = false;
    // The values of a PostgreSQL type that only the server's catalog describes, in the order of the stream: each is read as a text cell
    // first, and its type is resolved after the stream, before the read answers.
    const unresolved: Array<{ oid: number; at: number }> = [];
    const deliver = (values: readonly unknown[]): boolean => {
        if (keep !== undefined && out.rows.length >= keep) {
          out.past = true;
          return false;
        }
        if (out.rows.length >= maxRows) {
          overflow = `result has more than ${maxRows} rows`;
          return false;
        }
        const cells: T[] = [];
        for (const [index, value] of values.entries()) {
          try {
            let column = columnAt(out.columns, index);
            const oid = value === null ? undefined : unresolvedOid(this.dialect, column);
            if (oid !== undefined) {
              const known = POSTGRES_BUILTIN_TEXT.get(oid);
              if (known === undefined) unresolved.push({ oid, at: index });
              column = resolvedColumn(column, known ?? true);
            }
            const converted = convert(value, column, index);
            bytes += converted.size;
            cells.push(converted.cell);
          } catch (error) {
            failure = atColumn(index, error);
            return false;
          }
        }
        if (bytes > maxBytes) {
          overflow = `result has more than ${maxBytes} bytes of values`;
          return false;
        }
        out.rows.push(cells);
        return true;
    };
    const kill = this.kill;
    const threadId = this.session.threadId;
    const stop = kill === undefined || threadId === undefined ? {} : {
      stop: async (): Promise<boolean> => {
        this.killed = await kill(threadId);
        return this.killed;
      },
    };
    await this.session.scan(statement, bound, {
      ...stop,
      columns: columns => {
        if (columns.length < width) {
          failure = err(CODE_METADATA, 'the read returned fewer columns than its output settings');
          return;
        }
        out.columns = width === 0 ? columns : columns.slice(0, -width);
      },
      row: received => {
        if (failure !== undefined) return false;
        let values = received;
        if (baseline !== undefined) {
          const settings = received.slice(-width);
          if (settings.some((value, index) => value !== baseline[index])) {
            failure = settingChanged();
            return false;
          }
          values = received.slice(0, -width);
        }
        if (this.dialect === 'sqlite' && values.some(value => typeof value === 'string' && value.includes('\uFFFD'))) {
          lossy = true;
          return false;
        }
        return deliver(values);
      },
    }, noop);
    if (lossy) {
      // The first read stopped at a text that may have lost its bytes, before that row was delivered. What it kept is thrown
      // away and the whole answer comes from this read, under the same budget from zero: no row of the two reads is mixed, so
      // the answer is the result of one execution. Every read of a catalog session runs inside the transaction of the session,
      // and the first read has ended, so this read sees the same snapshot.
      out.rows = [];
      out.past = false;
      bytes = 0;
      await this.session.scan(sqliteStoredRead(sqliteQueryText(sql), out.columns.length), bound, {
        columns: () => undefined,
        row: values => deliver(sqliteStoredCells(values)),
      }, noop);
    }
    // A column of a type that holds a multirange is refused by its type, NULL or not, and the first such column is the failure of the
    // read, before any refusal of a value (INT-185).
    const typed = out.columns.flatMap((column, at) => {
      const oid = unresolvedOid(this.dialect, column);
      return oid === undefined ? [] : [{ oid, at }];
    });
    const kinds = typed.length > 0 || unresolved.length > 0 ? await this.postgresKinds([...new Set([...typed, ...unresolved].map(item => item.oid))]) : undefined;
    const multirange = typed.find(item => kinds?.get(item.oid)?.multirange === true);
    if (multirange !== undefined) {
      failure = atColumn(multirange.at, refuse('native'));
      overflow = undefined;
    } else if (unresolved.length > 0) {
      // Every value read before a failure or a stop precedes it in the stream, so the first one of a type with no cell (INT-170) is the
      // failure of the read.
      const refused = unresolved.find(item => kinds?.get(item.oid)?.text !== true);
      if (refused !== undefined) {
        failure = atColumn(refused.at, refuse('native'));
        overflow = undefined;
      }
    }
    // A statement that a kill ended has been read to its end, so its connection holds no row.
    if (failure !== undefined) {
      this.stopped = !this.killed;
      throw failure;
    }
    if (overflow !== undefined) {
      this.stopped = !this.killed;
      throw err(CODE_LIMIT, overflow);
    }
    return out;
  }

  /**
   * Whether each PostgreSQL type of oids has a text cell and whether it holds a multirange (INT-185), from the server's catalog in this
   * session (POSTGRES_TYPES_SQL). A built-in type, whose oid is below 16384 (FirstNormalObjectId), is kept for later reads and read
   * once; another type can change between reads.
   */
  private async postgresKinds(oids: readonly number[]): Promise<Map<number, { text: boolean; multirange: boolean }>> {
    const kinds = new Map<number, { text: boolean; multirange: boolean }>();
    const unknown: number[] = [];
    for (const oid of oids) {
      const text = POSTGRES_BUILTIN_TEXT.get(oid);
      const multirange = POSTGRES_BUILTIN_MULTIRANGE.get(oid);
      if (text === undefined || multirange === undefined) unknown.push(oid);
      else kinds.set(oid, { text, multirange });
    }
    if (unknown.length === 0) return kinds;
    const rows: unknown[][] = [];
    await this.session.scan(POSTGRES_TYPES_SQL, [`{${unknown.join(',')}}`], { columns: () => undefined, row: values => { rows.push([...values]); return true; } }, noop);
    const types = postgresTypes(rows);
    for (const oid of unknown) {
      const found = { text: postgresText(oid, types), multirange: holdsMultirange(oid, types) };
      kinds.set(oid, found);
      if (oid < 16384) {
        POSTGRES_BUILTIN_TEXT.set(oid, found.text);
        POSTGRES_BUILTIN_MULTIRANGE.set(oid, found.multirange);
      }
    }
    return kinds;
  }

  /** Reads the rows of a statement with each value as it is, counted by its size. */
  public async rawRows(sql: string, params: readonly unknown[], maxRows: number, maxBytes: number): Promise<{ columns: DriverColumn[]; rows: unknown[][] }> {
    return this.collect<unknown>(sql, params, maxRows, maxBytes, value => ({ cell: value, size: sizeOf(value) }), undefined, false);
  }

  /** Runs a statement that returns no rows and returns the number of rows it changed. */
  public async exec(sql: string, params: readonly unknown[]): Promise<number> {
    const bound = checkParams(params, CODE_PARAM);
    const result = bound.length === 0
      ? await this.session.control(sql, [], noop)
      : await this.session.execute(sql, bound, undefined, noop);
    return result.affected;
  }

  /** Runs one statement and retains driver-owned metadata such as an AUTO_INCREMENT acknowledgement. */
  public async executeResult(sql: string, params: readonly unknown[]): Promise<DriverResult> {
    const bound = checkParams(params, CODE_PARAM);
    return bound.length === 0
      ? this.session.control(sql, [], noop)
      : this.session.execute(sql, bound, undefined, noop);
  }

  public async control(sql: string): Promise<void> {
    await this.session.control(sql, [], noop);
  }

  /**
   * Whether ROLLBACK has a transaction to end. SQLite rolls a transaction back by itself after some errors, such as RAISE(ROLLBACK) or
   * an I/O error, and a ROLLBACK then fails with "no transaction is active" (INT-155).
   */
  public get open(): boolean {
    return this.dialect !== 'sqlite' || this.session.inTransaction?.() !== false;
  }

  /** Returns the connection to the pool, or closes it when discard is set. */
  public release(discard: boolean): void {
    this.session.release(discard);
  }

  /**
   * Reads the rows of a plain query: each value by the native type of its column, a temporal value as the text of its grid cell
   * (INT-153). A read of cells (cells) checks the output settings of each row (INT-186); a read of metadata does not.
   */
  public async plainRows(sql: string, params: readonly unknown[], maxRows: number, maxBytes: number, cells = false): Promise<{ columns: DriverColumn[]; rows: CatalogValue[][] }> {
    return this.collect<CatalogValue>(sql, params, maxRows, maxBytes, (value, column) => {
      const cell = plainValue(value, column, this.dialect);
      return { cell, size: sizeOf(cell) };
    }, undefined, cells);
  }

  /** Reads one table descriptor: the kind, the columns, the key in constraint order and the identity flag. */
  public async describe(ref: CatalogTableRef): Promise<CatalogTableMetadata> {
    checkTable(ref);
    if (this.dialect === 'sqlite' && ref.namespace !== 'main') throw err(CODE_NAMESPACE, 'SQLite requires main');
    const kindRows = (await this.plainRows(KIND_SQL[this.dialect], [ref.namespace, ref.name], 2, METADATA_BYTES)).rows;
    if (kindRows.length === 0) throw err(CODE_TABLE_NOT_FOUND, `${ref.namespace}.${ref.name}`);
    const [kindRow] = kindRows;
    if (kindRows.length !== 1 || kindRow === undefined || kindRow.length !== 1) throw err(CODE_METADATA, 'ambiguous relation');
    const nativeKind = kindRow[0];
    if (typeof nativeKind !== 'string') throw err(CODE_METADATA, 'relation kind is not text');
    const kind = catalogKind(this.dialect, nativeKind);

    // SQLite table-valued pragmas take the table name first and the schema second.
    // The mysql query names the table twice, in its key-ordinal subquery and in its WHERE (DIA-210).
    const args = this.dialect === 'sqlite' ? [ref.name, ref.namespace] : this.dialect === 'mysql' ? [ref.namespace, ref.name, ref.namespace, ref.name] : [ref.namespace, ref.name];
    const rows = (await this.plainRows(COLUMNS_SQL[this.dialect], args, METADATA_ROWS, METADATA_BYTES)).rows;

    const columns: CatalogColumn[] = [];
    const keys: Array<{ ordinal: number; index: number }> = [];
    for (const row of rows) {
      if (row.length !== 8) throw err(CODE_METADATA, `column shape of ${row.length} values`);
      const name = textOf(row[0], 'column name');
      checkName(name);
      if (columns.some(existing => existing.name === name)) throw err(CODE_METADATA, `duplicate column ${quote(name)}`);
      const ordinal = intOf(row[4], 'key ordinal');
      if (ordinal < 0) throw err(CODE_METADATA, 'negative key ordinal');
      let defaultExpression = row[6] === null ? null : textOf(row[6], `default of column "${name}"`);
      let expressionDefault = boolOf(row[7], 'expression default');
      // MariaDB writes COLUMN_DEFAULT as SQL text and no DEFAULT_GENERATED, so the default is read in MySQL's form by the rule of the
      // dbspec introspection, whose EXTRA is empty here: the query reads the DEFAULT_GENERATED flag, which MariaDB never sets (DIA-205).
      if (this.server === 'mariadb') {
        let read: { dflt: string | null; extra: string };
        try {
          read = mariadbDefault(defaultExpression, '');
        } catch (error) {
          throw err(CODE_METADATA, `column "${name}": ${error instanceof Error ? error.message : String(error)}`, error);
        }
        defaultExpression = read.dflt;
        expressionDefault = read.extra === 'DEFAULT_GENERATED';
      }
      const column: CatalogColumn = {
        name,
        nativeType: textOf(row[1], `native type of column "${name}"`),
        nullable: boolOf(row[2], 'nullable'),
        generated: boolOf(row[3], 'generated'),
        automaticKey: boolOf(row[5], 'automatic key'),
        defaultExpression,
        expressionDefault,
        checkPrecision: null,
      };
      if (ordinal > 0) keys.push({ ordinal, index: columns.length });
      columns.push(column);
    }
    if (this.dialect === 'sqlite' && kind === 'table') {
      // The dbspec renderer writes the fraction digits of a TIME or DATETIME column into a CHECK of the table's own definition.
      const tables = (await this.plainRows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [ref.name], 2, METADATA_BYTES)).rows;
      const [tableRow] = tables;
      // A view has no definition of a table, and so no CHECK of a table's own (INT-113).
      if (tableRow !== undefined) {
        if (tables.length !== 1 || tableRow.length !== 1 || typeof tableRow[0] !== 'string') {
          throw err(CODE_METADATA, `the definition of table "${ref.name}" is not one text`);
        }
        const definition = tableRow[0];
        for (const column of columns) {
          const declared = column.nativeType.toUpperCase();
          if (declared === 'TIME' || declared === 'DATETIME') column.checkPrecision = checkPrecisionOf(definition, column.name);
        }
      }
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
        const [indexRow] = (await this.plainRows("SELECT count(*) FROM pragma_index_list(?,?) WHERE origin='pk'", args, 1, METADATA_BYTES)).rows;
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
    const predicate = metadata.primaryKey.map((name, index) => `${quoteIdent(name, this.dialect)}=${placeholder(index + 1, this.dialect)}`).join(' AND ');
    const sql = `SELECT ${quoteList(metadata.columns.map(column => column.name), this.dialect)} FROM ${qualified(metadata.table, this.dialect)}` +
      ` WHERE ${predicate} LIMIT 2${suffix}`;
    const raw = await this.collect<CatalogValue>(sql, keys, 2, PAGE_BYTES, (value, column, index) => describedCell(value, column, metadata.columns[index], this.dialect));
    if (raw.columns.length !== metadata.columns.length) throw err(CODE_WRITE, 'row shape differs from descriptor');
    return raw.rows;
  }

  /**
   * Refuses a MySQL row change on a table whose engine is not InnoDB, as only InnoDB rolls a failed verification back (INT-106).
   * A trigger of the table needs no check: the verification of the written row sees what it changed (INT-110).
   */
  public async mysqlSafety(metadata: CatalogTableMetadata): Promise<void> {
    const unsupported = (reason: string): OrmError => err(CODE_UNSUPPORTED, reason);
    const engine = (await this.rawRows('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
      [metadata.table.namespace, metadata.table.name], 2, 4096)).rows;
    const [engineRow] = engine;
    if (engine.length !== 1 || engineRow === undefined || engineRow.length !== 1 || typeof engineRow[0] !== 'string' || engineRow[0].toLowerCase() !== 'innodb') {
      throw unsupported('MySQL requires InnoDB');
    }
  }
}

/** The column of a result at index; the driver returns one name and type per cell, so a missing column is a shape error. */
function columnAt(columns: DriverColumn[], index: number): DriverColumn {
  const column = columns[index];
  if (column === undefined) throw err(CODE_METADATA, `no column at position ${index}`);
  return column;
}


function textOf(value: unknown, what: string): string {
  if (typeof value !== 'string') throw err(CODE_METADATA, `expected text for ${what}, got ${typeof value}`);
  return value;
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

const BEGIN_SQL: Record<DriverName, { read: string; write: string }> = {
  mysql: { read: 'START TRANSACTION READ ONLY', write: 'START TRANSACTION' },
  postgres: { read: 'BEGIN READ ONLY', write: 'BEGIN' },
  sqlite: { read: 'BEGIN', write: 'BEGIN IMMEDIATE' },
};

/** A native catalog connection to a MySQL, PostgreSQL or SQLite database selected by its DSN. */
export class CatalogConnection {
  private closed = false;
  /** Until when a refused connect is a socket of this catalog still on the server (CFG-35). */
  private reopenUntil = 0;
  /**
   * The MySQL connection that a budget stop kills the statement of a read through (CFG-35). The catalog opens it at its first stop
   * and keeps it until close, so that no stop closes a connection that a later stop must open again.
   */
  private killer: DriverSession | undefined;

  /** @internal */
  public constructor(public readonly dialect: DriverName, private readonly pool: DriverPool) {}

  /** Releases the connection pool, once: a second close does nothing. An operation after close fails with CATALOG_CLOSED and sends no statement. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.killer?.release(false);
    this.killer = undefined;
    await this.pool.close();
  }

  /**
   * Kills the running statement of the MySQL connection id through the kill connection, which the first stop opens (CFG-35). It
   * answers false when the server refuses that connection or the kill, and a kill connection that failed is closed.
   */
  private async killQuery(threadId: number): Promise<boolean> {
    try {
      this.killer ??= await this.reserveConnection();
      await this.killer.control(`KILL QUERY ${threadId}`, [], noop);
      return true;
    // catch-any -- every failure of the kill connection or of its KILL QUERY leaves the stop to close its socket (CFG-35)
    } catch {
      if (this.killer !== undefined) {
        this.killer.release(true);
        this.killer = undefined;
        this.reopenUntil = Date.now() + 2000;
      }
      return false;
    }
  }

  /** Fails with CATALOG_CLOSED once close has run. */
  private ensureOpen(): void {
    if (this.closed) throw err(codes.CATALOG_CLOSED, 'the catalog connection is closed');
  }

  /** Opens a session in a read-only transaction, or a writable one. */
  /** Closes the connection of a session, whose place the server frees a moment later. */
  private discard(session: Session): void {
    session.release(true);
    if (this.dialect === 'mysql') this.reopenUntil = Date.now() + 2000;
  }

  /**
   * Reserves a connection. A socket that this catalog closed holds its place in max_user_connections until the server ends
   * that thread. The server announces that to no one, so this is a timer: the reopen is tried again within the 2 s of CFG-35
   * from the close (within 40 ms measured). A connect that follows no close of this catalog fails at once.
   */
  private async reserveConnection(): ReturnType<typeof this.pool.reserve> {
    for (;;) {
      try {
        return await this.pool.reserve();
      } catch (error) {
        // The driver error of the reserve holds the server's error as its cause.
        const cause = error instanceof Error ? error.cause : undefined;
        const full = typeof cause === 'object' && cause !== null && 'errno' in cause && cause.errno === 1226;
        if (!full || Date.now() >= this.reopenUntil) throw error;
        await new Promise(resolve => { setTimeout(resolve, 10); });
      }
    }
  }

  private async begin(readOnly: boolean): Promise<Session> {
    this.ensureOpen();
    const session = new Session(this.dialect, await this.reserveConnection(), this.pool.server);
    if (this.dialect === 'mysql') session.kill = async threadId => this.killQuery(threadId);
    try {
      // SQLite has one connection that every session shares, so each session sets query_only itself and does not inherit it.
      if (this.dialect === 'sqlite') await session.control(`PRAGMA query_only=${readOnly ? 'ON' : 'OFF'}`);
      // At REPEATABLE READ the information schema answers from the snapshot of the transaction, so a descriptor read after the rows could not differ from the one read before them (INT-121).
      if (readOnly && this.dialect === 'mysql') await session.control('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await session.control(readOnly ? BEGIN_SQL[this.dialect].read : BEGIN_SQL[this.dialect].write);
      // A catalog session runs after schema changes by design, and through PgBouncer a Parse of a text that the server connection already
      // holds never reaches the server, so a plan from before the change would fail or keep its old parameter types. The transaction holds
      // that server connection for the whole session (CFG-28).
      if (this.dialect === 'postgres') await session.control('DEALLOCATE ALL');
      // Every read of cells checks its rows against the output settings that the transaction begins with (INT-186).
      if (this.dialect === 'postgres') await session.fixOutputSettings();
    } catch (error) {
      this.discard(session);
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
      await session.settingsUnchanged();
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
      await session.settingsUnchanged();
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
      let message = `commit outcome unknown; do not retry: ${mapped.message}`;
      let rollback: OrmError | undefined;
      if (this.dialect === 'sqlite') {
        // SQLite keeps its one connection when a session is released, so end any transaction left by the unknown COMMIT.
        try {
          if (session.open) await session.control('ROLLBACK');
        } catch (rollbackError) {
          rollback = driverError(this.dialect, rollbackError);
          message += `; rollback failed: ${rollback.message}`;
        }
      }
      this.discard(session);
      throw new OrmError(CODE_COMMIT_UNKNOWN, message, mapped, rollback);
    }
    // The acknowledged COMMIT ended the transaction and its locks, and a writable session changes no setting of its connection, so
    // the next session takes this connection (INT-106d).
    session.release(false);
    return value;
  }

  /**
   * Ends a session and returns the error to throw, joined with a failed rollback. A session that a read stopped early is discarded
   * without a rollback on MySQL and PostgreSQL, where the discard ends the server's transaction; SQLite's shared connection is rolled back.
   * A session whose ROLLBACK the server acknowledged holds no lock and no state of its own, so the next session takes its connection
   * and a catalog runs its sessions on one connection (CFG-35).
   */
  private async endSession(session: Session, error: unknown): Promise<OrmError | undefined> {
    let failure: OrmError | undefined = error === undefined ? undefined : driverError(this.dialect, error);
    if (!session.stopped || this.dialect === 'sqlite') {
      try {
        if (session.open) await session.control('ROLLBACK');
      } catch (rollbackError) {
        const rolled = driverError(this.dialect, rollbackError);
        failure = failure === undefined
          ? err(CODE_ROLLBACK, `rollback: ${rolled.message}`, rolled)
          : err(CODE_ROLLBACK, `${failure.message}; rollback: ${rolled.message}`, failure);
        this.discard(session);
        return failure;
      }
      if (!session.stopped) {
        session.release(false);
        return failure;
      }
    }
    this.discard(session);
    return failure;
  }

  /** The namespace of the connection: the current schema of PostgreSQL, the current database of MySQL, and main for SQLite. */
  public async currentNamespace(): Promise<string> {
    this.ensureOpen();
    if (this.dialect === 'sqlite') return 'main';
    const query = this.dialect === 'postgres' ? 'SELECT current_schema()' : 'SELECT DATABASE()';
    return this.read(async session => {
      const { rows } = await session.plainRows(query, [], 2, METADATA_BYTES);
      const [row] = rows;
      if (rows.length !== 1 || row === undefined || row.length !== 1) throw err(CODE_NAMESPACE_UNAVAILABLE, 'the connection reported no single namespace');
      const name = row[0];
      if (typeof name !== 'string') throw err(CODE_NAMESPACE_UNAVAILABLE, 'the connection reported no text namespace');
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
      throw err(CODE_PAGE_INVALID, 'limit requires 1..1000 and offset 0..1000000');
    }
    return this.read(async session => {
      const metadata = await session.describe(table);
      if (metadata.columns.length === 0) throw err(CODE_PAGE_UNSUPPORTED, 'relation has no selectable columns');
      let sql = `SELECT ${quoteList(metadata.columns.map(column => column.name), this.dialect)} FROM ${qualified(table, this.dialect)}`;
      if (metadata.primaryKey.length > 0) sql += ` ORDER BY ${quoteList(metadata.primaryKey, this.dialect)}`;
      // One extra row is the sentinel that reports hasMore; the stream stops at that row.
      sql += ` LIMIT ${limit + 1} OFFSET ${offset}`;
      // The sentinel row is not converted: the page keeps limit rows and reports the row after them.
      // A column that went away during the read fails the statement: the descriptor tells that from any other failure.
      const raw = await session.collect<CatalogValue>(sql, [], limit + 1, PAGE_BYTES, (value, column, index) => describedCell(value, column, metadata.columns[index], this.dialect), limit).catch(async (failure: unknown) => {
        if (!(failure instanceof OrmError && failure.code === CODE_LIMIT)) {
          const changed = await session.describe(table).then(after => !sameDescriptor(after, metadata), () => false);
          if (changed) throw err(CODE_PAGE_CHANGED, 'descriptor changed during read');
        }
        throw failure;
      });
      if (raw.columns.length !== metadata.columns.length || raw.columns.some((column, index) => column.name !== metadata.columns[index]?.name)) {
        throw err(CODE_PAGE_CHANGED, 'prepared columns differ from descriptor');
      }
      const after = await session.describe(table);
      if (!sameDescriptor(after, metadata)) throw err(CODE_PAGE_CHANGED, 'descriptor changed during read');
      const rows = raw.rows;
      const hasMore = raw.past;
      return {
        metadata,
        result: { columns: metadata.columns.map(column => ({ ...column })), rows },
        limit,
        offset,
        orderBy: [...metadata.primaryKey],
        hasMore,
        columnIndex: (name: string): number => metadata.columns.findIndex(column => column.name === name),
      };
    });
  }

  /** Runs one read query (SELECT, WITH or VALUES) in a fresh read-only session; each value is converted by its native type. */
  public async readOnlyQuery(query: string, params: readonly unknown[], limits: CatalogQueryLimits = {}): Promise<CatalogQueryResult> {
    const { maxRows, maxBytes } = this.queryBudget(query, params, limits);
    return this.read(async session => {
      const { columns, rows } = await session.plainRows(query, params, maxRows, maxBytes, true);
      return { columns: columns.map(column => column.name), rows };
    }).catch(refusedWrite);
  }

  /** Runs one read query and returns typed grid cells (the Rust grid rules): each cell is typed by its column's native type. */
  public async readOnlyGridQuery(query: string, params: readonly unknown[], limits: CatalogQueryLimits = {}): Promise<CatalogGridResult> {
    const { maxRows, maxBytes } = this.queryBudget(query, params, limits);
    return this.read(async session => {
      const raw = await session.collect<CatalogGridCell>(query, params, maxRows, maxBytes, (value, column) => {
        const cell = gridCell(value, column, this.dialect);
        return { cell, size: gridSize(cell) };
      });
      return {
        columns: raw.columns.map(column => ({ name: column.name, nativeType: column.type })),
        rows: raw.rows,
      };
    }).catch(refusedWrite);
  }

  /** Checks the statement and the limits of a read; a zero limit takes its default. */
  private queryBudget(query: string, params: readonly unknown[], limits: CatalogQueryLimits): { maxRows: number; maxBytes: number } {
    validateReadOnly(query, this.dialect);
    if ((limits.maxRows ?? 0) < 0 || (limits.maxBytes ?? 0) < 0) throw err(CODE_QUERY_LIMIT, 'limits must not be negative');
    checkParams(params, CODE_PARAM);
    return { maxRows: limits.maxRows || DEFAULT_QUERY_ROWS, maxBytes: limits.maxBytes || DEFAULT_QUERY_BYTES };
  }

  /** Captures the row at index of a page. The table must have a reliable identity, and the page must be a page of that table as tablePage reads it. */
  public rowSnapshotFromPage(page: CatalogTablePage, index: number): CatalogRowSnapshot {
    const invalid = (reason: string): OrmError => err(CODE_SNAPSHOT, `invalid original row or descriptor: ${reason}`);
    try { checkTable(page.metadata.table); } catch (error) { throw invalid(messageOf(error)); }
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000 || page.offset < 0 || page.offset > 1000000) {
      throw err(CODE_SNAPSHOT, 'invalid page bounds');
    }
    const rows = page.result.rows;
    const orderMatches = page.orderBy.length === page.metadata.primaryKey.length && page.orderBy.every((name, i) => name === page.metadata.primaryKey[i]);
    if (rows.length > page.limit || (page.hasMore && rows.length !== page.limit) || !orderMatches) {
      throw err(CODE_SNAPSHOT, 'page rows or order do not match its bounds');
    }
    const keyIndexes = descriptorKeys(page.metadata);
    const sameColumns = page.result.columns.length === page.metadata.columns.length &&
      page.result.columns.every((column, i) => column.name === page.metadata.columns[i]?.name);
    if (!sameColumns) throw err(CODE_SNAPSHOT, 'projection differs from descriptor');
    const row = rows[index];
    if (index < 0 || row === undefined) throw err(CODE_SNAPSHOT, `row index ${index} outside the page`);
    const cells = [...row];
    checkCells(page.metadata, cells);
    return new CatalogRowSnapshot(page.metadata, cells, keyIndexes, revisionOf(page.metadata, cells));
  }

  /** Inserts one row with explicit or database-generated primary-key values and returns the stored row before it commits. */
  public async insertRow(declared: CatalogTableMetadata, values: readonly CatalogAssignment[]): Promise<CatalogMutationResult> {
    const keyIndexes = descriptorKeys(declared);
    const changes = checkChanges(declared, values, CODE_INSERT_INVALID, this.dialect);
    const provided = new Map(changes.map(change => [change.index, change.value] as const));
    const omittedKeys = keyIndexes.filter(index => {
      const column = declared.columns[index];
      return !provided.has(index) && column !== undefined && (column.automaticKey || column.defaultExpression !== null);
    });
    if (this.dialect === 'mysql' && omittedKeys.filter(index => declared.columns[index]?.automaticKey === true).length > 1) {
      throw err(CODE_UNSUPPORTED, 'multiple generated primary keys are not supported');
    }
    const keys = keyIndexes.map(index => {
      if (!provided.has(index)) {
        if (omittedKeys.includes(index)) return null;
        // INT-123: an omitted key with no automatic_key or default_expression is ROW_INSERT_IDENTITY_REQUIRED.
        throw err(CODE_IDENTITY_REQUIRED, `primary-key value of "${declared.columns[index]?.name ?? ''}" is required`);
      }
      return provided.get(index) ?? null;
    });
    return this.write(async session => {
      if (this.dialect === 'mysql' && omittedKeys.length > 0) {
        // Retain the table metadata lock from its own row until the schema check and generated-key recovery complete.
        await session.control(`SELECT 1 FROM ${qualified(declared.table, this.dialect)} LIMIT 0 FOR UPDATE`);
      }
      if (this.dialect === 'postgres') {
        // The lock an INSERT takes, held before the schema check so that no DDL changes the table in between.
        await session.control(`LOCK TABLE ${qualified(declared.table, this.dialect)} IN ROW EXCLUSIVE MODE`);
      }
      if (omittedKeys.length === 0) {
        const existing = await session.lookup(declared, keys, true);
        if (existing.length !== 0) throw err(CODE_CONFLICT, 'insertion key already exists');
      }
      const descriptor = await session.describe(declared.table);
      if (!sameDescriptor(descriptor, declared)) throw err(CODE_SCHEMA, 'insertion descriptor changed');
      if (this.dialect === 'mysql') await session.mysqlSafety(descriptor);
      const expressionLocator = this.dialect === 'mysql' && omittedKeys.some(index => descriptor.columns[index]?.expressionDefault === true);
      const readInputLocator = () => session.collect<CatalogValue>(
        mysqlInputLocatorSql(descriptor, changes, this.dialect),
        mysqlInputLocatorParams(changes),
        2,
        PAGE_BYTES,
        (value, column, index) => describedCell(value, column, descriptor.columns[index], this.dialect),
      );
      const checkProjection = (columns: readonly DriverColumn[], message: string) => {
        if (columns.length !== descriptor.columns.length || columns.some((column, index) => column.name !== descriptor.columns[index]?.name)) {
          throw err(CODE_WRITE, message);
        }
      };
      if (expressionLocator) {
        const before = await readInputLocator();
        if (before.rows.length !== 0) throw err(CODE_AMBIGUOUS, 'generated identity locator already matches rows');
      }
      const names = changes.map(change => quoteIdent(descriptor.columns[change.index]?.name ?? '', this.dialect));
      const marks = changes.map((_, index) => placeholder(index + 1, this.dialect));
      const target = `INSERT INTO ${qualified(descriptor.table, this.dialect)}`;
      const insert = names.length > 0
        ? `${target} (${names.join(',')}) VALUES (${marks.join(',')})`
        : this.dialect === 'mysql' ? `${target} () VALUES ()` : `${target} DEFAULT VALUES`;
      let after: CatalogValue[][];
      if (omittedKeys.length > 0 && this.dialect !== 'mysql') {
        const returning = quoteList(descriptor.columns.map(column => column.name), this.dialect);
        const result = await session.collect<CatalogValue>(
          `${insert} RETURNING ${returning}`,
          changes.map(change => change.value),
          2,
          PAGE_BYTES,
          (value, column, index) => describedCell(value, column, descriptor.columns[index], this.dialect),
        );
        checkProjection(result.columns, 'returned insert projection differs from descriptor');
        if (result.rows.length !== 1) throw err(CODE_WRITE, `expected exactly one inserted row, got ${result.rows.length}`);
        const returned = result.rows[0] ?? [];
        checkCells(descriptor, returned);
        // RETURNING reports the row before an AFTER trigger runs, so the stored row is read again by its keys.
        after = await session.lookup(descriptor, keyIndexes.map(index => returned[index] ?? null), false);
      } else if (expressionLocator) {
        const affected = await session.exec(insert, changes.map(change => change.value));
        if (affected !== 1) throw err(CODE_WRITE, `expected exactly one inserted row, got ${affected}`);
        const result = await readInputLocator();
        checkProjection(result.columns, 'generated insert locator projection differs from descriptor');
        if (result.rows.length !== 1) throw err(CODE_AMBIGUOUS, 'expected exactly one inserted locator row');
        checkCells(descriptor, result.rows[0] ?? []);
        after = result.rows;
      } else {
        const result = await session.executeResult(insert, changes.map(change => change.value));
        const affected = result.affected;
        if (affected !== 1) throw err(CODE_WRITE, `expected exactly one inserted row, got ${affected}`);
        const autoKeys = omittedKeys.filter(index => descriptor.columns[index]?.automaticKey === true);
        if (autoKeys.length > 0 && (result.insertId === null || result.insertId === 0 || result.insertId === 0n)) {
          throw err(CODE_WRITE, 'insert acknowledgement has no generated primary key');
        }
        const predicates: string[] = [];
        const bound: DriverValue[] = [];
        for (const index of keyIndexes) {
          const column = descriptor.columns[index];
          if (column === undefined) throw err(CODE_SCHEMA, 'insertion key descriptor changed');
          const quoted = quoteIdent(column.name, this.dialect);
          if (provided.has(index)) {
            predicates.push(`${quoted}=${placeholder(bound.length + 1, this.dialect)}`);
            bound.push(provided.get(index) ?? null);
          } else if (column.automaticKey) {
            if (result.insertId === null) throw err(CODE_WRITE, 'insert acknowledgement has no generated primary key');
            predicates.push(`${quoted}=${placeholder(bound.length + 1, this.dialect)}`);
            try {
              bound.push(integerValue(hostInteger(result.insertId)));
            } catch (error) {
              throw atColumn(index, error);
            }
          } else if (column.defaultExpression !== null && !column.expressionDefault) {
            predicates.push(`${quoted}=DEFAULT(${quoted})`);
          } else {
            throw err(CODE_AMBIGUOUS, `no safe generated-key locator for "${column.name}"`);
          }
        }
        const rowLock = this.dialect === 'sqlite' ? '' : ' FOR UPDATE';
        const query = `SELECT ${quoteList(descriptor.columns.map(column => column.name), this.dialect)} FROM ${qualified(descriptor.table, this.dialect)} WHERE ${predicates.join(' AND ')} LIMIT 2${rowLock}`;
        const resultRows = await session.collect<CatalogValue>(query, bound, 2, PAGE_BYTES,
          (value, column, index) => describedCell(value, column, descriptor.columns[index], this.dialect));
        if (resultRows.columns.length !== descriptor.columns.length || resultRows.columns.some((column, index) => column.name !== descriptor.columns[index]?.name)) {
          throw err(CODE_WRITE, 'generated key lookup projection differs from descriptor');
        }
        if (resultRows.rows.length !== 1) throw err(CODE_WRITE, 'expected exactly one inserted row');
        checkCells(descriptor, resultRows.rows[0] ?? []);
        after = resultRows.rows;
      }
      if (after.length !== 1) throw err(CODE_WRITE, 'expected exactly one inserted row');
      const afterDescriptor = await session.describe(declared.table);
      if (!sameDescriptor(afterDescriptor, descriptor)) throw err(CODE_SCHEMA, 'insertion descriptor changed');
      const [stored] = after;
      if (stored === undefined) throw err(CODE_WRITE, 'expected exactly one inserted row');
      for (const change of changes) {
        if (!sameWritten(stored[change.index], change.value)) {
          throw err(CODE_WRITE, `stored inserted values of "${descriptor.columns[change.index]?.name ?? ''}" differ`);
        }
      }
      return { columns: descriptor.columns.map(column => column.name), rows: after };
    });
  }

  /** Updates the row of an original snapshot. Inside the transaction it locks the row by its original keys, compares it with the snapshot and writes; then it re-reads the row and requires the written values. */
  public async updateRow(original: CatalogRowSnapshot, values: readonly CatalogAssignment[]): Promise<CatalogMutationResult> {
    original.valid();
    const changes = checkChanges(original.metadata, values, CODE_UPDATE_INVALID, this.dialect);
    const updated = [...original.originalCells()];
    for (const change of changes) updated[change.index] = change.value;
    try { checkCells(original.metadata, updated); } catch (error) {
      throw err(CODE_UPDATE_INVALID, `invalid updated row: ${messageOf(error)}`, error);
    }
    try { revisionOf(original.metadata, updated); } catch (error) {
      throw err(CODE_UPDATE_LIMIT, `updated row budget exceeded: ${messageOf(error)}`, error);
    }
    const keys = original.keys();
    const keyIndexes = original.keyIndexList();
    return this.write(async session => {
      const descriptor = await this.lockOriginal(session, original, keys);
      const sets = changes.map((change, index) => `${quoteIdent(descriptor.columns[change.index]?.name ?? '', this.dialect)}=${placeholder(index + 1, this.dialect)}`);
      const args: DriverValue[] = checkParams([...changes.map(change => change.value), ...keys.map(key => key ?? null)], CODE_PARAM);
      const predicate = descriptor.primaryKey
        .map((name, index) => `${quoteIdent(name, this.dialect)}=${placeholder(changes.length + index + 1, this.dialect)}`)
        .join(' AND ');
      const affected = await session.exec(`UPDATE ${qualified(descriptor.table, this.dialect)} SET ${sets.join(',')} WHERE ${predicate}`, args);
      // MySQL reports zero for an update that changes nothing; the re-read below is the authority there.
      if (affected > 1 || (affected === 0 && this.dialect !== 'mysql')) throw err(CODE_WRITE, `unexpected affected row count ${affected}`);
      const newKeys = keyIndexes.map(index => updated[index] ?? null);
      const after = await session.lookup(descriptor, newKeys, false);
      if (after.length !== 1) throw err(CODE_WRITE, `expected exactly one updated row, got ${after.length}`);
      const afterDescriptor = await session.describe(original.metadata.table);
      if (!sameDescriptor(afterDescriptor, descriptor)) throw err(CODE_SCHEMA, 'original descriptor changed');
      const [stored] = after;
      if (stored === undefined) throw err(CODE_WRITE, 'expected exactly one updated row');
      descriptor.columns.forEach((column, index) => {
        if (column.generated) return; // A generated column may be recomputed by the database.
        if (!sameWritten(stored[index], updated[index])) throw err(CODE_WRITE, `stored ordinary values of "${column.name}" differ`);
      });
      return { columns: descriptor.columns.map(column => column.name), rows: after };
    });
  }

  /** Deletes the row of an original snapshot and returns the number of rows deleted. */
  public async deleteRow(original: CatalogRowSnapshot): Promise<number> {
    original.valid();
    const keys = original.keys();
    return this.write(async session => {
      const descriptor = await this.lockOriginal(session, original, keys);
      const predicate = descriptor.primaryKey.map((name, index) => `${quoteIdent(name, this.dialect)}=${placeholder(index + 1, this.dialect)}`).join(' AND ');
      const affected = await session.exec(`DELETE FROM ${qualified(descriptor.table, this.dialect)} WHERE ${predicate}`, keys);
      if (affected !== 1) throw err(CODE_WRITE, `expected exactly one deleted row, got ${affected}`);
      const after = await session.lookup(descriptor, keys, false);
      if (after.length !== 0) throw err(CODE_WRITE, 'deleted row remains');
      const afterDescriptor = await session.describe(original.metadata.table);
      if (!sameDescriptor(afterDescriptor, descriptor)) throw err(CODE_SCHEMA, 'original descriptor changed');
      return affected;
    });
  }

  private async lockOriginal(
    session: Session,
    original: CatalogRowSnapshot,
    keys: readonly CatalogValue[],
  ): Promise<CatalogTableMetadata> {
    const current = await session.lookup(original.metadata, keys, true);
    const descriptor = await session.describe(original.metadata.table);
    if (!sameDescriptor(descriptor, original.metadata)) throw err(CODE_SCHEMA, 'original descriptor changed');
    checkCurrent(current, original.originalCells());
    if (this.dialect === 'mysql') await session.mysqlSafety(descriptor);
    return descriptor;
  }
}

/** Compares the rows that a key read returned with the original cells of a snapshot. */
function checkCurrent(current: readonly CatalogValue[][], original: readonly CatalogValue[]): void {
  if (current.length === 0) throw err(CODE_CONFLICT, 'original row is missing');
  if (current.length > 1) throw err(CODE_AMBIGUOUS, 'key selected multiple rows');
  const [row] = current;
  if (row === undefined || !sameRow(row, original)) throw err(CODE_CONFLICT, 'original values changed');
}

/**
 * Connects to the database that a mysql, postgres, sqlite or markdown DSN selects. A SQLite file must exist. A flowmark server runs SQL
 * in SQLite's dialect on the corpus, so the catalog of a corpus is a SQLite catalog (DIA-185).
 */
export async function connectCatalog(dsn: string): Promise<CatalogConnection> {
  const parsed = parseDsn(dsn);
  if (parsed.driver === 'markdown') {
    const pool = openMarkdown(parsed.markdown, { size: 10, idleSize: 10, lifetimeMs: 0 });
    try {
      (await pool.reserve()).release(false);
    } catch (error) {
      await pool.close();
      throw error;
    }
    return new CatalogConnection('sqlite', pool);
  }
  if (parsed.driver === 'sqlite') {
    let regular: boolean;
    try {
      // lstat does not follow a symbolic link: a link is not a regular file.
      regular = lstatSync(sqlitePath(dsn)).isFile();
    } catch (error) {
      throw err(codes.CONFIG, `CATALOG_SQLITE_FILE: ${messageOf(error)}`, error);
    }
    if (!regular) throw err(codes.CONFIG, 'CATALOG_SQLITE_FILE: expected an existing regular file');
  }
  // The catalog pool keeps integers exact (openDriver, exact).
  const pool = openDriver(dsn, parsed, { size: 10, idleSize: 10, lifetimeMs: 0 }, 256, 0, true);
  try {
    (await pool.reserve()).release(false);
  } catch (error) {
    await pool.close();
    throw error;
  }
  return new CatalogConnection(parsed.driver, pool);
}
