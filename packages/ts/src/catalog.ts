// The catalog connection (SCH-6a): native table metadata, bounded table pages, validated read-only queries, typed grid reads
// and explicit row changes over a MySQL, PostgreSQL or SQLite database selected by its DSN. Values follow the Go catalog
// (packages/go/orm/catalog*.go, catalogValue and catalogBytesValue); grid cells follow the Rust reference (packages/rust/build/src/tool_db/grid.rs
// and src/catalog, docs/spec/interfaces.md "Rust native grid query specification").
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import * as codes from './codes.js';
import { driverError, openDriver, parseDsn, sqlitePath, type DriverColumn, type DriverName, type DriverPool, type DriverSession, type DriverValue, type RowSink } from './driver.js';
import { OrmError } from './runtime_error.js';

/** Budgets of the catalog connection (docs/spec/interfaces.md). A result over its budget is refused, never truncated. */
const METADATA_ROWS = 2048;
const METADATA_BYTES = 4 << 20;
const PAGE_BYTES = 8 << 20;
const SNAPSHOT_BYTES = 8 << 20;
const DEFAULT_QUERY_ROWS = 100000;
const DEFAULT_QUERY_BYTES = 64 << 20;
const SQL_BYTES = 256 << 10;

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
 * One value of a plain read. An integer inside the JavaScript safe range is a number; a larger one is a bigint, so no integer
 * is rounded. Binary values are Uint8Array copies, decimals are their plain text, and temporal values are their dbspec text.
 */
export type CatalogValue = null | boolean | number | bigint | string | Uint8Array;

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

/** The native type name without the UNSIGNED suffix, which a MySQL integer carries when it is unsigned. */
function baseType(type: string): string {
  return type.replace(/ UNSIGNED$/, '').toUpperCase();
}

const INTEGER_TYPES = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT', 'INT2', 'INT4', 'INT8']);
const FLOAT32_TYPES = new Set(['FLOAT', 'FLOAT4']);
const FLOAT64_TYPES = new Set(['DOUBLE', 'FLOAT8']);
const DECIMAL_TYPES = new Set(['DECIMAL', 'NUMERIC']);
const TEXT_TYPES = new Set(['CHAR', 'VARCHAR', 'TEXT', 'BPCHAR', 'NAME', 'ENUM', 'SET']);
const BINARY_TYPES = new Set(['BLOB', 'BINARY', 'VARBINARY', 'BYTEA']);

/** A value of a native integer type as a bigint: a number, a decimal string, or a bigint. */
function integerOf(value: unknown, type: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw err(CODE_VALUE, `integer of native type "${type}" expected, got ${String(value)}`);
}

/** An integer for a plain read: a number inside the safe range, otherwise the exact bigint. */
function integerValue(value: bigint): CatalogValue {
  return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value;
}

/** Decodes the bytes of a text value of a native type as UTF-8; invalid bytes fail. */
function utf8Of(value: Uint8Array, type: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch (error) {
    throw err(CODE_VALUE, `text of native type "${type}" is not valid UTF-8: ${messageOf(error)}`, error);
  }
}

/** The Go catalog conversion of a binary driver value by its native type (catalogBytesValue): the MySQL and PostgreSQL text types arrive as bytes. */
function bytesValue(value: Uint8Array, type: string): CatalogValue {
  const upper = type.toUpperCase();
  if (/BLOB|BINARY|BYTEA/.test(upper)) return new Uint8Array(value);
  if (/DECIMAL|NUMERIC|MONEY/.test(upper)) return utf8Of(value, type);
  if (upper.includes('INT')) return integerValue(integerOf(utf8Of(value, type), type));
  if (/FLOAT|DOUBLE|REAL/.test(upper)) {
    const text = utf8Of(value, type);
    const number = Number(text);
    if (Number.isNaN(number) && text !== 'NaN') throw err(CODE_VALUE, `float of native type "${type}" is not a number: ${text}`);
    return number;
  }
  if (/CHAR|TEXT|JSON|ENUM|^SET|UUID|XML|NAME/.test(upper)) return utf8Of(value, type);
  throw err(CODE_VALUE, `unsupported native type "${type}"`);
}

/** A driver value of a plain read: the Go catalog conversion, with the native type of its column. */
function plainValue(value: unknown, column: DriverColumn): CatalogValue {
  if (value === null || typeof value === 'boolean') return value;
  if (value instanceof Uint8Array) return bytesValue(value, column.type);
  if (INTEGER_TYPES.has(baseType(column.type)) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint')) {
    return integerValue(integerOf(value, column.type));
  }
  if (typeof value === 'bigint') return integerValue(value);
  if (typeof value === 'number' && FLOAT32_TYPES.has(baseType(column.type))) {
    throw err(CODE_VALUE, `single-precision ${column.type} arrived as a number; it must arrive as its exact text`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw err(CODE_VALUE, 'a non-finite number is not a catalog value');
    return value;
  }
  if (typeof value === 'string' && FLOAT32_TYPES.has(baseType(column.type))) return float32FromBits(float32BitsOfText(value));
  if (typeof value === 'string') return value;
  throw err(CODE_VALUE, `unsupported driver value of type ${typeof value}`);
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
  if (match === null) throw err(CODE_VALUE, `float text "${text}" is not a decimal number`);
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

/** The number of fraction digits of a temporal text. */
function fractionDigits(text: string): number {
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_TEXT = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

/** A dbspec date `YYYY-MM-DD` from 0001-01-01 to 9999-12-31; any other text fails with GRID_TEMPORAL_VALUE. */
function dateText(text: string): string {
  const match = DATE_TEXT.exec(text);
  if (match === null) throw err(CODE_TEMPORAL_VALUE, `date "${text}" is not in the form YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw err(CODE_TEMPORAL_VALUE, `date "${text}" is outside 0001-01-01 to 9999-12-31 or is not a calendar date`);
  }
  return text;
}

/** A dbspec time `HH:MM:SS.ffffff` with six fraction digits, within 00:00:00 to 23:59:59.999999. */
function timeText(text: string): string {
  const match = TIME_TEXT.exec(text);
  if (match === null) throw err(CODE_TEMPORAL_VALUE, `time "${text}" is not in the form HH:MM:SS`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) throw err(CODE_TEMPORAL_VALUE, `time "${text}" is outside 00:00:00 to 23:59:59.999999`);
  return `${match[1]}:${match[2]}:${match[3]}.${(match[4] ?? '').padEnd(6, '0')}`;
}

/** A dbspec datetime `YYYY-MM-DD HH:MM:SS.ffffff` in UTC. */
function datetimeText(text: string): string {
  const [date = '', time = ''] = text.split(' ');
  if (text.split(' ').length !== 2) throw err(CODE_TEMPORAL_VALUE, `datetime "${text}" is not in the form YYYY-MM-DD HH:MM:SS`);
  return `${dateText(date)} ${timeText(time)}`;
}

/** The temporal kind of a native type of a dialect: date, time or datetime; undefined for every other type, and for SQLite, which keeps its text. */
function temporalKind(dialect: DriverName, type: string): 'date' | 'time' | 'datetime' | undefined {
  const head = baseType(type).split(/[( ]/)[0] ?? '';
  if (dialect === 'mysql') {
    if (head === 'DATE') return 'date';
    if (head === 'TIME') return 'time';
    if (head === 'DATETIME') return 'datetime';
    return undefined;
  }
  if (dialect === 'postgres') {
    if (head === 'DATE') return 'date';
    if (head === 'TIME') return 'time';
    if (head === 'TIMESTAMP') return 'datetime';
  }
  return undefined;
}

/**
 * The fraction digits of a described temporal column: the digits of its native type (MySQL time(3), PostgreSQL timestamp(3)
 * without time zone), or 0 for MySQL and 6 for PostgreSQL when the type names none.
 */
function declaredPrecision(dialect: DriverName, type: string): number {
  const match = /\((\d+)\)/.exec(type);
  if (match !== null) return Number(match[1]);
  return dialect === 'postgres' ? 6 : 0;
}

/**
 * A temporal value of a described column in its declared precision p (docs/spec/interfaces.md "Rust native grid query
 * specification"): exactly p fraction digits, GRID_TEMPORAL_PRECISION for a non-zero digit beyond p.
 */
function describedTemporal(value: string, kind: 'date' | 'time' | 'datetime', precision: number): string {
  if (kind === 'date') return dateText(value);
  const text = kind === 'time' ? timeText(value) : datetimeText(value);
  const dot = text.lastIndexOf('.');
  const head = text.slice(0, dot);
  const digits = text.slice(dot + 1);
  if (digits.slice(precision) !== '0'.repeat(Math.max(0, digits.length - precision))) {
    throw err(CODE_TEMPORAL_PRECISION, `temporal value "${value}" has more fraction digits than its precision ${precision}`);
  }
  return precision === 0 ? head : `${head}.${digits.slice(0, precision)}`;
}

/** A grid cell of a SQLite result: SQLite has no declared temporal type in a grid read, so text keeps its stored form. */
function sqliteGridCell(value: unknown): CatalogGridCell {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'bigint') {
    if (value < I64_MIN || value > I64_MAX) throw err(CODE_VALUE, `integer ${value.toString()} is outside the signed 64-bit range`);
    return { kind: 'integer', value };
  }
  if (typeof value === 'number') return { kind: 'float64', bits: float64Bits(value) };
  if (typeof value === 'string') return { kind: 'text', value };
  if (value instanceof Uint8Array) return { kind: 'binary', value: new Uint8Array(value) };
  throw err(CODE_VALUE, `unsupported driver value of type ${typeof value}`);
}

/** A grid cell of a MySQL or PostgreSQL column, by its native type (the Rust grid rules, decode and temporal forms). */
function gridCell(value: unknown, column: DriverColumn, dialect: DriverName): CatalogGridCell {
  if (value === null) return { kind: 'null' };
  if (dialect === 'sqlite') return sqliteGridCell(value);
  const type = column.type;
  const base = baseType(type);
  const unsupported = (): OrmError => err(CODE_VALUE, `grid cell of native type "${type}" is not supported`);
  const integer = (number: bigint): CatalogGridCell => {
    if (type.endsWith(' UNSIGNED')) {
      if (number < 0n || number > U64_MAX) throw err(CODE_VALUE, `unsigned integer ${number.toString()} is outside the 64-bit range`);
      return { kind: 'unsigned', value: number };
    }
    if (number < I64_MIN || number > I64_MAX) throw err(CODE_VALUE, `integer ${number.toString()} is outside the signed 64-bit range`);
    return { kind: 'integer', value: number };
  };
  if (value instanceof Uint8Array) {
    if (BINARY_TYPES.has(base)) return { kind: 'binary', value: new Uint8Array(value) };
    throw unsupported();
  }
  if (typeof value === 'boolean') {
    if (base === 'BOOL') return { kind: 'boolean', value };
    throw unsupported();
  }
  if (typeof value === 'number') {
    if (FLOAT32_TYPES.has(base)) throw err(CODE_VALUE, `single-precision ${type} arrived as a number; it must arrive as its exact text`);
    if (FLOAT64_TYPES.has(base)) return { kind: 'float64', bits: float64Bits(value) };
    if (INTEGER_TYPES.has(base) && Number.isInteger(value)) return integer(BigInt(value));
    throw unsupported();
  }
  if (typeof value === 'bigint') {
    if (INTEGER_TYPES.has(base)) return integer(value);
    throw unsupported();
  }
  if (typeof value !== 'string') throw unsupported();
  if (INTEGER_TYPES.has(base)) return integer(integerOf(value, type));
  if (FLOAT32_TYPES.has(base)) return { kind: 'float32', bits: float32BitsOfText(value) };
  if (FLOAT64_TYPES.has(base)) {
    const number = Number(value);
    if (Number.isNaN(number) && value !== 'NaN') throw err(CODE_VALUE, `float of native type "${type}" is not a number: ${value}`);
    return { kind: 'float64', bits: float64Bits(number) };
  }
  if (DECIMAL_TYPES.has(base)) {
    // A nonfinite PostgreSQL numeric stays unsupported (docs/spec/interfaces.md).
    if (!/^-?\d+(\.\d+)?$/.test(value)) throw unsupported();
    return { kind: 'decimal', value };
  }
  if (TEXT_TYPES.has(base)) return { kind: 'text', value };
  if (dialect === 'mysql' && base === 'DATE') return { kind: 'date', value: dateText(value) };
  if (dialect === 'mysql' && base === 'TIME') return { kind: 'time', value: timeText(value) };
  if (dialect === 'mysql' && base === 'DATETIME') return { kind: 'datetime', value: datetimeText(value) };
  if (dialect === 'postgres' && base === 'DATE') return { kind: 'date', value: dateText(value) };
  if (dialect === 'postgres' && base === 'TIME') return { kind: 'time', value: timeText(value) };
  if (dialect === 'postgres' && base === 'TIMESTAMP') return { kind: 'datetime', value: datetimeText(value) };
  throw unsupported();
}

/** A driver value of a described table: the plain conversion, then the temporal rules of its column (dbspec text for SQLite, the declared precision otherwise). */
function describedValue(value: unknown, column: DriverColumn, described: CatalogColumn | undefined, dialect: DriverName): CatalogValue {
  const plain = plainValue(value, column);
  if (described === undefined) return plain;
  if (dialect === 'sqlite') return sqliteTemporal(plain, described);
  if (typeof plain !== 'string') return plain;
  const kind = temporalKind(dialect, described.nativeType);
  if (kind === undefined) return plain;
  return describedTemporal(plain, kind, declaredPrecision(dialect, described.nativeType));
}

/** A cell of a described table with its size in the read budget. */
function describedCell(value: unknown, column: DriverColumn, described: CatalogColumn | undefined, dialect: DriverName): { cell: CatalogValue; size: number } {
  const cell = describedValue(value, column, described, dialect);
  return { cell, size: sizeOf(cell) };
}

/**
 * A SQLite temporal column of a described table (Rust temporal.rs, sqlite_kind): the stored text must be in the dbspec form, and its
 * fraction must have the digits that the table's dbspec CHECK fixes. A value that is no dbspec text is GRID_TEMPORAL_VALUE.
 */
function sqliteTemporal(plain: CatalogValue, described: CatalogColumn): CatalogValue {
  const declared = described.nativeType.toUpperCase();
  if (declared !== 'DATE' && declared !== 'TIME' && declared !== 'DATETIME') return plain;
  if (plain === null) return null;
  const kind = declared === 'DATE' ? 'date' : declared === 'TIME' ? 'time' : 'datetime';
  if (typeof plain !== 'string' || !dbspecTemporal(kind, plain)) {
    throw err(CODE_TEMPORAL_VALUE, `${described.name} holds a value that is not a dbspec ${kind}`);
  }
  if (kind === 'date') return plain;
  if (described.checkPrecision === null) throw err(CODE_TEMPORAL_PRECISION, `${described.name} has no dbspec CHECK that fixes its fraction digits`);
  const digits = fractionDigits(plain);
  if (digits !== described.checkPrecision) {
    throw err(CODE_TEMPORAL_PRECISION, `${described.name} holds ${digits} fraction digits; its dbspec CHECK fixes ${described.checkPrecision}`);
  }
  return plain;
}

/** Whether text is in the dbspec form of its kind: the rules of Rust's is_temporal, without any normalization. */
function dbspecTemporal(kind: 'date' | 'time' | 'datetime', text: string): boolean {
  const valid = (check: () => string): boolean => {
    try {
      check();
      return true;
    } catch {
      return false;
    }
  };
  if (kind === 'date') return text.length === 10 && valid(() => dateText(text));
  if (kind === 'time') {
    const [whole = '', digits] = text.split('.');
    if (whole.length !== 8 || (digits !== undefined && !/^[0-9]{1,6}$/.test(digits))) return false;
    return valid(() => timeText(whole));
  }
  const parts = text.split(' ');
  if (parts.length !== 2) return false;
  return dbspecTemporal('date', parts[0] ?? '') && dbspecTemporal('time', parts[1] ?? '');
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
  if (typeof cell === 'string') return `s${Buffer.byteLength(cell, 'utf8')}:${cell}`;
  if (cell instanceof Uint8Array) return `x${Buffer.from(cell).toString('hex')}`;
  throw err(CODE_SNAPSHOT, `unsupported cell type ${typeof cell}`);
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
function checkChanges(metadata: CatalogTableMetadata, values: readonly CatalogAssignment[], code: string): Array<{ index: number; value: DriverValue }> {
  if (values.length === 0 || values.length > metadata.columns.length) throw err(code, 'invalid column assignments');
  const params = checkParams(values.map(assignment => assignment.value), CODE_PARAM);
  const seen = new Set<string>();
  return values.map((assignment, position) => {
    const index = metadata.columns.findIndex(column => column.name === assignment.name);
    const column = metadata.columns[index];
    if (index < 0 || column === undefined) throw err(code, `unknown column "${assignment.name}"`);
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
  throw err(CODE_KIND, `relation kind "${native}" of ${dialect}`);
}

/** A bound session: one pooled connection inside one transaction. It is discarded when it ends, so a session setting never returns to the pool. */
class Session {
  /** Set when a read stopped a statement before its end: the connection then holds rows that were not read, and only a discard is safe. */
  public stopped = false;

  public constructor(public readonly dialect: DriverName, private readonly session: DriverSession) {}

  /**
   * Streams one statement and converts each row as it arrives. The stream stops at the first row past maxRows or past maxBytes, and
   * the read then fails with CATALOG_LIMIT; no row past the budget is converted or kept. Each cell is counted by its converted size
   * (sizeOf and gridSize). A conversion error stops the stream and is thrown after it.
   */
  public async collect<T>(
    sql: string,
    params: readonly unknown[],
    maxRows: number,
    maxBytes: number,
    convert: (value: unknown, column: DriverColumn, index: number) => { cell: T; size: number },
  ): Promise<{ columns: DriverColumn[]; rows: T[][] }> {
    const bound = checkParams(params, CODE_PARAM);
    const out: { columns: DriverColumn[]; rows: T[][] } = { columns: [], rows: [] };
    let bytes = 0;
    let overflow: string | undefined;
    let failure: unknown;
    const sink: RowSink = {
      columns: columns => { out.columns = columns; },
      row: values => {
        if (out.rows.length >= maxRows) {
          overflow = `result has more than ${maxRows} rows`;
          return false;
        }
        try {
          const cells: T[] = [];
          values.forEach((value, index) => {
            const converted = convert(value, columnAt(out.columns, index), index);
            bytes += converted.size;
            cells.push(converted.cell);
          });
          if (bytes > maxBytes) {
            overflow = `result has more than ${maxBytes} bytes of values`;
            return false;
          }
          out.rows.push(cells);
          return true;
        } catch (error) {
          failure = error;
          return false;
        }
      },
    };
    await this.session.scan(sql, bound, sink, noop);
    if (failure !== undefined) {
      this.stopped = true;
      throw failure;
    }
    if (overflow !== undefined) {
      this.stopped = true;
      throw err(CODE_LIMIT, overflow);
    }
    return out;
  }

  /** Reads the rows of a statement with each value as it is, counted by its size. */
  public async rawRows(sql: string, params: readonly unknown[], maxRows: number, maxBytes: number): Promise<{ columns: DriverColumn[]; rows: unknown[][] }> {
    return this.collect<unknown>(sql, params, maxRows, maxBytes, value => ({ cell: value, size: sizeOf(value) }));
  }

  /** Runs a statement that returns no rows and returns the number of rows it changed. */
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

  /** Reads the rows of a plain query: each value by the native type of its column. */
  public async plainRows(sql: string, params: readonly unknown[], maxRows: number, maxBytes: number): Promise<{ columns: DriverColumn[]; rows: CatalogValue[][] }> {
    return this.collect<CatalogValue>(sql, params, maxRows, maxBytes, (value, column) => {
      const cell = plainValue(value, column);
      return { cell, size: sizeOf(cell) };
    });
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
    const args = this.dialect === 'sqlite' ? [ref.name, ref.namespace] : [ref.namespace, ref.name];
    const rows = (await this.plainRows(COLUMNS_SQL[this.dialect], args, METADATA_ROWS, METADATA_BYTES)).rows;

    const columns: CatalogColumn[] = [];
    const keys: Array<{ ordinal: number; index: number }> = [];
    for (const row of rows) {
      if (row.length !== 8) throw err(CODE_METADATA, `column shape of ${row.length} values`);
      const name = textOf(row[0], 'column name');
      checkName(name);
      if (columns.some(existing => existing.name === name)) throw err(CODE_METADATA, `duplicate column "${name}"`);
      const ordinal = intOf(row[4], 'key ordinal');
      if (ordinal < 0) throw err(CODE_METADATA, 'negative key ordinal');
      const defaultExpression = row[6] === null ? null : textOf(row[6], `default of column "${name}"`);
      const column: CatalogColumn = {
        name,
        nativeType: textOf(row[1], `native type of column "${name}"`),
        nullable: boolOf(row[2], 'nullable'),
        generated: boolOf(row[3], 'generated'),
        automaticKey: boolOf(row[5], 'automatic key'),
        defaultExpression,
        expressionDefault: boolOf(row[7], 'expression default'),
        checkPrecision: null,
      };
      if (ordinal > 0) keys.push({ ordinal, index: columns.length });
      columns.push(column);
    }
    if (this.dialect === 'sqlite') {
      // The dbspec renderer writes the fraction digits of a TIME or DATETIME column into a CHECK of the table's own definition.
      const tables = (await this.plainRows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [ref.name], 2, METADATA_BYTES)).rows;
      const [tableRow] = tables;
      if (tables.length !== 1 || tableRow === undefined || tableRow.length !== 1 || typeof tableRow[0] !== 'string') {
        throw err(CODE_METADATA, `the definition of table "${ref.name}" is not one text`);
      }
      for (const column of columns) {
        const declared = column.nativeType.toUpperCase();
        if (declared === 'TIME' || declared === 'DATETIME') column.checkPrecision = checkPrecisionOf(tableRow[0], column.name);
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

  /** Refuses a MySQL row change unless the server, the account and the table are verified (mutation.rs, mysql_safety). */
  public async mysqlSafety(metadata: CatalogTableMetadata): Promise<void> {
    const unsupported = (reason: string): OrmError => err(CODE_UNSUPPORTED, reason);
    const partial = (await this.rawRows('SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)', [], 1, 4096)).rows;
    const [partialRow] = partial;
    if (partial.length !== 1 || partialRow === undefined || partialRow.length !== 1 || Number(partialRow[0]) !== 0) {
      throw unsupported('MySQL partial-revoke visibility requires verification');
    }

    const account = (await this.rawRows('SELECT CURRENT_USER()', [], 1, 4096)).rows;
    const [accountRow] = account;
    if (account.length !== 1 || accountRow === undefined || accountRow.length !== 1) throw unsupported('unverifiable MySQL account');
    const text = textOf(accountRow[0], 'MySQL account');
    const at = text.lastIndexOf('@');
    if (at < 0) throw unsupported('unverifiable MySQL account');
    const grantee = `'${text.slice(0, at)}'@'${text.slice(at + 1)}'`;

    const grants = (await this.rawRows(
      "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND PRIVILEGE_TYPE='TRIGGER' " +
        "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER' " +
        "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER'",
      [grantee, grantee, metadata.table.namespace, grantee, metadata.table.namespace, metadata.table.name],
      16,
      4096,
    )).rows;
    if (!grants.some(row => row.length === 1 && row[0] === 'TRIGGER')) throw unsupported('MySQL trigger visibility is unverified');

    const engine = (await this.rawRows('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
      [metadata.table.namespace, metadata.table.name], 2, 4096)).rows;
    const [engineRow] = engine;
    if (engine.length !== 1 || engineRow === undefined || engineRow.length !== 1 || typeof engineRow[0] !== 'string' || engineRow[0].toLowerCase() !== 'innodb') {
      throw unsupported('MySQL requires InnoDB');
    }

    const triggers = (await this.rawRows('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? LIMIT 1',
      [metadata.table.namespace, metadata.table.name], 1, 4096)).rows;
    if (triggers.length !== 0) throw unsupported('MySQL triggers require effect verification');
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

function byteSize(value: unknown): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value instanceof Uint8Array ? value.length : 8;
}

const BEGIN_SQL: Record<DriverName, { read: string; write: string }> = {
  mysql: { read: 'START TRANSACTION READ ONLY', write: 'START TRANSACTION' },
  postgres: { read: 'BEGIN READ ONLY', write: 'BEGIN' },
  sqlite: { read: 'BEGIN', write: 'BEGIN IMMEDIATE' },
};

/** A native catalog connection to a MySQL, PostgreSQL or SQLite database selected by its DSN. */
export class CatalogConnection {
  private closed = false;

  public constructor(public readonly dialect: DriverName, private readonly pool: DriverPool) {}

  /** Releases the connection pool. An operation after close fails with CATALOG_CLOSED and sends no statement. */
  public async close(): Promise<void> {
    this.closed = true;
    await this.pool.close();
  }

  /** Fails with CATALOG_CLOSED once close has run. */
  private ensureOpen(): void {
    if (this.closed) throw err(codes.CATALOG_CLOSED, 'the catalog connection is closed');
  }

  /** Opens a session in a read-only transaction, or a writable one. */
  private async begin(readOnly: boolean): Promise<Session> {
    this.ensureOpen();
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

  /**
   * Ends a session and returns the error to throw, joined with a failed rollback. A session that a read stopped early is discarded
   * without a rollback on MySQL and PostgreSQL, where the discard ends the server's transaction; SQLite's shared connection is rolled back.
   */
  private async endSession(session: Session, error: unknown): Promise<OrmError | undefined> {
    let failure: OrmError | undefined = error === undefined ? undefined : driverError(this.dialect, error);
    if (!session.stopped || this.dialect === 'sqlite') {
      try {
        await session.control('ROLLBACK');
      } catch (rollbackError) {
        const rolled = driverError(this.dialect, rollbackError);
        failure = failure === undefined
          ? err(CODE_ROLLBACK, `rollback: ${rolled.message}`, rolled)
          : err(CODE_ROLLBACK, `${failure.message}; rollback: ${rolled.message}`, failure);
      }
    }
    session.release(true);
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
      const raw = await session.collect<CatalogValue>(sql, [], limit + 1, PAGE_BYTES, (value, column, index) => describedCell(value, column, metadata.columns[index], this.dialect));
      if (raw.columns.length !== metadata.columns.length || raw.columns.some((column, index) => column.name !== metadata.columns[index]?.name)) {
        throw err(CODE_PAGE_CHANGED, 'prepared columns differ from descriptor');
      }
      const after = await session.describe(table);
      if (!sameDescriptor(after, metadata)) throw err(CODE_PAGE_CHANGED, 'descriptor changed during read');
      let rows = raw.rows;
      const hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);
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
      const { columns, rows } = await session.plainRows(query, params, maxRows, maxBytes);
      return { columns: columns.map(column => column.name), rows };
    });
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
    });
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

  /** Inserts one row with explicit primary-key values. It rejects an existing key, requires exactly one affected row and re-reads the row before it commits. */
  public async insertRow(declared: CatalogTableMetadata, values: readonly CatalogAssignment[]): Promise<CatalogMutationResult> {
    const keyIndexes = descriptorKeys(declared);
    const changes = checkChanges(declared, values, CODE_INSERT_INVALID);
    const provided = new Map(changes.map(change => [change.index, change.value] as const));
    const keys = keyIndexes.map(index => {
      if (!provided.has(index)) throw err(CODE_INSERT_INVALID, `explicit primary-key value of "${declared.columns[index]?.name ?? ''}" is required`);
      return provided.get(index) ?? null;
    });
    return this.write(async session => {
      if (this.dialect === 'postgres') {
        // The lock an INSERT takes, held before the schema check so that no DDL changes the table in between.
        await session.control(`LOCK TABLE ${qualified(declared.table, this.dialect)} IN ROW EXCLUSIVE MODE`);
      }
      const existing = await session.lookup(declared, keys, true);
      if (existing.length !== 0) throw err(CODE_CONFLICT, 'insertion key already exists');
      const descriptor = await session.describe(declared.table);
      if (!sameDescriptor(descriptor, declared)) throw err(CODE_SCHEMA, 'insertion descriptor changed');
      if (this.dialect === 'mysql') await session.mysqlSafety(descriptor);
      const names = changes.map(change => quoteIdent(descriptor.columns[change.index]?.name ?? '', this.dialect));
      const marks = changes.map((_, index) => placeholder(index + 1, this.dialect));
      const affected = await session.exec(
        `INSERT INTO ${qualified(descriptor.table, this.dialect)} (${names.join(',')}) VALUES (${marks.join(',')})`,
        changes.map(change => change.value),
      );
      if (affected !== 1) throw err(CODE_WRITE, `expected exactly one inserted row, got ${affected}`);
      const after = await session.lookup(descriptor, keys, false);
      if (after.length !== 1) throw err(CODE_WRITE, 'expected exactly one inserted row');
      const afterDescriptor = await session.describe(declared.table);
      if (!sameDescriptor(afterDescriptor, descriptor)) throw err(CODE_SCHEMA, 'insertion descriptor changed');
      const [stored] = after;
      if (stored === undefined) throw err(CODE_WRITE, 'expected exactly one inserted row');
      for (const change of changes) {
        if (!sameCell(stored[change.index], change.value)) {
          throw err(CODE_WRITE, `stored inserted values of "${descriptor.columns[change.index]?.name ?? ''}" differ`);
        }
      }
      return { columns: descriptor.columns.map(column => column.name), rows: after };
    });
  }

  /** Updates the row of an original snapshot. Inside the transaction it locks the row by its original keys, compares it with the snapshot and writes; then it re-reads the row and requires the written values. */
  public async updateRow(original: CatalogRowSnapshot, values: readonly CatalogAssignment[]): Promise<CatalogMutationResult> {
    original.valid();
    const changes = checkChanges(original.metadata, values, CODE_UPDATE_INVALID);
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
      const current = await session.lookup(original.metadata, keys, true);
      const descriptor = await session.describe(original.metadata.table);
      if (!sameDescriptor(descriptor, original.metadata)) throw err(CODE_SCHEMA, 'original descriptor changed');
      checkCurrent(current, original.originalCells());
      if (this.dialect === 'mysql') await session.mysqlSafety(descriptor);
      const sets = changes.map((change, index) => `${quoteIdent(descriptor.columns[change.index]?.name ?? '', this.dialect)}=${placeholder(index + 1, this.dialect)}`);
      const args: DriverValue[] = [...changes.map(change => change.value), ...keys.map(key => key ?? null)];
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
        if (!sameCell(stored[index], updated[index])) throw err(CODE_WRITE, `stored ordinary values of "${column.name}" differ`);
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
      if (!sameDescriptor(descriptor, original.metadata)) throw err(CODE_SCHEMA, 'original descriptor changed');
      checkCurrent(current, original.originalCells());
      if (this.dialect === 'mysql') await session.mysqlSafety(descriptor);
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
}

/** Compares the rows that a key read returned with the original cells of a snapshot. */
function checkCurrent(current: readonly CatalogValue[][], original: readonly CatalogValue[]): void {
  if (current.length === 0) throw err(CODE_CONFLICT, 'original row is missing');
  if (current.length > 1) throw err(CODE_AMBIGUOUS, 'key selected multiple rows');
  const [row] = current;
  if (row === undefined || !sameRow(row, original)) throw err(CODE_CONFLICT, 'original values changed');
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
