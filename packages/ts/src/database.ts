import { AsyncLocalStorage } from 'node:async_hooks';
import { bindSlotType, checkAssign, checkParam, transformParam } from './bind_check.js';
import { blindIndex, decode, hostDecode, hostEncode } from './codec.js';
import type { Assemble, BindSlot, Group, KeyReference, Plan, PlanStep, Request } from './ir.js';
import { driverValue, isolationSql, openDriver, parseDsn, sqliteBusy, zoneOffset, type DriverName, type DriverPool, type DriverResult, type DriverSession, type DriverValue, type Isolation, type PoolStats, type StatementDone } from './driver.js';
import { Subscribers, statementKind, type StatementEvent, type StatementKind } from './events.js';
import { present } from './present.js';
import { OrmError, joinedErrors, rollbackFailed } from './runtime_error.js';
import { Utils } from './utils.js';
import { wallMicros } from './clock.js';
import { AesKeyring } from './aes.js';
import { Engine } from './engine/index.js';
import { canonicalize } from './engine/canonical.js';
import { modelOfManifest, type RuntimeModel } from './engine/model.js';
import { decimalScaled, normalizeDecimal } from './decimal.js';
import { CORE, type Core } from './core.js';
import { Model } from './model.js';
import { fieldOf, type Entity } from './engine/model.js';
import { MarkdownPool, MarkdownSession, beginLine, endLine, markdownRead, markdownScalar, markdownWrite, savepointLine } from './markdown.js';
import * as codes from './codes.js';

export interface ConnectOptions {
  /** key of aesVersion for aes writes; absent takes aesKeys[aesVersion] */
  aesKey?: string;
  blindIndexKey?: string;
  aesVersion?: number;
  aesKeys?: ReadonlyMap<number, string>;
  planCacheSize?: number;
  statementCacheSize?: number;
  /** maximum open connections; zero uses 10 */
  poolSize?: number;
  /** maximum idle connections; zero keeps up to poolSize */
  poolIdleSize?: number;
  /** lifetime of a connection in milliseconds; zero keeps connections without a bound */
  poolLifetimeMs?: number;
  /** bound of every statement of the connection in milliseconds; zero keeps the server default */
  statementTimeoutMs?: number;
  /**
   * Returns the audit values of the current request, an object from column
   * name to value of the audit record table, such as the account and the
   * request id. A transaction with the audit option calls it once before it
   * begins; an error it throws fails the transaction. The ORM writes no audit
   * value of its own.
   */
  auditSource?: () => Record<string, unknown>;
}

export interface TransactionOptions {
  isolation?: Isolation;
  readOnly?: boolean;
  timeoutMs?: number;
  /** Deadlock retries; the default is 3 and 0 disables retry. */
  retry?: number;
  /**
   * Makes the transaction one unit of work with an audit record. Right before
   * the first write of an audited table, in every attempt, the transaction
   * inserts one row into the audit record table, the table that the audit settings of the sets
   * registered on the connection name with references: the values of the
   * auditSource connect option, called once for the transaction, with these
   * values, a value winning over the source's value of the same column.
   * Every insert, update, soft delete and restore of an audited table in the
   * transaction writes the record's primary key into the table's audit
   * column. A transaction that writes no audited row inserts no record: a
   * first update, delete or restore that matches no row undoes the record
   * with a savepoint, and a rolled back savepoint undoes the record with the
   * write that inserted it. A nested transaction uses the audit of the outer
   * one and does not take this option.
   */
  audit?: Readonly<Record<string, unknown>>;
}

/** The audit record a transaction inserted: the audit record table and the primary key of the row. */
interface AuditRecord {
  readonly table: string;
  readonly key: unknown;
}

/** The audit record a transaction inserts: the entity of the audit record table, its set and the column values. */
interface AuditInsert {
  readonly model: RuntimeModel;
  readonly entity: Entity;
  readonly values: Readonly<Record<string, unknown>>;
}

const models = new Map<string, RuntimeModel>();

/**
 * The generated schema value: the manifest text of a document set with its declared manifestHash, and the
 * text of the tables that the set uses from external documents, which a set without external documents leaves
 * out. manifestHash covers the manifest text followed by the external text.
 */
export interface Schema {
  readonly manifestText: string;
  readonly manifestHash: string;
  readonly externalText?: string;
}

/**
 * The runtime model of the schema to register. If the text does not hash to the declared hash, then
 * before any statement it is CONFIG, and if the text is not a manifest, it is SCHEMA_INVALID.
 */
export function schemaModel(schema: Schema): RuntimeModel {
  if (schema === null || typeof schema !== 'object' || typeof schema.manifestText !== 'string' || typeof schema.manifestHash !== 'string'
    || (schema.externalText !== undefined && typeof schema.externalText !== 'string')) {
    throw new OrmError(codes.CONFIG, 'a schema is the manifestText, manifestHash and optional externalText of generated code');
  }
  const externalText = schema.externalText ?? '';
  const loaded = models.get(schema.manifestHash);
  if (loaded !== undefined && loaded.manifestText === schema.manifestText && loaded.externalText === externalText) return loaded;
  try {
    return modelOfManifest(schema.manifestText, schema.manifestHash, externalText);
  } catch (error) {
    if (error instanceof OrmError && error.code === codes.SCHEMA_HASH_MISMATCH) {
      throw new OrmError(codes.CONFIG, `invalid schema manifest: the manifest text does not hash to its declared manifestHash ${schema.manifestHash}`, error);
    }
    throw error;
  }
}

// Registration is done only by this module's registerSet and Db.connectSchema. The package does not export this symbol.
const REGISTER = Symbol('register');

/** Registers the schema's set on the connection. Registering the same set again changes nothing. */
export function registerSet(db: Db, model: RuntimeModel): void {
  db.root()[REGISTER](model);
}

/**
 * Builds and registers the runtime model of a manifest text and the external
 * text of the tables the set uses from external documents; generated model
 * modules call it once when they are imported. Registering the same manifest
 * again returns the registered model. A text that does not hash to
 * manifestHash fails with SCHEMA_HASH_MISMATCH before any statement, also when
 * that hash is already registered, and registers nothing.
 */
export function registerModel(manifestText: string, manifestHash: string, externalText = ''): RuntimeModel {
  const registered = models.get(manifestHash);
  if (registered !== undefined && registered.manifestText === manifestText && registered.externalText === externalText) return registered;
  // A text whose hash is already registered is still checked against its own hash: a wrong text is SCHEMA_INVALID,
  // and a text that goes to a different hash is SCHEMA_HASH_MISMATCH.
  const model = modelOfManifest(manifestText, manifestHash, externalText);
  models.set(manifestHash, model);
  return model;
}

/**
 * The hook of a connection handle (Db.withRequestHook): it receives a request of the handle right
 * before planning and returns the request to plan. addParam appends a value to the parameters of
 * the request and returns its index; params holds the parameters that the request binds, read-only.
 */
export type RequestHook = (request: Request, addParam: (value: unknown) => number, params: readonly unknown[]) => Request;

/** The options of an outermost transaction. */
interface BeginOptions { isolation?: Isolation; readOnly?: boolean; timeoutMs: number; }

/**
 * Sends one statement and publishes its event. kind and tables belong to the event, and params are the binds.
 *
 * @internal
 */
export type Runner = (kind: StatementKind, tables: readonly string[], sql: string, params?: readonly DriverValue[]) => Promise<DriverResult>;

/** The table that a SQLite row lock statement points to. */
const ROW_LOCK_TABLES: readonly string[] = ['orm__row_lock'];
const ROW_LOCK_DDL = 'CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))';

/** One active transaction. */
export class TxFrame {
  public busy = false;
  public finished = false;
  public savepoints = 0;
  public readonly locals = new Map<string, string>();
  public readonly locks: string[] = [];
  /**
   * The audit record the unit of work inserted right before its first write of an audited table; audited writes of the
   * transaction write its key. Until that write, and in a transaction without audit values, it is undefined.
   */
  public audit: AuditRecord | undefined = undefined;
  /** The audit record the transaction inserts before its first write of an audited table; undefined without audit values. */
  public pendingAudit: AuditInsert | undefined = undefined;
  /**
   * The number is this transaction's number on the connection; the event of that statement carries it. The connection is held
   * until the transaction ends: it is the driver session of an SQL connection or the flowmark session of a markdown connection.
   */
  public constructor(public readonly db: Db, private readonly connection: DriverSession | MarkdownSession, public readonly number: number, public readonly options: BeginOptions) {}

  /** The driver session of a SQL transaction. A markdown transaction sends no statement and has none. */
  public get session(): DriverSession {
    if (this.connection instanceof MarkdownSession) throw new OrmError(codes.INTERNAL, 'a markdown transaction has no SQL session');
    return this.connection;
  }

  /** The flowmark session of a markdown transaction. It is undefined in an SQL transaction, where the session itself is the place. */
  public get md(): MarkdownSession | undefined {
    return this.connection instanceof MarkdownSession ? this.connection : undefined;
  }

  /**
   * On a transaction connection, sends a transaction control statement and publishes its event. A test statement
   * fault is not consumed.
   */
  public run(kind: StatementKind, tables: readonly string[], sql: string, params: readonly DriverValue[] = []): Promise<DriverResult> {
    return this.session.control(sql, params, this.db.statementDone(kind, tables, this.number, params));
  }

  /**
   * On a transaction connection, sends a query or schema statement. If an armed statement fault exists, it is not sent and
   * is rejected with that error.
   *
   * @internal
   */
  public async statement(kind: StatementKind, tables: readonly string[], sql: string, params: readonly DriverValue[] = []): Promise<DriverResult> {
    const done = this.db.statementDone(kind, tables, this.number, params);
    this.db.checkStatementFault(sql, done);
    return this.session.control(sql, params, done);
  }
}

const flow = new AsyncLocalStorage<readonly TxFrame[]>();

function frames(): readonly TxFrame[] { return flow.getStore() ?? []; }

export function activeFor(db: Db): TxFrame | undefined {
  const stack = frames();
  // A signal handle is the same connection, so frames are matched by connection.
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame !== undefined && frame.db.root() === db.root() && !frame.finished) return frame;
  }
  return undefined;
}

/** Where a statement runs: a connection or an active transaction. */
export interface Executor { readonly db: Db; readonly frame: TxFrame | undefined; }

/** Selects the active transaction of the connection, the connection, or the innermost transaction. */
export function resolve(conn: Db | undefined): Executor {
  if (conn !== undefined) {
    const frame = activeFor(conn);
    if (frame) return { db: conn, frame };
    if (conn.closed) throw new OrmError(codes.CONFIG, 'database is closed');
    return { db: conn, frame: undefined };
  }
  const stack = frames();
  const frame = stack[stack.length - 1];
  if (frame && !frame.finished) return { db: frame.db, frame };
  throw new OrmError(codes.CONFIG, 'the model has no connection; use connect or run it inside a transaction');
}

const SECRET = '$SECRET';
const NOW = '$NOW';

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** Formats an instant in a connection time zone as date-time text with six fraction digits. */
function formatInstant(instant: Date, zone: string): string {
  const shifted = new Date(instant.getTime() + zoneOffset(zone) * 60_000);
  const micro = String(shifted.getUTCMilliseconds()).padStart(3, '0') + '000';
  const year = shifted.getUTCFullYear();
  return `${year < 0 ? `-${String(-year).padStart(4, '0')}` : String(year).padStart(4, '0')}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}.${micro}`;
}

const dateText = /^(\d{4})-(\d{2})-(\d{2})$/;
const timeText = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const dateTimeText = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function validDate(y: string, m: string, d: string, h = '00', mi = '00', sec = '00'): boolean {
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(sec)));
  t.setUTCFullYear(Number(y));
  return t.getUTCFullYear() === Number(y) && t.getUTCMonth() + 1 === Number(m) && t.getUTCDate() === Number(d)
    && t.getUTCHours() === Number(h) && t.getUTCMinutes() === Number(mi) && t.getUTCSeconds() === Number(sec);
}

/** The fraction digits of a value cut to p digits; undefined when a cut digit is not zero. */
function fraction(digits: string | undefined, precision: number): string | undefined {
  const all = (digits ?? '').padEnd(precision, '0');
  if (/[1-9]/.test(all.slice(precision))) return undefined;
  return precision === 0 ? '' : `.${all.slice(0, precision)}`;
}

/**
 * Reads a date, time or datetime text in its value form (docs/dbspec.md
 * "Runtime model"): `YYYY-MM-DD`, `HH:MM:SS` and `YYYY-MM-DD HH:MM:SS` with
 * p fraction digits. A datetime with an offset is converted to the connection
 * time zone. Returns undefined for any other value.
 */
function timeForm(value: unknown, colType: string, zone: string, precision: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (colType === 'date') {
    const [, year, month, day] = dateText.exec(value) ?? [];
    return year !== undefined && month !== undefined && day !== undefined && validDate(year, month, day) ? value : undefined;
  }
  if (colType === 'time') {
    const m = timeText.exec(value);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59) return undefined;
    const f = fraction(m[4], precision);
    return f === undefined ? undefined : `${m[1]}:${m[2]}:${m[3]}${f}`;
  }
  const m = dateTimeText.exec(value);
  if (!m) return undefined;
  const [, year, month, day, hour, minute, second] = m;
  if (year === undefined || month === undefined || day === undefined || !validDate(year, month, day, hour, minute, second)) return undefined;
  const f = fraction(m[7], precision);
  if (f === undefined) return undefined;
  if (m[8] === undefined) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}${f}`;
  const digits = m[8].slice(1).replace(':', '');
  const offset = m[8] === 'Z' ? 0 : (m[8].startsWith('-') ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0'));
  // Date.UTC reads a year below 100 as 1900 plus the year, so the year is set after.
  const wall = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
  wall.setUTCFullYear(Number(m[1]));
  const instant = new Date(wall.getTime() - offset * 60_000);
  return `${formatInstant(instant, zone).slice(0, 19)}${f}`;
}

function timeShape(colType: string, precision: number): string {
  const f = precision > 0 ? `.${'f'.repeat(precision)}` : '';
  if (colType === 'date') return 'YYYY-MM-DD';
  if (colType === 'time') return `HH:MM:SS${f}`;
  return `YYYY-MM-DD HH:MM:SS${f}[Z|±HH:MM]`;
}

/** Writes a date, time or datetime bind in its stored text form; any other value is CODEC_ENCODE. */
export function timeValue(value: unknown, colType: string, zone: string, precision: number): string {
  const text = timeForm(value, colType, zone, precision);
  if (text === undefined) throw new OrmError(codes.CODEC_ENCODE, `${colType} value ${JSON.stringify(value)} is not ${timeShape(colType, precision)}`);
  return text;
}

/** Reads a stored date, time or datetime cell in its value form; any other cell is CODEC_DECODE. */
export function readTime(value: unknown, colType: string, zone: string, precision: number): string {
  const text = timeForm(value, colType, zone, precision);
  if (text === undefined) throw new OrmError(codes.CODEC_DECODE, `${colType} cell ${JSON.stringify(value)} is not ${timeShape(colType, precision)}`);
  return text;
}

interface Cached { plan: Plan; id: string; }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function planId(key: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(key)) h = BigInt.asUintN(64, (h ^ BigInt(byte)) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

/** The positional result of a select plan. */
export interface Result {
  plan: Plan;
  main: unknown[][];
  steps: Map<number, { step: PlanStep; data: unknown[][]; byKey: Map<string, number[]> }>;
  params: readonly unknown[];
  /** Marks the result of a markdown answer: the last cell of each row is that row's join and relation rows (MarkdownLinks). */
  markdown: boolean;
}

export function scalarKey(value: unknown): string {
  if (value === null || value === undefined) return '\u0000';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Uint8Array) return Buffer.from(value).toString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? typeof value;
}

export function rowKey(row: readonly unknown[], refs: readonly KeyReference[]): string | undefined {
  const values: unknown[] = [];
  for (const ref of refs) {
    const value = row[ref.index];
    if (value === null || value === undefined) return undefined;
    values.push(value);
  }
  return keyOfValues(values);
}

/** A collection key: an integer, a string, a boolean, bytes or a date; keys of different types never share an identity. */
export type Key = number | bigint | string | boolean | Uint8Array | Date;

export function keyOfValues(values: readonly unknown[]): string {
  if (values.length === 1) return keyText(values[0]);
  return values.map(v => { const part = scalarKey(v); return `${part.length}:${part}`; }).join('');
}

/** The identity of a collection key; SQL NULL has none and is CODEC_DECODE. */
export function keyText(value: unknown): string {
  if (value === null || value === undefined) throw new OrmError(codes.CODEC_DECODE, 'collection row identity contains SQL NULL');
  if (typeof value === 'number' || typeof value === 'bigint') return `n:${value}`;
  if (typeof value === 'boolean') return value ? 'b:1' : 'b:0';
  if (value instanceof Uint8Array) return `x:${Buffer.from(value).toString('hex')}`;
  if (value instanceof Date) return `d:${value.toISOString()}`;
  return `s:${scalarKey(value)}`;
}

/** The collection key of a value, kept in its type; SQL NULL is CODEC_DECODE. */
export function keyValue(value: unknown): Key {
  if (value === null || value === undefined) throw new OrmError(codes.CODEC_DECODE, 'collection row identity contains SQL NULL');
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return value;
  if (value instanceof Uint8Array || value instanceof Date) return value;
  return scalarKey(value);
}

/**
 * Sets the rollback fault of a connection. Only the test entry point `src/testing.ts`
 * calls it, and the package entry point does not export it.
 */
export function armRollbackFault(db: Db): void {
  db['shared'].rollbackFault = true;
}

/**
 * Arms the statement fault of the connection: the next query, model or schema
 * statement is refused with an OrmError of code and message, and a replaced
 * fault is dropped. Only the test entry point `src/testing.ts` calls it.
 */
export function armStatementFault(db: Db, code: string, message: string): void {
  db['shared'].statementFault = { code, message };
}

/** Fixes the executor clock of db's connection at micros, the microseconds since the epoch in UTC. */
export function armFixedClock(db: Db, micros: number): void {
  db['shared'].fixedClock = micros;
}

/** The affected count of the last successful write on db's connection, or null before one. Only the test entry point `src/testing.ts` calls it. */
export function readLastAffected(db: Db): number | null {
  return db['shared'].lastAffected;
}

/** Transaction control statement kinds, which the statement fault does not refuse. */
const CONTROL_KINDS: ReadonlySet<StatementKind> = new Set<StatementKind>(['begin', 'commit', 'rollback', 'savepoint', 'release', 'rollback_to']);

/** A database connection with its plan cache and statement cache. */
export class Db {
  // State shared by all handles of one connection. rollbackFault is the test fault that the test entry
  // point's failNextRollback sets.
  // events holds the subscriber list and the transaction number; rowLockTable says whether the SQLite row lock table was created on this
  // connection.
  private readonly shared: { closed: boolean; rollbackFault: boolean; statementFault: { code: string; message: string } | null; fixedClock: number | null; lastAffected: number | null; events: Subscribers; rowLockTable: boolean } = { closed: false, rollbackFault: false, statementFault: null, fixedClock: null, lastAffected: null, events: new Subscribers(), rowLockTable: false };
  public readonly signal: AbortSignal | undefined = undefined;
  /** The hook of the handle (withRequestHook); a connection has none. */
  public readonly requestHook: RequestHook | undefined = undefined;
  /** The audit values of the current request; the connection and its handles share it. */
  private readonly auditSource: (() => Record<string, unknown>) | undefined;
  private readonly plans = new Map<string, Cached>();
  private readonly engines = new Map<string, Engine>();
  // A markdown connection is not planned (docs/protocol.md §5), so it keeps only the models of the registered set, with no dialect engine.
  private readonly markdownModels = new Map<string, RuntimeModel>();
  public readonly aesKey: string;
  public readonly blindIndexKey: string;
  public readonly aesVersion: number;
  public readonly aesKeyring: AesKeyring | undefined;
  private readonly planCacheSize: number;

  /**
   * connection is the pool of the connection: the driver pool of a SQL database or the flowmark session pool of a markdown:// connection.
   */
  private constructor(private readonly connection: DriverPool | MarkdownPool, public readonly zone: string, options: ConnectOptions) {
    this.blindIndexKey = options.blindIndexKey ?? '';
    this.aesVersion = options.aesVersion ?? 1;
    if (!Number.isSafeInteger(this.aesVersion) || this.aesVersion < 1) throw new OrmError(codes.CONFIG, 'aes version must be a positive integer');
    // aesKey is the key of aesVersion: writes encrypt with it, and aesKeys holds it at aesVersion.
    const given = options.aesKey ?? '';
    const listed = options.aesKeys?.get(this.aesVersion) ?? '';
    if (given !== '' && options.aesKeys !== undefined && listed !== given) throw new OrmError(codes.CONFIG, `aesKey differs from aesKeys[${this.aesVersion}]`);
    this.aesKey = given !== '' ? given : listed;
    const keys = options.aesKeys ?? (this.aesKey === '' ? undefined : new Map([[this.aesVersion, this.aesKey]]));
    this.aesKeyring = keys === undefined ? undefined : new AesKeyring(keys, this.aesVersion);
    if (options.auditSource !== undefined && typeof options.auditSource !== 'function') throw new OrmError(codes.CONFIG, 'auditSource is a function that returns the audit values');
    this.auditSource = options.auditSource;
    this.planCacheSize = options.planCacheSize ?? 256;
    if (!Number.isSafeInteger(this.planCacheSize) || this.planCacheSize < 1) throw new OrmError(codes.CONFIG, 'plan cache size must be a positive integer');
  }

  /**
   * Opens the database selected by the DSN URI scheme. The connection has no
   * set registered: a model request on it fails with SCHEMA_HASH_MISMATCH
   * until install registers the set of the model.
   */
  public static async connect(dsn: string, options: ConnectOptions = {}): Promise<Db> {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new OrmError(codes.CONFIG, 'connect takes the DSN and an options object');
    const parsed = parseDsn(dsn);
    if (parsed.driver === 'markdown' && (options.statementTimeoutMs ?? 0) > 0) {
      throw new OrmError(codes.CAPABILITY_UNSUPPORTED, 'statement timeout is not supported by the markdown IR executor');
    }
    const statementCacheSize = options.statementCacheSize ?? 256;
    if (!Number.isSafeInteger(statementCacheSize) || statementCacheSize < 1) throw new OrmError(codes.CONFIG, 'statement cache size must be a positive integer');
    if ((options.poolSize ?? 0) < 0) throw new OrmError(codes.CONFIG, 'pool size must not be negative');
    if ((options.statementTimeoutMs ?? 0) < 0) throw new OrmError(codes.CONFIG, 'statement timeout must not be negative');
    // Zero or unset takes the default of every client, 10 connections.
    const size = options.poolSize || 10;
    const idleSize = options.poolIdleSize ?? 0;
    if (idleSize < 0 || idleSize > size) throw new OrmError(codes.CONFIG, `pool idle size must be between 0 and the pool size ${size}`);
    if ((options.poolLifetimeMs ?? 0) < 0) throw new OrmError(codes.CONFIG, 'pool lifetime must not be negative');
    const bounds = { size, idleSize: idleSize || size, lifetimeMs: options.poolLifetimeMs ?? 0 };
    if (parsed.driver === 'markdown') {
      // Opens one session to check that the server accepts the corpus and token, and keeps it in the pool.
      const md = new MarkdownPool(parsed.markdown, bounds);
      const db = new Db(md, parsed.zone, options);
      md.release(await md.acquire(undefined));
      return db;
    }
    const pool = openDriver(dsn, parsed, bounds, statementCacheSize, options.statementTimeoutMs ?? 0);
    const db = new Db(pool, parsed.zone, options);
    // Opens one connection and returns it to the pool. It does not send a statement to check the connection.
    try { (await pool.reserve()).release(false); } catch (error) { await pool.close(); throw error; }
    return db;
  }

  /**
   * Opens the database that the DSN URI scheme selects, and registers the set of the generated schema with the connection the way utils().schema().register does.
   * connection. The generated model's connect helper calls it. If the manifest text does not hash to the declared hash
   * it is a CONFIG error before the connection is opened. Registration does not read the database: the database is checked by install and
   * addTablesAndColumns.
   */
  public static async connectSchema(dsn: string, schema: Schema, options: ConnectOptions = {}): Promise<Db> {
    const model = schemaModel(schema);
    const db = await Db.connect(dsn, options);
    db[REGISTER](model);
    return db;
  }

  public [REGISTER](model: RuntimeModel): void {
    // A markdown connection is not planned (docs/protocol.md §5), so it registers only the set, with no dialect engine.
    if (this.md !== undefined) {
      if (!this.markdownModels.has(model.manifestHash)) this.markdownModels.set(model.manifestHash, model);
      return;
    }
    if (!this.engines.has(model.manifestHash)) this.engines.set(model.manifestHash, new Engine(model, this.pool.name));
  }

  /**
   * The runtime model of the set registered on this connection. A manifest that is not registered is SCHEMA_HASH_MISMATCH, as with a SQL connection.
   *
   * @internal
   */
  public markdownModel(manifestHash: string): RuntimeModel {
    if (this.closed) throw new OrmError(codes.CONFIG, 'database is closed');
    const model = this.markdownModels.get(manifestHash);
    if (model === undefined) {
      throw new OrmError(codes.SCHEMA_HASH_MISMATCH, `manifest ${manifestHash} is not registered on this connection: connect through its generated models or register it`);
    }
    return model;
  }

  /** The database of the connection: mysql, postgres, sqlite, or markdown, a corpus that a flowmark server serves. */
  public get driver(): DriverName | 'markdown' { return this.md !== undefined ? 'markdown' : this.pool.name; }

  /**
   * The driver pool of a SQL connection. A markdown connection sends no statement and has none; every SQL path
   * refuses a markdown connection before it.
   *
   * @internal
   */
  public get pool(): DriverPool {
    if (this.connection instanceof MarkdownPool) throw new OrmError(codes.INTERNAL, 'a markdown connection has no SQL pool');
    return this.connection;
  }

  /**
   * flowmark session pool of a markdown:// connection. It is undefined for a SQL connection, where the pool takes its place.
   *
   * @internal
   */
  public get md(): MarkdownPool | undefined {
    return this.connection instanceof MarkdownPool ? this.connection : undefined;
  }

  /**
   * Throws CAPABILITY_UNSUPPORTED, which a SQL-only surface receives on a markdown connection (docs/dialects.md "Markdown IR
   * executor"). On other connections it does nothing.
   *
   * @internal
   */
  public unsupportedOnMarkdown(surface: string): void {
    if (this.md !== undefined) throw new OrmError(codes.CAPABILITY_UNSUPPORTED, `${surface} is not supported by the markdown IR executor`);
  }

  public get closed(): boolean { return this.shared.closed; }

  /**
   * Returns a handle on the same connection whose statements are bound to
   * signal: aborting it cancels the statement in flight and raises CANCELED.
   * Models connect to the handle as they connect to the connection, and
   * transactions started on it are bound to the same signal. Closing either
   * handle closes the connection.
   */
  public withSignal(signal: AbortSignal): Db {
    return this.derive('signal', signal);
  }

  /**
   * Returns a handle on the same connection whose hook receives each request of the handle right
   * before it is planned (docs/usage.md "Request hook"). The hook returns the request to plan and adds
   * a parameter with addParam, which returns its index; the client then plans the request as any
   * other, so the planner validates what the hook changed. The handle keeps the signal of this
   * handle, and transactions started on it keep the hook for the models of their callback.
   */
  public withRequestHook(hook: RequestHook): Db {
    if (typeof hook !== 'function') throw new OrmError(codes.CONFIG, 'withRequestHook takes a function of the request and addParam');
    return this.derive('requestHook', hook);
  }

  /** A handle of the same connection: it shares the state and changes only one property to value. */
  private derive(property: 'signal' | 'requestHook', value: unknown): Db {
    const handle: unknown = Object.create(Db.prototype);
    if (!(handle instanceof Db)) throw new OrmError(codes.INTERNAL, 'a derived handle is no Db');
    Object.assign(handle, this);
    Object.defineProperty(handle, property, { value, enumerable: true, writable: false });
    Object.defineProperty(handle, 'rootDb', { value: this.root(), enumerable: false, writable: false });
    return handle;
  }

  /** The connection this handle was derived from; a connection returns itself. */
  public root(): Db {
    const root: unknown = Reflect.get(this, 'rootDb');
    return root instanceof Db ? root : this;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.shared.closed = true;
    this.plans.clear();
    const md = this.md;
    if (md !== undefined) md.close();
    else await this.pool.close();
  }

  public utils(): Utils { return new Utils(this); }

  /**
   * Registers subscriber for the event of every statement that the connection
   * and every handle derived from it send (docs/usage.md "Statement events").
   * Subscribers run synchronously in registration order after the statement
   * ends and before the operation continues; one that throws fails the
   * operation with SUBSCRIBER. The returned function removes the subscription. A markdown connection sends no
   * statement, so it refuses a subscriber with CAPABILITY_UNSUPPORTED.
   */
  public subscribe(subscriber: (event: StatementEvent) => void): () => void {
    this.unsupportedOnMarkdown('statement events');
    return this.shared.events.subscribe(subscriber);
  }

  /**
   * The done that publishes the event of one statement.
   *
   * @internal
   */
  public statementDone(kind: StatementKind, tables: readonly string[], transaction: number | null, binds: readonly unknown[]): StatementDone {
    return this.shared.events.done(kind, tables, transaction, binds);
  }

  /**
   * The number of a new outer transaction.
   *
   * @internal
   */
  public nextTransaction(): number { return this.shared.events.nextTransaction(); }

  /**
   * The runner that sends a statement not prepared in the session. The transaction is the statement's transaction
   * number, and null if it is outside one.
   *
   * @internal
   */
  public runner(session: DriverSession, transaction: number | null): Runner {
    return async (kind, tables, sql, params = []) => {
      const done = this.statementDone(kind, tables, transaction, params);
      if (!CONTROL_KINDS.has(kind)) this.checkStatementFault(sql, done);
      return session.control(sql, params, done);
    };
  }

  /**
   * Refuses the statement with the armed statement fault: it publishes the statement event with the
   * error at the statement end, clears the fault and throws the error. Without a fault it returns.
   *
   * @internal
   */
  public checkStatementFault(sql: string, done: StatementDone): void {
    const fault = this.shared.statementFault;
    if (fault === null) return;
    this.shared.statementFault = null;
    const error = new OrmError(fault.code, fault.message);
    done(sql, 0, error, 'statement');
    throw error;
  }

  /**
   * Takes one connection, runs fn outside a transaction, and returns its result.
   *
   * @internal
   */
  public async withSession<T>(fn: (session: DriverSession) => Promise<T>): Promise<T> {
    const session = await this.pool.reserve();
    try { return await fn(session); } finally { session.release(false); }
  }

  public stats(): PoolStats { return (this.md ?? this.pool).stats(); }

  /**
   * Runs callback in one transaction. An exception rolls back; otherwise the
   * transaction commits and the callback result is returned. Models without
   * connect inside the callback use this transaction. A transaction of the
   * same connection inside an active one creates a savepoint.
   */
  public async transaction<T>(callback: () => Promise<T> | T, options: TransactionOptions = {}): Promise<T> {
    const retry = options.retry ?? 3;
    if (!Number.isSafeInteger(retry) || retry < 0) throw new OrmError(codes.CONFIG, 'transaction retry must be a non-negative integer');
    const timeoutMs = options.timeoutMs ?? 0;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new OrmError(codes.CONFIG, 'transaction timeoutMs must not be negative');
    const outer = activeFor(this);
    if (options.audit !== undefined) this.unsupportedOnMarkdown('a transaction with audit values');
    // The audit record is checked before the transaction starts, and is inserted right before the first write of an audited table on each attempt.
    const record = options.audit !== undefined && outer === undefined ? this.auditRecord(options.audit) : undefined;
    if (outer) {
      if (options.isolation !== undefined || options.readOnly !== undefined || options.timeoutMs !== undefined || options.audit !== undefined) {
        throw new OrmError(codes.CONFIG, 'a nested transaction of the same connection accepts only the retry option');
      }
      return this.savepoint(outer, callback);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const begin: BeginOptions = { timeoutMs };
        if (options.isolation !== undefined) begin.isolation = options.isolation;
        if (options.readOnly !== undefined) begin.readOnly = options.readOnly;
        return await this.run(callback, begin, record);
      } catch (error) {
        if (!(error instanceof OrmError) || error.code !== codes.DEADLOCK || attempt >= retry) throw error;
        await new Promise(resolve => setTimeout(resolve, (50 << attempt) + Math.floor(Math.random() * 20)));
      }
    }
  }

  /**
   * An audit record that adds the transaction's values to the audit source's values. For the same column, the transaction's value wins. The record
   * table is the one table that the audit setting of a set registered on the connection names by references, and the set that has that table as its entity
   * must be registered on this connection. It is a CONFIG error if there is no audit source, if the record table is missing or more than one, or if a key of the values is not in that table's
   * column, if there are no values, or if the primary key is not one column; the error the source throws is
   * passed through unchanged.
   */
  private auditRecord(values: Readonly<Record<string, unknown>>): AuditInsert {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new OrmError(codes.CONFIG, 'transaction audit is an object of column values');
    if (this.auditSource === undefined) {
      throw new OrmError(codes.CONFIG, 'the transaction has audit values but the connection has no audit source: set the auditSource connect option');
    }
    const engines = [...this.engines.values()];
    const tables = [...new Set(engines.flatMap(e => [...e.model.entities.values()].map(x => x.auditRecord).filter(t => t !== '')))].sort();
    if (tables.length === 0) throw new OrmError(codes.CONFIG, 'the transaction has audit values but no set of the connection has an audited table');
    if (tables.length > 1) throw new OrmError(codes.CONFIG, `the audited tables of the connection record their audits in ${tables.join(', ')}; one audit record table is required`);
    const table = present(tables[0], 'the audited table');
    let target: { model: RuntimeModel; entity: Entity } | undefined;
    for (const engine of engines) {
      for (const entity of engine.model.entities.values()) if (entity.table === table && !entity.external) target = { model: engine.model, entity };
    }
    if (target === undefined) throw new OrmError(codes.CONFIG, `the audit record table ${table} is not a table of a set registered on the connection`);
    if (target.entity.primaryKey.length !== 1) throw new OrmError(codes.CONFIG, `the audit record table ${table} needs a primary key of one column`);
    const source = this.auditSource();
    const merged: Record<string, unknown> = {};
    for (const set of [source, values]) {
      if (set === null || typeof set !== 'object' || Array.isArray(set)) throw new OrmError(codes.CONFIG, 'the audit source returns an object of column values');
      for (const column of Object.keys(set).sort()) {
        if (fieldOf(target.entity, column) === undefined) throw new OrmError(codes.CONFIG, `audit value ${column} is not a column of ${table}`);
        merged[column] = set[column];
      }
    }
    if (Object.keys(merged).length === 0) throw new OrmError(codes.CONFIG, `the audit record of ${table} has no value: the audit source and the transaction give none`);
    return { ...target, values: merged };
  }

  /**
   * Inserts the transaction's audit record and returns that table and the primary key value. If the primary key is an identity, the generated
   * key; otherwise it is the value of the record. It is inserted again on each attempt.
   */
  /**
   * Makes sure the audit record precedes a write of an audited table: when the transaction of ex has a pending record and has not
   * inserted it, it inserts it now. guard is true for an update, delete or restore, which can match no row: the record is then
   * inserted inside the savepoint orm_audit, and the returned function, called with the affected count and the write's error,
   * releases the savepoint when the write changed a row and otherwise rolls the record back. It must be called outside guarded.
   *
   * @internal
   */
  public async auditFor(ex: Executor, step: PlanStep, guard: boolean): Promise<(affected: number, failed: boolean, error?: unknown) => Promise<void>> {
    const none = async (): Promise<void> => {};
    const frame = ex.frame;
    if (frame === undefined || frame.audit !== undefined || frame.pendingAudit === undefined || !bindsAudit(step)) return none;
    const record = frame.pendingAudit;
    if (!guard) {
      frame.audit = await this.insertAudit(record);
      return none;
    }
    const name = 'orm_audit';
    // Undoes the work after the savepoint and releases it; failed is whether the write failed with error.
    const rollback = async (failed: boolean, error: unknown): Promise<void> => {
      const errors: unknown[] = [];
      for (const kind of ['rollback_to', 'release'] as const) {
        try { await this.savepointStep(frame, kind, name); } catch (failure) { errors.push(failure); }
      }
      if (!failed) {
        if (errors.length > 0) throw joinedErrors(errors);
        return;
      }
      if (errors.length > 0) throw rollbackFailed(error, joinedErrors(errors));
      throw error;
    };
    await this.savepointStep(frame, 'savepoint', name);
    try {
      frame.audit = await this.insertAudit(record);
    } catch (error) {
      frame.audit = undefined;
      await rollback(true, error);
      throw error;
    }
    return async (affected: number, failed: boolean, error?: unknown): Promise<void> => {
      if (!failed && affected > 0) {
        await this.savepointStep(frame, 'release', name);
        return;
      }
      frame.audit = undefined;
      await rollback(failed, error);
    };
  }

  private async insertAudit(record: AuditInsert): Promise<AuditRecord> {
    const { model, entity } = record;
    const cls = class extends Model {};
    Object.assign(cls, { entity: { model, entity, create: (core: Core) => new cls(core) } });
    const row = new cls();
    for (const column of Object.keys(record.values).sort()) row[CORE].setValue(column, record.values[column]);
    const created = (await row.create())[CORE];
    const key = created.values.get(present(entity.primaryKey[0], `the primary key of ${entity.table}`));
    if (key === undefined || key === null) throw new OrmError(codes.CONFIG, `the audit record ${entity.table} has no ${entity.primaryKey[0]} after its insert`);
    return { table: entity.table, key };
  }

  private async run<T>(callback: () => Promise<T> | T, options: BeginOptions, record: AuditInsert | undefined): Promise<T> {
    if (this.closed) throw new OrmError(codes.CONFIG, 'database is closed');
    const frame = await this.begin(options);
    let result: T;
    try {
      result = await flow.run([...frames(), frame], async () => {
        frame.pendingAudit = record;
        return callback();
      });
    } catch (error) {
      try {
        await this.finish(frame, false);
      } catch (cleanup) {
        throw rollbackFailed(error, cleanup);
      }
      if (this.shared.rollbackFault) {
        this.shared.rollbackFault = false;
        throw rollbackFailed(error, new OrmError(codes.FAULT, 'test fault: the rollback of the transaction ran and is reported as failed'));
      }
      throw error;
    }
    await this.finish(frame, true);
    return result;
  }

  /**
   * Creates the SQLite row lock table outside a transaction, once, before the connection's first transaction (docs/usage.md
   * "Statement events").
   */
  private async rowLockTable(): Promise<void> {
    if (this.shared.rowLockTable) return;
    await this.pool.execute(ROW_LOCK_DDL, [], undefined, this.statementDone('utility', ROW_LOCK_TABLES, null, []));
    this.shared.rowLockTable = true;
  }

  /**
   * Takes one connection and opens the outer transaction. The transaction takes the connection's next number. Opening the transaction
   * statement is docs/usage.md "Statement events". If it fails before BEGIN, the connection is closed so that settings left in the session
   * do not reach the next user; if it fails after BEGIN, the transaction is rolled back.
   */
  private async begin(options: BeginOptions): Promise<TxFrame> {
    if (options.timeoutMs > 0 && this.driver !== 'postgres') throw new OrmError(codes.CAPABILITY_UNSUPPORTED, 'transaction timeoutMs is supported only by postgres');
    if (this.md !== undefined) return this.beginMarkdown(this.md, options);
    const driver = this.pool.name;
    const level = options.isolation === undefined ? '' : isolationSql(options.isolation);
    if (driver === 'sqlite') await this.rowLockTable();
    const session = await this.pool.reserve();
    const frame = new TxFrame(this, session, this.nextTransaction(), options);
    const steps: Array<[StatementKind, string]> = [];
    switch (driver) {
      case 'mysql':
        if (level !== '') steps.push(['utility', `SET TRANSACTION ISOLATION LEVEL ${level}`]);
        steps.push(['begin', options.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION']);
        break;
      case 'postgres':
        steps.push(['begin', `BEGIN${level !== '' ? ` ISOLATION LEVEL ${level}` : ''}${options.readOnly ? ' READ ONLY' : ''}`]);
        if (options.timeoutMs > 0) steps.push(['utility', `SET LOCAL statement_timeout = ${Math.floor(options.timeoutMs)}`]);
        break;
      default:
        // A read-only transaction is a deferred BEGIN; the others take the write lock when they start and wait up to busy_timeout.
        steps.push(['begin', options.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE']);
        if (options.isolation === 'read_uncommitted') steps.push(['utility', 'PRAGMA read_uncommitted = 1']);
        if (options.readOnly) steps.push(['utility', 'PRAGMA query_only = 1']);
    }
    let began = false;
    for (const [kind, sql] of steps) {
      try {
        await frame.run(kind, [], sql);
      } catch (error) {
        // A statement whose subscriber failed still had its effect.
        if (kind === 'begin' && subscriberError(error)) began = true;
        if (!began) {
          frame.finished = true;
          session.release(true);
          throw error;
        }
        try { await this.finish(frame, false); } catch (rollback) { throw rollbackFailed(error, rollback); }
        throw error;
      }
      if (kind === 'begin') began = true;
    }
    return frame;
  }

  /**
   * Ends the transaction. Before ending it, restores the SQLite mode, releases the MySQL named lock, and clears the MySQL local values
   * in key order. This state remains on the connection after COMMIT and ROLLBACK, so every step is tried and
   * all failures are reported. A commit whose cleanup failed is rolled back and throws the cleanup error. When the signal is cancelled,
   * the transaction closes the session instead of ROLLBACK, so the server ends the transaction and its state together. For SQLite,
   * the only connection cannot be closed, so it is rolled back. A session whose cleanup, COMMIT, or ROLLBACK failed has an unknown state,
   * so it is closed rather than returned to the pool.
   */
  private async finish(frame: TxFrame, commit: boolean): Promise<void> {
    if (frame.finished) return;
    if (frame.md !== undefined) return this.endMarkdown(frame, frame.md, commit ? 'commit' : 'rollback');
    frame.finished = true;
    const session = frame.session;
    if (!commit && this.driver !== 'sqlite' && frame.db.signal?.aborted === true) {
      session.release(true);
      return;
    }
    // discard closes a session whose state is unknown instead of returning it to the pool.
    let discard = false;
    try {
      const errors: unknown[] = [];
      // The cleanup statement that restores settings and releases locks does not consume the test fault (protocol 3.2).
      const attempt = async (sql: string, params: readonly DriverValue[] = []): Promise<DriverResult | undefined> => {
        try {
          return await frame.run('utility', [], sql, params);
        } catch (error) { errors.push(error); return undefined; }
      };
      if (this.driver === 'sqlite') {
        if (frame.options.readOnly) await attempt('PRAGMA query_only = 0');
        if (frame.options.isolation === 'read_uncommitted') await attempt('PRAGMA read_uncommitted = 0');
      }
      for (const key of frame.locks.splice(0)) {
        const released = await attempt('SELECT RELEASE_LOCK(?)', [key]);
        // If it is not 1, this connection did not hold the lock.
        if (released !== undefined && Number(released.rows[0]?.[0]) !== 1) errors.push(new OrmError(codes.CONFIG, `lock ${key} was not held at transaction end`));
      }
      if (this.driver === 'mysql') {
        // Statements that clear values are sent in key order.
        for (const key of [...frame.locals.keys()].sort()) await attempt(`SET @\`orm.${key}\` = NULL`);
      }
      const failure = joinedErrors(errors);
      // A session returned to the pool is either clean or discarded. If a cleanup statement failed (except when only the subscriber failed,
      // since the statement had an effect), the state of the session is unknown, so it is not returned to the pool.
      if (errors.some(error => !subscriberError(error))) discard = true;
      if (commit && failure === undefined) {
        try {
          await frame.run('commit', [], 'COMMIT');
          return;
        } catch (error) {
          // A COMMIT whose subscriber failed has been committed.
          if (subscriberError(error)) throw error;
          // A failed COMMIT may already have ended the transaction. SQLite rolls back only when it is open, so
          // the database closes a session whose state is unknown.
          if (session.inTransaction?.() === true) {
            try { await frame.run('rollback', [], codes.ROLLBACK); } catch (rollback) { throw rollbackFailed(error, rollback); }
          } else if (this.driver !== 'sqlite') discard = true;
          throw error;
        }
      }
      try {
        await frame.run('rollback', [], codes.ROLLBACK);
      } catch (rollback) {
        if (!subscriberError(rollback)) discard = true;
        if (commit) throw rollbackFailed(failure, rollback);
        throw joinedErrors(failure === undefined ? [rollback] : [failure, rollback]);
      }
      if (failure !== undefined) throw failure;
    } finally {
      session.release(discard);
    }
  }

  /**
   * Opens a markdown transaction: holds one session of the pool until the transaction ends and sends begin. A read-only
   * transaction sends read_only.
   */
  private async beginMarkdown(md: MarkdownPool, options: BeginOptions): Promise<TxFrame> {
    if (options.isolation !== undefined) this.unsupportedOnMarkdown('the transaction isolation option');
    const session = await md.acquire(this.signal);
    try {
      await session.call(beginLine(options.readOnly === true), this.signal);
    } catch (error) {
      md.release(session);
      throw error;
    }
    return new TxFrame(this, session, this.nextTransaction(), options);
  }

  /**
   * Ends a markdown transaction with commit or rollback and returns the session to the pool. If the signal was cancelled,
   * it disconnects without sending a message: the server rolls back the transaction of the disconnected connection.
   */
  private async endMarkdown(frame: TxFrame, session: MarkdownSession, op: 'commit' | 'rollback'): Promise<void> {
    frame.finished = true;
    try {
      if (frame.db.signal?.aborted === true) {
        session.close();
        if (op === 'commit') throw new OrmError(codes.CANCELED, 'the transaction was cancelled before its commit');
        return;
      }
      await session.call(endLine(op), frame.db.signal);
    } finally {
      present(this.md, 'the flowmark pool of a markdown connection').release(session);
    }
  }

  /**
   * Sends one step of a savepoint name: savepoint, release, or rollback_to. An SQL connection sends that statement, and a markdown
   * connection sends a control message of the same name.
   */
  private async savepointStep(frame: TxFrame, kind: 'savepoint' | 'release' | 'rollback_to', name: string): Promise<void> {
    if (frame.md !== undefined) {
      await frame.md.call(savepointLine(kind, name), frame.db.signal);
      return;
    }
    const statement = kind === 'savepoint' ? `SAVEPOINT ${name}` : kind === 'release' ? `RELEASE SAVEPOINT ${name}` : `ROLLBACK TO SAVEPOINT ${name}`;
    await frame.run(kind, [], statement);
  }

  private async savepoint<T>(frame: TxFrame, callback: () => Promise<T> | T): Promise<T> {
    frame.savepoints++;
    const name = `orm_sp_${frame.savepoints}`;
    // A savepoint that does not release undoes an audit record inserted inside it.
    const auditBefore = frame.audit;
    let kept = false;
    try {
      await this.savepointStep(frame, 'savepoint', name);
      let result: T;
      try {
        result = await flow.run([...frames(), frame], callback);
      } catch (error) {
        // Tries both steps: undo the work after the savepoint, and release the savepoint.
        const errors: unknown[] = [];
        for (const kind of ['rollback_to', 'release'] as const) {
          try { await this.savepointStep(frame, kind, name); } catch (failure) { errors.push(failure); }
        }
        if (errors.length > 0) throw rollbackFailed(error, joinedErrors(errors));
        throw error;
      }
      await this.savepointStep(frame, 'release', name);
      kept = true;
      return result;
    } finally {
      if (!kept) frame.audit = auditBefore;
      frame.savepoints--;
    }
  }

  /**
   * SQLite's row lock. SQLite has no row lock clause, so one lock row stands in for the ORM's lock request
   * in order. Writes wait until busy_timeout, and a NOWAIT request sets the wait to 0. Others
   * the database takes it through the statement's lock clause.
   *
   * @internal
   */
  public async rowLock(frame: TxFrame, mode: string): Promise<void> {
    if (this.driver !== 'sqlite' || mode === '') return;
    const noWait = mode.endsWith('_nowait');
    const previous = noWait ? Number((await frame.run('utility', [], 'PRAGMA busy_timeout')).rows[0]?.[0]) : 0;
    try {
      if (noWait) await frame.run('utility', [], 'PRAGMA busy_timeout=0');
      await frame.run('utility', ROW_LOCK_TABLES, 'INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "id"=excluded."id"');
    } catch (error) {
      if (noWait && error instanceof OrmError && sqliteBusy('sqlite', error.cause)) throw new OrmError(codes.LOCK_NOT_AVAILABLE, error.message, error.cause);
      throw error;
    } finally {
      if (noWait) await frame.run('utility', [], `PRAGMA busy_timeout=${previous}`);
    }
  }

  public async plan(request: Request): Promise<Cached> {
    if (this.closed) throw new OrmError(codes.CONFIG, 'database is closed');
    // A connection plans only the sets registered to it. It checks this before looking at the plan cache.
    const engine = this.engines.get(request.manifest_hash);
    if (engine === undefined) {
      throw new OrmError(codes.SCHEMA_HASH_MISMATCH, `manifest ${request.manifest_hash} is not registered on this connection: connect through its generated models or install it`);
    }
    const key = canonical(request);
    const cached = this.plans.get(key);
    if (cached) return cached;
    const plan = engine.compile(request);
    const entry = { plan, id: planId(key) };
    this.plans.set(key, entry);
    const [oldest] = this.plans.keys();
    if (this.plans.size > this.planCacheSize && oldest !== undefined) this.plans.delete(oldest);
    return entry;
  }

  /**
   * The executor clock: writes the wall clock's microseconds as text in the connection zone (UTC) and cuts the
   * fraction to the precision digits, six digits. micros is the wallMicros value read once per statement.
   */
  /** The executor clock in microseconds: the clock that the test entry point fixed, or the wall clock. */
  public clockMicros(): number {
    return this.shared.fixedClock ?? wallMicros();
  }

  public now(micros: number, precision: number): string {
    const text = formatInstant(new Date(Math.floor(micros / 1000)), this.zone).slice(0, 20) + String(micros % 1_000_000).padStart(6, '0');
    return precision === 0 ? text.slice(0, 19) : text.slice(0, 20 + precision);
  }

  /** Resolves the bind slots of a step; masked marks secret and clock positions. */
  public args(step: PlanStep, params: readonly unknown[], parents: readonly unknown[] = [], audit?: AuditRecord): { values: unknown[]; masked: unknown[] } {
    const values: unknown[] = [];
    const masked: unknown[] = [];
    const push = (value: unknown, mask?: string) => { values.push(value); masked.push(mask ?? value); };
    let clock: number | undefined;
    for (const slot of step.bind_slots) {
      switch (slot.from) {
        case 'param': {
          let value = params[slot.param];
          // A transformed value is the text of its operator, and a host-styled value is the input of its first stage,
          // which hostEncode checks.
          checkAssign(slot.param, value, bindSlotType(slot));
          if (!slot.transform && slot.host_styles.length === 0) checkParam(slot.param, value, bindSlotType(slot), this.zone);
          if ((slot.col_type === 'datetime' || slot.col_type === 'date' || slot.col_type === 'time') && value !== null) {
            value = timeValue(value, slot.col_type, this.zone, slot.precision ?? 0);
          }
          if (slot.col_type === 'decimal' && value !== null) {
            if (typeof value !== 'string') throw new OrmError(codes.CODEC_ENCODE, 'decimal bind requires exact text');
            value = this.driver === 'sqlite'
              ? decimalScaled(value, slot.precision ?? 0, slot.scale ?? 0)
              : normalizeDecimal(value, slot.precision ?? 0, slot.scale ?? 0);
          }
          if (slot.transform) value = transformParam(slot.transform, value);
          if (slot.host_styles.includes('blind_index')) {
            if (value !== null) value = blindIndex(value, this.blindIndexKey);
          } else if (slot.host_styles.length > 0) value = hostEncode(value, slot.host_styles, this.aesKey);
          push(value);
          break;
        }
        case 'audit':
          push(auditValue(slot, audit));
          break;
        case 'secret':
          if (slot.name !== 'aes' || this.aesKey === '') throw new OrmError(codes.CONFIG, `secret ${slot.name} is not configured`);
          push(this.aesKey, SECRET);
          break;
        case 'config':
          if (slot.name !== 'aes_version') throw new OrmError(codes.CONFIG, `config value ${slot.name} is not configured`);
          push(this.aesVersion);
          break;
        case 'parent':
          for (const value of parents) push(value);
          break;
        case 'now':
          // One statement reads the clock once, so its clock columns are equal.
          clock ??= this.clockMicros();
          push(this.now(clock, slot.precision ?? 6), NOW);
          break;
        default:
          throw new OrmError(codes.INTERNAL, `bind from ${slot.from}`);
      }
    }
    return { values, masked };
  }

  /**
   * Runs one compiled statement STEP, a step of a plan of the engine (Engine.compile), with the
   * request parameters PARAMS, on the active transaction of the connection or on the connection. Its
   * bind slots are resolved as a model statement's are: host styles, decimals, SQLite time values,
   * the AES key and key version, the clock and the audit of the transaction. A step that reads rows
   * (it has an assemble) and a param slot past PARAMS fail with IR_INVALID before any statement runs
   * (docs/usage.md "Execute a compiled statement").
   */
  public async execute(step: PlanStep, params: readonly unknown[]): Promise<void> {
    const ex = resolve(this);
    await guarded(ex, async () => {
      if (step.assemble !== undefined) throw new OrmError(codes.IR_INVALID, 'execute runs a statement without rows; the statement is a read');
      step.bind_slots.forEach((slot, i) => {
        if (slot.from === 'param' && !(slot.param >= 0 && slot.param < params.length)) {
          throw new OrmError(codes.IR_INVALID, `bind slot ${i} reads parameter ${slot.param}, but execute has ${params.length} parameters`);
        }
      });
    });
    await this.auditFor(ex, step, false);
    await guarded(ex, async () => {
      await this.runStep(ex, step.sql, step, params);
    });
  }

  /**
   * Runs one plan step in ex. sql is the statement to send (for a relation step, the SQL with the parent values expanded),
   * parents are the values of the parent slots.
   *
   * @internal
   */
  public async runStep(ex: Executor, sql: string, step: PlanStep, params: readonly unknown[], parents: readonly unknown[] = []): Promise<DriverResult> {
    const { values, masked } = this.args(step, params, parents, ex.frame?.audit);
    const connection = ex.frame?.session ?? this.pool;
    // kind is the verb of the SQL that the plan step writes, and tables is the table of the plan step.
    const done = this.statementDone(statementKind(step.sql), step.tables, ex.frame?.number ?? null, masked);
    this.checkStatementFault(sql, done);
    return connection.execute(sql, values.map((value, i) => driverValue(value, `bind ${i + 1}`)), this.signal, done);
  }
}

/** Whether the error is a subscriber failure (SUBSCRIBER). That statement had an effect. */
function subscriberError(error: unknown): boolean {
  return error instanceof OrmError && error.code === codes.SUBSCRIBER;
}

/** Marks the start of a statement on an executor; a transaction rejects concurrent use. */
async function guarded<T>(ex: Executor, work: () => Promise<T>): Promise<T> {
  const frame = ex.frame;
  if (frame === undefined) return work();
  if (frame.finished) throw new OrmError(codes.CONFIG, 'transaction already finished');
  if (frame.busy) throw new OrmError(codes.CONFIG, 'the transaction connection is already in use');
  frame.busy = true;
  try { return await work(); } finally { frame.busy = false; }
}

/**
 * The key of the transaction's audit record, bound to the audit column of an
 * audited table; a write without an audit, or whose table records its audits
 * in another table than the transaction's audit record, is CONFIG.
 */
/** Whether the statement binds the audit record's key: it writes an audited table. */
function bindsAudit(step: PlanStep): boolean {
  return step.bind_slots.some(slot => slot.from === 'audit');
}

function auditValue(slot: BindSlot, audit: AuditRecord | undefined): unknown {
  if (audit === undefined) throw new OrmError(codes.CONFIG, 'a write of an audited table needs an audit: run it in a transaction with audit values');
  if (audit.table !== slot.name) {
    throw new OrmError(codes.CONFIG, `the audited table records its audits in ${slot.name}, but the audit of the transaction is a row of ${audit.table}`);
  }
  return audit.key;
}

function checkLock(ex: Executor, request: Request): void {
  if ((request.lock ?? '') !== '' && ex.frame === undefined) throw new OrmError(codes.CONFIG, 'row locks are allowed only inside a transaction');
}

function driverLimit(driver: string): number { return driver === 'sqlite' ? 999 : 65535; }

/** A request with its parameters, as the request hook of the handle left them. */
interface Hooked { request: Request; params: readonly unknown[]; }

/**
 * Applies the request hook of the executor handle before planning. The hook adds values to a copy of the parameter list with addParam,
 * and the client uses the n_params of the request the hook returned as its length. Validation is done by the plan. If the hook
 * is absent, the handle returns the request and params unchanged.
 */
function hooked(ex: Executor, request: Request, params: readonly unknown[], afterHook?: (hooked: Hooked) => void): Hooked {
  const hook = ex.db.requestHook;
  let planned: Hooked = { request, params };
  if (hook !== undefined) {
    const values = [...params];
    const out = hook(request, (value: unknown) => values.push(value) - 1, Object.freeze([...params]));
    if (out === null || typeof out !== 'object' || Array.isArray(out)) throw new OrmError(codes.CONFIG, 'the request hook returns the request to plan');
    out.n_params = values.length;
    planned = { request: out, params: values };
  }
  // The hook has run and the planner has not yet renumbered the parameters: a caller reads the request as the hook left it here.
  afterHook?.(planned);
  // A SQL connection plans the canonical form (T169-3): the IN lists pad to their buckets and the parameters are renumbered.
  if (ex.db.md !== undefined) return planned;
  const canon = canonicalize(planned.request, planned.params);
  return { request: canon.request, params: canon.params };
}

export async function query(ex: Executor, given: Request, givenParams: readonly unknown[]): Promise<Result> {
  const { request, params } = hooked(ex, given, givenParams);
  return guarded(ex, async () => {
    checkLock(ex, request);
    const db = ex.db;
    if (db.md !== undefined) return (await markdownRead(ex, request, params)).result;
    const cached = await db.plan(request);
    if (request.lock !== undefined && request.lock !== '') await db.rowLock(present(ex.frame, 'the transaction of a locking read'), request.lock);
    const parts = rootInParts(request, cached.plan, db.driver, params);
    let main: unknown[][];
    if (parts.length > 1) {
      main = [];
      const seen = new Set<string>();
      for (const part of parts) {
        const partPlan = await db.plan(part);
        const step = mainStep(partPlan.plan);
        for (const row of await select(ex, partPlan, step, params)) {
          const key = rowKey(row, assembleOf(step).key) ?? '';
          if (!seen.has(key)) { seen.add(key); main.push(row); }
        }
      }
    } else main = await select(ex, cached, mainStep(cached.plan), params);
    return relations(ex, cached, params, main);
  });
}

async function relations(ex: Executor, cached: Cached, params: readonly unknown[], main: unknown[][]): Promise<Result> {
  const out: Result = { plan: cached.plan, main, steps: new Map(), params, markdown: false };
  for (const step of cached.plan.steps.slice(1)) {
    if (step.role !== 'relation') continue;
    const parents = parentOf(step).step === 0 ? main : out.steps.get(parentOf(step).step)?.data ?? [];
    const values = parentValues(step, parents, params);
    const data: unknown[][] = [];
    if (values.length > 0) {
      for (const chunk of relationChunks(step, values, ex.db.driver)) data.push(...await select(ex, cached, step, params, chunk));
    }
    const keys = childKeys(cached.plan, step.id);
    const byKey = new Map<string, number[]>();
    data.forEach((row, index) => {
      const key = rowKey(row, keys);
      if (key === undefined) return;
      const list = byKey.get(key) ?? [];
      list.push(index);
      byKey.set(key, list);
    });
    out.steps.set(step.id, { step, data, byKey });
  }
  return out;
}

async function select(ex: Executor, cached: Cached, step: PlanStep, params: readonly unknown[], parents?: readonly unknown[]): Promise<unknown[][]> {
  let sql = step.sql;
  let values: readonly unknown[] = [];
  if (parents !== undefined) ({ sql, values } = expandParent(step, parents));
  const result = await ex.db.runStep(ex, sql, step, params, values);
  for (const row of result.rows) decodeAssembly(row, assembleOf(step), ex.db);
  return result.rows;
}

/**
 * Decodes the codec columns of a row in the style of assemble: unwraps the host stages (aes, hex, ip) and reads the remaining codecs. join
 * The child's columns are on the same row, so they are decoded together.
 *
 * @internal
 */
export function decodeAssembly(row: unknown[], assemble: Assemble, db: Db): void {
  let version = db.aesKeyring?.currentVersion ?? 1;
  if (assemble.aes_version !== undefined) {
    const at = row[present(assemble.columns[assemble.aes_version], 'the AES version column of an assembly').index];
    if (at !== null) version = Number(at);
  }
  for (const column of assemble.columns) {
    let value = row[column.index];
    if (value === undefined || column.styles.length === 0) continue;
    const host = column.styles.filter(style => style === 'aes' || style === 'hex' || style === 'ip');
    const client = column.styles.filter(style => style !== 'aes' && style !== 'hex' && style !== 'ip');
    const key = host.includes('aes') ? db.aesKeyring?.key(version) ?? db.aesKey : db.aesKey;
    if (value !== null && host.length > 0) value = hostDecode(cellBytes(value, column.index), host, key);
    if (client.length > 0) value = decode(client, value === null ? null : cellBytes(value, column.index));
    row[column.index] = value;
  }
  for (const child of assemble.children) if (child.kind === 'join' && child.assemble) decodeAssembly(row, child.assemble, db);
}

export async function scalar(ex: Executor, given: Request, givenParams: readonly unknown[]): Promise<unknown> {
  const { request, params } = hooked(ex, given, givenParams);
  return guarded(ex, async () => {
    checkLock(ex, request);
    const db = ex.db;
    if (db.md !== undefined) return markdownScalar(ex, request, params);
    const cached = await db.plan(request);
    const parts = rootInParts(request, cached.plan, db.driver, params);
    if (parts.length > 1) {
      if (request.kind !== 'count') throw new OrmError(codes.IR_INVALID, 'a split IN list can be merged only for a count');
      let total = 0;
      for (const part of parts) {
        const partPlan = await db.plan(part);
        total += Number((await db.runStep(ex, mainStep(partPlan.plan).sql, mainStep(partPlan.plan), params)).rows[0]?.[0] ?? 0);
      }
      return total;
    }
    const step = mainStep(cached.plan);
    return (await db.runStep(ex, step.sql, step, params)).rows[0]?.[0] ?? null;
  });
}

export async function paginate(ex: Executor, given: Request, givenParams: readonly unknown[]): Promise<{ result: Result; total: number }> {
  const { request, params } = hooked(ex, given, givenParams);
  return guarded(ex, async () => {
    checkLock(ex, request);
    const db = ex.db;
    if (db.md !== undefined) return markdownRead(ex, request, params);
    const cached = await db.plan(request);
    const main = await select(ex, cached, mainStep(cached.plan), params);
    const result = await relations(ex, cached, params, main);
    const step = cached.plan.steps.find(s => s.role === 'count');
    if (!step) throw new OrmError(codes.INTERNAL, 'paginate plan has no count step');
    const total = Number((await db.runStep(ex, step.sql, step, params)).rows[0]?.[0] ?? 0);
    return { result, total };
  });
}

/** A write's key, affected row count, and the request with its parameters as the request hook of the handle left them. */
export interface Written extends Hooked { key: number | string | null; affected: number; }

/**
 * Runs an insert, update, delete, or restore and returns the key of the inserted row and the affected row count:
 * the generated identity on a SQL database, the first key the markdown executor answers. It also returns the
 * request it ran, as the request hook left it.
 */
export async function write(ex: Executor, given: Request, givenParams: readonly unknown[], afterHook?: (hooked: Hooked) => void): Promise<Written> {
  const { request, params } = hooked(ex, given, givenParams, afterHook);
  const db = ex.db;
  let step: PlanStep | undefined;
  let settle = async (_affected: number, _failed: boolean, _error?: unknown): Promise<void> => {};
  if (db.md === undefined) {
    step = mainStep((await db.plan(request)).plan);
    settle = await db.auditFor(ex, step, request.kind !== 'insert');
  }
  let written: { key: number | string | null; affected: number };
  try {
    written = await writeStep(ex, request, params, step);
  } catch (error) {
    await settle(0, true, error);
    throw error;
  }
  await settle(written.affected, false);
  const { key, affected } = written;
  ex.db['shared'].lastAffected = affected;
  return { key, affected, request, params };
}

/** Runs the write of request in ex: step is its main plan step on a SQL database, undefined on markdown. */
async function writeStep(ex: Executor, request: Request, params: readonly unknown[], planned: PlanStep | undefined): Promise<{ key: number | string | null; affected: number }> {
  return guarded(ex, async (): Promise<{ key: number | string | null; affected: number }> => {
    const db = ex.db;
    if (db.md !== undefined || planned === undefined) {
      const { keys, affected } = await markdownWrite(ex, request, params);
      return { key: keys[0] ?? null, affected };
    }
    const step = planned;
    const result = await db.runStep(ex, step.sql, step, params);
    if (request.kind === 'insert' && / RETURNING /.test(step.sql)) return { key: Number(result.rows[0]?.[0]), affected: 1 };
    if (request.kind === 'update' && request.optimistic && result.affected === 0) throw new OrmError(codes.OPTIMISTIC_LOCK, 'the row changed after it was read');
    const key = request.kind === 'insert' && !request.rows && result.insertId !== null ? Number(result.insertId) : null;
    // An upsert writes one row: MySQL counts 2 for the one that updates, PostgreSQL and SQLite 1.
    const upsert = request.kind === 'insert' && (request.on_duplicate?.length ?? 0) > 0;
    return { key, affected: upsert ? 1 : result.affected };
  });
}

/** Returns the statement of a select request without executing it. */
export async function statement(ex: Executor, given: Request, givenParams: readonly unknown[]): Promise<{ sql: string; binds: unknown[] }> {
  ex.db.unsupportedOnMarkdown('getQuery');
  const { request, params } = hooked(ex, given, givenParams);
  const cached = await ex.db.plan(request);
  const step = mainStep(cached.plan);
  return { sql: step.sql, binds: ex.db.args(step, params).masked };
}

function parentValues(step: PlanStep, parents: readonly unknown[][], params: readonly unknown[]): unknown[] {
  const ref = parentOf(step);
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const row of parents) {
    if (ref.if_parent && scalarKey(row[ref.if_parent.index]) !== scalarKey(params[ref.if_parent.param])) continue;
    const key = rowKey(row, ref.keys);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    for (const part of ref.keys) out.push(row[part.index]);
  }
  return out;
}

function relationChunks(step: PlanStep, values: readonly unknown[], driver: string): unknown[][] {
  const width = parentOf(step).keys.length;
  const nonParent = step.bind_slots.filter(slot => slot.from !== 'parent').length;
  const max = Math.floor((driverLimit(driver) - nonParent) / width);
  if (max < 1) throw new OrmError(codes.IR_INVALID, `relation ${step.id} needs more bind parameters than ${driver} permits`);
  let size = 1;
  while (size * 2 <= max) size *= 2;
  const tuples = values.length / width;
  const out: unknown[][] = [];
  for (let start = 0; start < tuples; start += size) out.push(values.slice(start * width, Math.min(start + size, tuples) * width));
  return out;
}

function expandParent(step: PlanStep, source: readonly unknown[]): { sql: string; values: unknown[] } {
  const width = parentOf(step).keys.length;
  const tuples = source.length / width;
  let size = 1;
  while (size < tuples) size <<= 1;
  const values = [...source];
  while (values.length < size * width) values.push(...source.slice((tuples - 1) * width, tuples * width));
  const list = (format: (m: number) => string) => {
    let out = '';
    for (let m = 0; m < size * width; m++) {
      if (m > 0) out += width > 1 && m % width === 0 ? '), (' : ', ';
      out += format(m);
    }
    return out;
  };
  const parentSlot = step.bind_slots.findIndex(slot => slot.from === 'parent');
  if (step.sql.includes('$1')) {
    const parent = parentSlot + 1;
    return {
      sql: step.sql.replace(/\$(\d+)/g, (_, raw: string) => {
        const n = Number(raw);
        if (n === parent) return list(m => `$${n + m}`);
        return `$${n > parent ? n + size * width - 1 : n}`;
      }),
      values,
    };
  }
  let slot = 0;
  return { sql: step.sql.replace(/\?/g, () => step.bind_slots[slot++]?.from === 'parent' ? list(() => '?') : '?'), values };
}

function childKeys(plan: Plan, id: number): KeyReference[] {
  const find = (assemble: Assemble): KeyReference[] | undefined => {
    for (const child of assemble.children) {
      if (child.kind !== 'join' && child.step === id) return child.child_keys;
      if (child.kind === 'join' && child.assemble) {
        const found = find(child.assemble);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const step of plan.steps) if (step.assemble) { const found = find(step.assemble); if (found) return found; }
  throw new OrmError(codes.INTERNAL, `relation step ${id} has no child`);
}

/** The main step of `plan`, which every plan has first. */
function mainStep(plan: Plan): PlanStep {
  return present(plan.steps[0], 'the main step of a plan');
}

/** The parent reference of the relation step `step`. */
function parentOf(step: PlanStep): NonNullable<PlanStep['parent']> {
  return present(step.parent, `the parent of relation step ${step.id}`);
}

/** The assembly of the select step `step`. */
function assembleOf(step: PlanStep): Assemble {
  return present(step.assemble, `the assembly of step ${step.id}`);
}

/** A codec cell as the driver reads it: text or bytes; another value is a CODEC_DECODE error. */
function cellBytes(value: unknown, index: number): string | Uint8Array {
  if (typeof value === 'string' || value instanceof Uint8Array) return value;
  throw new OrmError(codes.CODEC_DECODE, `the codec column at ${index} reads a ${typeof value}`);
}

function itemConn(item: Group['items'][number]): string | undefined {
  return item.pred?.conn ?? item.group?.conn ?? item.joined?.conn;
}

/** Splits a root IN list joined with AND that exceeds the driver bind limit. */
function rootInParts(request: Request, plan: Plan, driver: string, params: readonly unknown[]): Request[] {
  const main = mainStep(plan);
  const limit = driverLimit(driver);
  if (main.bind_slots.length <= limit) return [request];
  const tooLarge = new OrmError(codes.IR_INVALID, `the statement needs ${main.bind_slots.length} bind parameters but ${driver} permits ${limit}`);
  if (request.limit || request.order?.length || request.group_by?.length || !request.where) throw tooLarge;
  const items = request.where.items;
  let target = -1;
  items.forEach((item, i) => {
    if (!item.pred) return;
    const following = items[i + 1];
    if (item.pred.conn === 'or' || (following !== undefined && itemConn(following) === 'or')) throw tooLarge;
    if (item.pred.op === 'in' && !item.pred.sub && (target < 0 || (item.pred.ps?.length ?? 0) > (items[target]?.pred?.ps?.length ?? 0))) target = i;
  });
  if (target < 0) throw tooLarge;
  const ps = present(items[target]?.pred?.ps, 'the IN list that is split');
  const available = limit - (main.bind_slots.length - ps.length);
  if (available < 1) throw tooLarge;
  let chunk = 1;
  while (chunk * 2 <= available) chunk *= 2;
  const seen = new Set<string>();
  const unique = ps.filter(index => { const key = scalarKey(params[index]); if (seen.has(key)) return false; seen.add(key); return true; });
  const parts: Request[] = [];
  for (let start = 0; start < unique.length; start += chunk) {
    const part = structuredClone(request);
    const slice = unique.slice(start, start + chunk);
    let n = 1;
    while (n < slice.length) n <<= 1;
    const last = present(slice.at(-1), 'the last parameter of a part');
    while (slice.length < n) slice.push(last);
    present(part.where?.items[target]?.pred, 'the split IN condition of a part').ps = slice;
    parts.push(part);
  }
  return parts;
}
