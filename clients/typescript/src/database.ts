import { AsyncLocalStorage } from 'node:async_hooks';
import { blindIndex, decode, hostDecode, hostEncode } from './codec.js';
import type { Assemble, BindSlot, Group, KeyReference, Plan, PlanStep, Request } from './ir.js';
import { isolationSql, openDriver, parseDsn, sqliteBusy, unobserved, zoneOffset, type DriverName, type DriverPool, type DriverResult, type DriverSession, type DriverValue, type Isolation, type PoolStats, type StatementDone } from './driver.js';
import { Subscribers, statementKind, type StatementEvent, type StatementKind, type StatementSubscriber } from './events.js';
import { OrmError, joinedErrors, rollbackFailed } from './runtime_error.js';
import { Utils } from './utils.js';
import { wallMicros } from './clock.js';
import { AesKeyring } from './aes.js';
import { Engine } from './engine/index.js';
import { modelOfManifest, type RuntimeModel } from './engine/model.js';
import { decimalScaled, normalizeDecimal } from './decimal.js';
import { CORE, type Core } from './core.js';
import { Model } from './model.js';
import { fieldOf, type Entity } from './engine/model.js';

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
   * Makes the transaction one unit of work with an audit record. Before the
   * callback, in every attempt, the transaction inserts one row into the
   * audit record table, the table that the audit settings of the sets
   * registered on the connection name with references: the values of the
   * auditSource connect option, called once for the transaction, with these
   * values, a value winning over the source's value of the same column.
   * Every insert, update, soft delete and restore of an audited table in the
   * transaction writes the record's primary key into the table's audit
   * column. A nested transaction uses the audit of the outer one and does not
   * take this option.
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
 * 등록할 schema의 runtime model이다. text가 선언한 hash로 hash되지 않으면 어떤
 * statement보다 먼저 CONFIG이고, text가 manifest가 아니면 SCHEMA_INVALID다.
 */
export function schemaModel(schema: Schema): RuntimeModel {
  if (schema === null || typeof schema !== 'object' || typeof schema.manifestText !== 'string' || typeof schema.manifestHash !== 'string'
    || (schema.externalText !== undefined && typeof schema.externalText !== 'string')) {
    throw new OrmError('CONFIG', 'a schema is the manifestText, manifestHash and optional externalText of generated code');
  }
  const externalText = schema.externalText ?? '';
  const loaded = models.get(schema.manifestHash);
  if (loaded !== undefined && loaded.manifestText === schema.manifestText && loaded.externalText === externalText) return loaded;
  try {
    return modelOfManifest(schema.manifestText, schema.manifestHash, externalText);
  } catch (error) {
    if (error instanceof OrmError && error.code === 'SCHEMA_HASH_MISMATCH') {
      throw new OrmError('CONFIG', `invalid schema manifest: the manifest text does not hash to its declared manifestHash ${schema.manifestHash}`, error);
    }
    throw error;
  }
}

// 등록은 이 module의 registerSet과 Db.connectSchema만 한다. package는 이 symbol을 내보내지 않는다.
const REGISTER = Symbol('register');

/** schema의 set을 연결에 등록한다. 같은 set을 다시 등록하면 아무것도 바꾸지 않는다. */
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
  // 이미 등록된 hash라도 다른 text는 자기 hash로 검사한다: 잘못된 text는 SCHEMA_INVALID,
  // 다른 hash로 가는 text는 SCHEMA_HASH_MISMATCH다.
  const model = modelOfManifest(manifestText, manifestHash, externalText);
  models.set(manifestHash, model);
  return model;
}

/** The options of an outermost transaction. */
interface BeginOptions { isolation?: Isolation; readOnly?: boolean; timeoutMs: number; }

/**
 * statement 하나를 보내고 그 event를 publish한다. kind와 tables는 event의 것이고 params는 bind다.
 *
 * @internal
 */
export type Runner = (kind: StatementKind, tables: readonly string[], sql: string, params?: readonly DriverValue[]) => Promise<DriverResult>;

/** SQLite row lock statement가 가리키는 table이다. */
const ROW_LOCK_TABLES: readonly string[] = ['orm__row_lock'];
const ROW_LOCK_DDL = 'CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))';

/** One active transaction. */
export class TxFrame {
  public busy = false;
  public finished = false;
  public savepoints = 0;
  public readonly locals = new Map<string, string>();
  public readonly locks: string[] = [];
  /** The audit record of the unit of work; audited writes of the transaction write its key. */
  public audit: AuditRecord | undefined = undefined;
  /** number는 연결에서 이 transaction의 번호다. 그 statement의 event가 싣는다. */
  public constructor(public readonly db: Db, public readonly session: DriverSession, public readonly number: number, public readonly options: BeginOptions) {}

  /** transaction 연결에서 prepare하지 않은 statement를 보내고 그 event를 publish한다. */
  public run(kind: StatementKind, tables: readonly string[], sql: string, params: readonly DriverValue[] = []): Promise<DriverResult> {
    return this.session.control(sql, params, this.db.statementDone(kind, tables, this.number, params));
  }
}

const flow = new AsyncLocalStorage<readonly TxFrame[]>();

function frames(): readonly TxFrame[] { return flow.getStore() ?? []; }

export function activeFor(db: Db): TxFrame | undefined {
  const stack = frames();
  // A signal handle is the same connection, so frames are matched by connection.
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.db.pool === db.pool && !stack[i]!.finished) return stack[i];
  return undefined;
}

/** Where a statement runs: a connection or an active transaction. */
export interface Executor { readonly db: Db; readonly frame: TxFrame | undefined; }

/** Selects the active transaction of the connection, the connection, or the innermost transaction. */
export function resolve(conn: Db | undefined): Executor {
  if (conn !== undefined) {
    const frame = activeFor(conn);
    if (frame) return { db: conn, frame };
    if (conn.closed) throw new OrmError('CONFIG', 'database is closed');
    return { db: conn, frame: undefined };
  }
  const stack = frames();
  const frame = stack[stack.length - 1];
  if (frame && !frame.finished) return { db: frame.db, frame };
  throw new OrmError('CONFIG', 'the model has no connection; use connect or run it inside a transaction');
}

export const SECRET = '$SECRET';
export const NOW = '$NOW';

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** Formats an instant in a connection time zone as date-time text with six fraction digits. */
export function formatInstant(instant: Date, zone: string): string {
  const shifted = new Date(instant.getTime() + zoneOffset(zone) * 60_000);
  const micro = String(shifted.getUTCMilliseconds()).padStart(3, '0') + '000';
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}.${micro}`;
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
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()) || colType === 'time') return undefined;
    const text = formatInstant(value, zone);
    return colType === 'date' ? text.slice(0, 10) : timeForm(text, colType, zone, precision);
  }
  if (typeof value !== 'string') return undefined;
  if (colType === 'date') {
    const m = dateText.exec(value);
    return m && validDate(m[1]!, m[2]!, m[3]!) ? value : undefined;
  }
  if (colType === 'time') {
    const m = timeText.exec(value);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59) return undefined;
    const f = fraction(m[4], precision);
    return f === undefined ? undefined : `${m[1]}:${m[2]}:${m[3]}${f}`;
  }
  const m = dateTimeText.exec(value);
  if (!m || !validDate(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!)) return undefined;
  const f = fraction(m[7], precision);
  if (f === undefined) return undefined;
  if (m[8] === undefined) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}${f}`;
  const digits = m[8].slice(1).replace(':', '');
  const offset = m[8] === 'Z' ? 0 : (m[8].startsWith('-') ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0'));
  const instant = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000);
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
  if (text === undefined) throw new OrmError('CODEC_ENCODE', `${colType} value ${JSON.stringify(value)} is not ${timeShape(colType, precision)}`);
  return text;
}

/** Reads a stored date, time or datetime cell in its value form; any other cell is CODEC_DECODE. */
export function readTime(value: unknown, colType: string, zone: string, precision: number): string {
  const text = timeForm(value, colType, zone, precision);
  if (text === undefined) throw new OrmError('CODEC_DECODE', `${colType} cell ${JSON.stringify(value)} is not ${timeShape(colType, precision)}`);
  return text;
}

interface Cached { plan: Plan; id: string; }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
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
}

export function scalarKey(value: unknown): string {
  if (value === null || value === undefined) return '\u0000';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Uint8Array) return Buffer.from(value).toString();
  return String(value);
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

/** A collection key: a number or a string, never equal to each other. */
export type Key = number | string;

export function keyOfValues(values: readonly unknown[]): string {
  if (values.length === 1) return keyText(values[0]);
  return values.map(v => { const part = scalarKey(v); return `${part.length}:${part}`; }).join('');
}

export function keyText(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'bigint') return `n:${value}`;
  if (typeof value === 'boolean') return `n:${value ? 1 : 0}`;
  return `s:${scalarKey(value)}`;
}

export function keyValue(value: unknown): Key {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return scalarKey(value);
}

/**
 * connection의 rollback fault를 설정한다. test entry point `src/testing.ts`만
 * 호출하며 package entry point는 export하지 않는다.
 */
export function armRollbackFault(db: Db): void {
  db['shared'].rollbackFault = true;
}

/** A database connection with its plan cache and statement cache. */
export class Db {
  // 한 connection의 모든 handle이 공유하는 상태다. rollbackFault는 test entry
  // point의 failNextRollback이 설정하는 test fault다.
  // events는 subscriber 목록과 transaction 번호이고, rowLockTable은 SQLite row lock table을 이 연결에서
  // 만들었는지다.
  private readonly shared = { closed: false, rollbackFault: false, events: new Subscribers(), rowLockTable: false };
  public readonly signal: AbortSignal | undefined = undefined;
  /** The audit values of the current request; the connection and its handles share it. */
  private readonly auditSource: (() => Record<string, unknown>) | undefined;
  private readonly plans = new Map<string, Cached>();
  private readonly engines = new Map<string, Engine>();
  public readonly aesKey: string;
  public readonly blindIndexKey: string;
  public readonly aesVersion: number;
  public readonly aesKeyring: AesKeyring | undefined;
  private readonly planCacheSize: number;

  private constructor(public readonly pool: DriverPool, public readonly zone: string, options: ConnectOptions) {
    this.blindIndexKey = options.blindIndexKey ?? '';
    this.aesVersion = options.aesVersion ?? 1;
    if (!Number.isSafeInteger(this.aesVersion) || this.aesVersion < 1) throw new OrmError('CONFIG', 'aes version must be a positive integer');
    // aesKey is the key of aesVersion: writes encrypt with it, and aesKeys holds it at aesVersion.
    const given = options.aesKey ?? '';
    const listed = options.aesKeys?.get(this.aesVersion) ?? '';
    if (given !== '' && options.aesKeys !== undefined && listed !== given) throw new OrmError('CONFIG', `aesKey differs from aesKeys[${this.aesVersion}]`);
    this.aesKey = given !== '' ? given : listed;
    const keys = options.aesKeys ?? (this.aesKey === '' ? undefined : new Map([[this.aesVersion, this.aesKey]]));
    this.aesKeyring = keys === undefined ? undefined : new AesKeyring(keys, this.aesVersion);
    if (options.auditSource !== undefined && typeof options.auditSource !== 'function') throw new OrmError('CONFIG', 'auditSource is a function that returns the audit values');
    this.auditSource = options.auditSource;
    this.planCacheSize = options.planCacheSize ?? 256;
    if (!Number.isSafeInteger(this.planCacheSize) || this.planCacheSize < 1) throw new OrmError('CONFIG', 'plan cache size must be a positive integer');
  }

  /**
   * Opens the database selected by the DSN URI scheme. The connection has no
   * set registered: a model request on it fails with SCHEMA_HASH_MISMATCH
   * until install registers the set of the model.
   */
  public static async connect(dsn: string, options: ConnectOptions = {}): Promise<Db> {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new OrmError('CONFIG', 'connect takes the DSN and an options object');
    const parsed = parseDsn(dsn);
    const statementCacheSize = options.statementCacheSize ?? 256;
    if (!Number.isSafeInteger(statementCacheSize) || statementCacheSize < 1) throw new OrmError('CONFIG', 'statement cache size must be a positive integer');
    if ((options.poolSize ?? 0) < 0) throw new OrmError('CONFIG', 'pool size must not be negative');
    if ((options.statementTimeoutMs ?? 0) < 0) throw new OrmError('CONFIG', 'statement timeout must not be negative');
    // Zero or unset takes the default of every client, 10 connections.
    const size = options.poolSize || 10;
    const idleSize = options.poolIdleSize ?? 0;
    if (idleSize < 0 || idleSize > size) throw new OrmError('CONFIG', `pool idle size must be between 0 and the pool size ${size}`);
    if ((options.poolLifetimeMs ?? 0) < 0) throw new OrmError('CONFIG', 'pool lifetime must not be negative');
    const pool = openDriver(dsn, parsed, { size, idleSize: idleSize || size, lifetimeMs: options.poolLifetimeMs ?? 0 }, statementCacheSize, options.statementTimeoutMs ?? 0);
    const db = new Db(pool, parsed.zone, options);
    // 연결을 여는 statement는 event가 아니다.
    try { await pool.execute('SELECT 1', [], undefined, unobserved); } catch (error) { await pool.close(); throw error; }
    return db;
  }

  /**
   * DSN URI scheme이 고르는 database를 열고 generated schema의 set을 utils().schema().register처럼 그
   * 연결에 등록한다. generated model의 connect helper가 부른다. manifest text가 선언한 hash로 hash되지
   * 않으면 연결을 열기 전에 CONFIG다. 등록은 database를 읽지 않는다: database는 install과
   * addTablesAndColumns가 확인한다.
   */
  public static async connectSchema(dsn: string, schema: Schema, options: ConnectOptions = {}): Promise<Db> {
    const model = schemaModel(schema);
    const db = await Db.connect(dsn, options);
    db[REGISTER](model);
    return db;
  }

  public [REGISTER](model: RuntimeModel): void {
    if (!this.engines.has(model.manifestHash)) this.engines.set(model.manifestHash, new Engine(model, this.driver));
  }

  public get driver(): DriverName { return this.pool.name; }

  public get closed(): boolean { return this.shared.closed; }

  /**
   * Returns a handle on the same connection whose statements are bound to
   * signal: aborting it cancels the statement in flight and raises CANCELED.
   * Models connect to the handle as they connect to the connection, and
   * transactions started on it are bound to the same signal. Closing either
   * handle closes the connection.
   */
  public withSignal(signal: AbortSignal): Db {
    const handle: Db = Object.create(Db.prototype) as Db;
    Object.assign(handle, this);
    Object.defineProperty(handle, 'signal', { value: signal, enumerable: true, writable: false });
    Object.defineProperty(handle, 'rootDb', { value: this.root(), enumerable: false, writable: false });
    return handle;
  }

  /** The connection this handle was derived from; a connection returns itself. */
  public root(): Db {
    return (this as { rootDb?: Db }).rootDb ?? this;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.shared.closed = true;
    this.plans.clear();
    await this.pool.close();
  }

  public utils(): Utils { return new Utils(this); }

  /**
   * Registers subscriber for the event of every statement that the connection
   * and every handle derived from it send (docs/usage.md "Statement events").
   * Subscribers run synchronously in registration order after the statement
   * ends and before the operation continues; one that throws fails the
   * operation with SUBSCRIBER. The returned function removes the subscription.
   */
  public subscribe(subscriber: (event: StatementEvent) => void): () => void {
    return this.shared.events.subscribe(subscriber as StatementSubscriber);
  }

  /**
   * statement 하나의 event를 publish하는 done이다.
   *
   * @internal
   */
  public statementDone(kind: StatementKind, tables: readonly string[], transaction: number | null, binds: readonly unknown[]): StatementDone {
    return this.shared.events.done(kind, tables, transaction, binds);
  }

  /**
   * 새 바깥 transaction의 번호다.
   *
   * @internal
   */
  public nextTransaction(): number { return this.shared.events.nextTransaction(); }

  /**
   * session에서 prepare하지 않은 statement를 보내는 runner다. transaction은 statement의 transaction
   * 번호이고 밖이면 null이다.
   *
   * @internal
   */
  public runner(session: DriverSession, transaction: number | null): Runner {
    return (kind, tables, sql, params = []) => session.control(sql, params, this.statementDone(kind, tables, transaction, params));
  }

  /**
   * 연결 하나를 잡아 transaction 밖에서 fn을 실행하고 돌려준다.
   *
   * @internal
   */
  public async withSession<T>(fn: (session: DriverSession) => Promise<T>): Promise<T> {
    const session = await this.pool.reserve();
    try { return await fn(session); } finally { session.release(false); }
  }

  public stats(): PoolStats { return this.pool.stats(); }

  /**
   * Runs callback in one transaction. An exception rolls back; otherwise the
   * transaction commits and the callback result is returned. Models without
   * connect inside the callback use this transaction. A transaction of the
   * same connection inside an active one creates a savepoint.
   */
  public async transaction<T>(callback: () => Promise<T> | T, options: TransactionOptions = {}): Promise<T> {
    const retry = options.retry ?? 3;
    if (!Number.isSafeInteger(retry) || retry < 0) throw new OrmError('CONFIG', 'transaction retry must be a non-negative integer');
    const timeoutMs = options.timeoutMs ?? 0;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new OrmError('CONFIG', 'transaction timeoutMs must not be negative');
    const outer = activeFor(this);
    // audit 기록은 transaction 이 시작하기 전에 검사하고 시도마다 callback 앞에서 삽입한다.
    const record = options.audit !== undefined && outer === undefined ? this.auditRecord(options.audit) : undefined;
    if (outer) {
      if (options.isolation !== undefined || options.readOnly !== undefined || options.timeoutMs !== undefined || options.audit !== undefined) {
        throw new OrmError('CONFIG', 'a nested transaction of the same connection accepts only the retry option');
      }
      return this.savepoint(outer, callback);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.run(callback, { isolation: options.isolation, readOnly: options.readOnly, timeoutMs }, record);
      } catch (error) {
        if (!(error instanceof OrmError) || error.code !== 'DEADLOCK' || attempt >= retry) throw error;
        await new Promise(resolve => setTimeout(resolve, (50 << attempt) + Math.floor(Math.random() * 20)));
      }
    }
  }

  /**
   * audit source 의 값에 transaction 의 값을 더한 audit 기록이다. 같은 column 이면 transaction 의 값이 이긴다. 기록
   * table 은 연결에 등록한 set 의 audit setting 이 references 로 이름한 table 하나이며, 그 table 을 entity 로 가진 set
   * 이 연결에 등록되어 있어야 한다. audit source 가 없거나, 기록 table 이 없거나 여럿이거나, 값의 key 가 그 table 의
   * column 이 아니거나, 값이 하나도 없거나, primary key 가 column 하나가 아니면 CONFIG 이고, source 가 던진 오류는
   * 그대로 전한다.
   */
  private auditRecord(values: Readonly<Record<string, unknown>>): AuditInsert {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new OrmError('CONFIG', 'transaction audit is an object of column values');
    if (this.auditSource === undefined) {
      throw new OrmError('CONFIG', 'the transaction has audit values but the connection has no audit source: set the auditSource connect option');
    }
    const engines = [...this.engines.values()];
    const tables = [...new Set(engines.flatMap(e => [...e.model.entities.values()].map(x => x.auditRecord).filter(t => t !== '')))].sort();
    if (tables.length === 0) throw new OrmError('CONFIG', 'the transaction has audit values but no set of the connection has an audited table');
    if (tables.length > 1) throw new OrmError('CONFIG', `the audited tables of the connection record their audits in ${tables.join(', ')}; one audit record table is required`);
    const table = tables[0]!;
    let target: { model: RuntimeModel; entity: Entity } | undefined;
    for (const engine of engines) {
      for (const entity of engine.model.entities.values()) if (entity.table === table) target = { model: engine.model, entity };
    }
    if (target === undefined) throw new OrmError('CONFIG', `the audit record table ${table} is not a table of a set registered on the connection`);
    if (target.entity.primaryKey.length !== 1) throw new OrmError('CONFIG', `the audit record table ${table} needs a primary key of one column`);
    const source = this.auditSource();
    const merged: Record<string, unknown> = {};
    for (const set of [source, values]) {
      if (set === null || typeof set !== 'object' || Array.isArray(set)) throw new OrmError('CONFIG', 'the audit source returns an object of column values');
      for (const column of Object.keys(set).sort()) {
        if (fieldOf(target.entity, column) === undefined) throw new OrmError('CONFIG', `audit value ${column} is not a column of ${table}`);
        merged[column] = set[column];
      }
    }
    if (Object.keys(merged).length === 0) throw new OrmError('CONFIG', `the audit record of ${table} has no value: the audit source and the transaction give none`);
    return { ...target, values: merged };
  }

  /**
   * transaction 의 audit 기록을 삽입하고 그 table 과 primary key 값을 돌려준다. primary key 가 identity 이면 생성된
   * key, 아니면 기록의 값이다. 시도마다 다시 삽입한다.
   */
  private async insertAudit(record: AuditInsert): Promise<AuditRecord> {
    const { model, entity } = record;
    const cls = class extends Model {};
    Object.assign(cls, { entity: { model, entity, create: (core: Core) => new cls(core) } });
    const row = new cls();
    for (const column of Object.keys(record.values).sort()) row[CORE].setValue(column, record.values[column]);
    const created = (await row.create())[CORE];
    const key = created.values.get(entity.primaryKey[0]!);
    if (key === undefined || key === null) throw new OrmError('CONFIG', `the audit record ${entity.table} has no ${entity.primaryKey[0]} after its insert`);
    return { table: entity.table, key };
  }

  private async run<T>(callback: () => Promise<T> | T, options: BeginOptions, record: AuditInsert | undefined): Promise<T> {
    if (this.closed) throw new OrmError('CONFIG', 'database is closed');
    const frame = await this.begin(options);
    let result: T;
    try {
      result = await flow.run([...frames(), frame], async () => {
        if (record !== undefined) frame.audit = await this.insertAudit(record);
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
        throw rollbackFailed(error, new OrmError('FAULT', 'test fault: the rollback of the transaction ran and is reported as failed'));
      }
      throw error;
    }
    await this.finish(frame, true);
    return result;
  }

  /**
   * SQLite row lock table을 연결의 첫 transaction 전에 transaction 밖에서 한 번 만든다(docs/usage.md
   * "Statement events").
   */
  private async rowLockTable(): Promise<void> {
    if (this.shared.rowLockTable) return;
    await this.pool.execute(ROW_LOCK_DDL, [], undefined, this.statementDone('utility', ROW_LOCK_TABLES, null, []));
    this.shared.rowLockTable = true;
  }

  /**
   * 연결 하나를 잡고 바깥 transaction을 연다. transaction은 연결의 다음 번호를 받는다. transaction을 여는
   * statement는 docs/usage.md "Statement events"의 것이다. BEGIN 전에 실패하면 session에 남은 설정이 다음
   * 사용자에게 가지 않도록 연결을 닫고, BEGIN 뒤에 실패하면 transaction을 rollback한다.
   */
  private async begin(options: BeginOptions): Promise<TxFrame> {
    const driver = this.driver;
    if (options.timeoutMs > 0 && driver !== 'postgres') throw new OrmError('CAPABILITY_UNSUPPORTED', 'transaction timeoutMs is supported only by postgres');
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
        // 읽기 전용 transaction은 deferred BEGIN이고, 나머지는 시작할 때 쓰기 lock을 잡고 busy_timeout까지 기다린다.
        steps.push(['begin', options.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE']);
        if (options.isolation === 'read_uncommitted') steps.push(['utility', 'PRAGMA read_uncommitted = 1']);
        if (options.readOnly) steps.push(['utility', 'PRAGMA query_only = 1']);
    }
    let began = false;
    for (const [kind, sql] of steps) {
      try {
        await frame.run(kind, [], sql);
      } catch (error) {
        // subscriber가 실패한 statement는 효과를 냈다.
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
   * transaction을 끝낸다. 끝내기 전에 SQLite mode를 되돌리고 MySQL named lock을 풀고 MySQL local 값을
   * key 순서로 지운다. 이 상태는 COMMIT과 ROLLBACK 뒤에도 connection에 남으므로 모든 단계를 시도하고
   * 실패를 모두 보고한다. cleanup이 실패한 commit은 rollback하고 cleanup 오류를 던진다. signal이 취소된
   * transaction은 ROLLBACK 대신 session을 닫아 server가 transaction과 그 상태를 함께 끝내게 한다. SQLite의
   * 하나뿐인 연결은 닫을 수 없으므로 ROLLBACK한다.
   */
  private async finish(frame: TxFrame, commit: boolean): Promise<void> {
    if (frame.finished) return;
    frame.finished = true;
    const session = frame.session;
    if (!commit && this.driver !== 'sqlite' && frame.db.signal?.aborted === true) {
      session.release(true);
      return;
    }
    // discard는 상태를 알 수 없는 session을 pool에 돌려주지 않고 닫는다.
    let discard = false;
    try {
      const errors: unknown[] = [];
      const attempt = async (sql: string, params: readonly DriverValue[] = []): Promise<DriverResult | undefined> => {
        try { return await frame.run('utility', [], sql, params); } catch (error) { errors.push(error); return undefined; }
      };
      if (this.driver === 'sqlite') {
        if (frame.options.readOnly) await attempt('PRAGMA query_only = 0');
        if (frame.options.isolation === 'read_uncommitted') await attempt('PRAGMA read_uncommitted = 0');
      }
      for (const key of frame.locks.splice(0)) {
        const released = await attempt('SELECT RELEASE_LOCK(?)', [key]);
        // 1이 아니면 이 connection이 lock을 갖고 있지 않았다.
        if (released !== undefined && Number(released.rows[0]?.[0]) !== 1) errors.push(new OrmError('CONFIG', `lock ${key} was not held at transaction end`));
      }
      if (this.driver === 'mysql') {
        // 값을 지우는 statement는 key 순서로 보낸다.
        for (const key of [...frame.locals.keys()].sort()) await attempt(`SET @\`orm.${key}\` = NULL`);
      }
      const failure = joinedErrors(errors);
      if (commit && failure === undefined) {
        try {
          await frame.run('commit', [], 'COMMIT');
          return;
        } catch (error) {
          // subscriber가 실패한 COMMIT은 commit되었다.
          if (subscriberError(error)) throw error;
          // 실패한 COMMIT은 transaction을 이미 끝냈을 수 있다. SQLite는 열려 있을 때만 rollback하고, 다른
          // database는 상태를 알 수 없는 session을 닫는다.
          if (session.inTransaction?.() === true) {
            try { await frame.run('rollback', [], 'ROLLBACK'); } catch (rollback) { throw rollbackFailed(error, rollback); }
          } else if (this.driver !== 'sqlite') discard = true;
          throw error;
        }
      }
      try {
        await frame.run('rollback', [], 'ROLLBACK');
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

  private async savepoint<T>(frame: TxFrame, callback: () => Promise<T> | T): Promise<T> {
    frame.savepoints++;
    const name = `orm_sp_${frame.savepoints}`;
    try {
      await frame.run('savepoint', [], `SAVEPOINT ${name}`);
      let result: T;
      try {
        result = await flow.run([...frames(), frame], callback);
      } catch (error) {
        // savepoint 뒤의 작업을 되돌리고 savepoint를 푸는 두 statement를 모두 시도한다.
        const errors: unknown[] = [];
        for (const [kind, statement] of [['rollback_to', `ROLLBACK TO SAVEPOINT ${name}`], ['release', `RELEASE SAVEPOINT ${name}`]] as const) {
          try { await frame.run(kind, [], statement); } catch (failure) { errors.push(failure); }
        }
        if (errors.length > 0) throw rollbackFailed(error, joinedErrors(errors));
        throw error;
      }
      await frame.run('release', [], `RELEASE SAVEPOINT ${name}`);
      return result;
    } finally {
      frame.savepoints--;
    }
  }

  /**
   * SQLite의 row lock이다. SQLite에는 row lock 절이 없으므로 lock row 하나가 ORM의 lock 요청을
   * 차례로 세운다. 쓰기는 busy_timeout까지 기다리고, NOWAIT 요청은 기다림을 0으로 둔다. 다른
   * database는 statement의 lock 절이 잡는다.
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
      if (noWait && error instanceof OrmError && sqliteBusy('sqlite', error.cause)) throw new OrmError('LOCK_NOT_AVAILABLE', error.message, error.cause);
      throw error;
    } finally {
      if (noWait) await frame.run('utility', [], `PRAGMA busy_timeout=${previous}`);
    }
  }

  public async plan(request: Request): Promise<Cached> {
    if (this.closed) throw new OrmError('CONFIG', 'database is closed');
    // 연결은 자기에게 등록된 set만 plan한다. plan cache를 보기 전에 확인한다.
    const engine = this.engines.get(request.manifest_hash);
    if (engine === undefined) {
      throw new OrmError('SCHEMA_HASH_MISMATCH', `manifest ${request.manifest_hash} is not registered on this connection: connect through its generated models or install it`);
    }
    const key = canonical(request);
    const cached = this.plans.get(key);
    if (cached) return cached;
    const plan = engine.compile(request);
    const entry = { plan, id: planId(key) };
    this.plans.set(key, entry);
    if (this.plans.size > this.planCacheSize) this.plans.delete(this.plans.keys().next().value as string);
    return entry;
  }

  /**
   * executor clock이다: wall clock의 microsecond를 connection zone(UTC)의 text로 쓰고 6자리
   * 소수를 precision 자리로 자른다. micros는 statement마다 한 번 읽은 wallMicros 값이다.
   */
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
          if ((slot.col_type === 'datetime' || slot.col_type === 'date' || slot.col_type === 'time') && value !== null) {
            value = timeValue(value, slot.col_type, this.zone, slot.precision ?? 0);
          }
          if (slot.col_type === 'decimal' && value !== null) {
            if (typeof value !== 'string') throw new OrmError('CODEC_ENCODE', 'decimal bind requires exact text');
            value = this.driver === 'sqlite'
              ? decimalScaled(value, slot.precision ?? 0, slot.scale ?? 0)
              : normalizeDecimal(value, slot.precision ?? 0, slot.scale ?? 0);
          }
          if (slot.transform) {
            if (typeof value !== 'string') throw new OrmError('CONFIG', `${slot.transform} requires a string value`);
            value = transform(slot.transform, value);
          }
          if (slot.host_styles.includes('blind_index')) {
            if (value !== null) value = blindIndex(value, this.blindIndexKey);
          } else if (slot.host_styles.length > 0) value = hostEncode(value, slot.host_styles, this.aesKey);
          if (value instanceof Date) value = formatInstant(value, this.zone);
          push(value);
          break;
        }
        case 'audit':
          push(auditValue(slot, audit));
          break;
        case 'secret':
          if (slot.name !== 'aes' || this.aesKey === '') throw new OrmError('CONFIG', `secret ${slot.name} is not configured`);
          push(this.aesKey, SECRET);
          break;
        case 'config':
          if (slot.name !== 'aes_version') throw new OrmError('CONFIG', `config value ${slot.name} is not configured`);
          push(this.aesVersion);
          break;
        case 'parent':
          for (const value of parents) push(value);
          break;
        case 'now':
          // One statement reads the clock once, so its clock columns are equal.
          clock ??= wallMicros();
          push(this.now(clock, slot.precision ?? 6), NOW);
          break;
        default:
          throw new OrmError('INTERNAL', `bind from ${slot.from}`);
      }
    }
    return { values, masked };
  }

  public async execute(ex: Executor, cached: Cached, sql: string, step: PlanStep, params: readonly unknown[], parents: readonly unknown[] = []): Promise<DriverResult> {
    const { values, masked } = this.args(step, params, parents, ex.frame?.audit);
    const connection = ex.frame?.session ?? this.pool;
    // kind는 plan step이 쓰는 SQL의 동사이고 tables는 plan step의 table이다.
    return connection.execute(sql, values as DriverValue[], this.signal, this.statementDone(statementKind(step.sql), step.tables, ex.frame?.number ?? null, masked));
  }
}

/** error가 subscriber 실패(SUBSCRIBER)인지다. 그 statement는 효과를 냈다. */
function subscriberError(error: unknown): boolean {
  return error instanceof OrmError && error.code === 'SUBSCRIBER';
}

/** Marks the start of a statement on an executor; a transaction rejects concurrent use. */
async function guarded<T>(ex: Executor, work: () => Promise<T>): Promise<T> {
  const frame = ex.frame;
  if (frame === undefined) return work();
  if (frame.finished) throw new OrmError('CONFIG', 'transaction already finished');
  if (frame.busy) throw new OrmError('CONFIG', 'the transaction connection is already in use');
  frame.busy = true;
  try { return await work(); } finally { frame.busy = false; }
}

/**
 * The key of the transaction's audit record, bound to the audit column of an
 * audited table; a write without an audit, or whose table records its audits
 * in another table than the transaction's audit record, is CONFIG.
 */
function auditValue(slot: BindSlot, audit: AuditRecord | undefined): unknown {
  if (audit === undefined) throw new OrmError('CONFIG', 'a write of an audited table needs an audit: run it in a transaction with audit values');
  if (audit.table !== slot.name) {
    throw new OrmError('CONFIG', `the audited table records its audits in ${slot.name}, but the audit of the transaction is a row of ${audit.table}`);
  }
  return audit.key;
}

function transform(kind: string, value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  if (kind === 'like_contains') return `%${escaped}%`;
  if (kind === 'like_starts') return `${escaped}%`;
  if (kind === 'like_ends') return `%${escaped}`;
  return value;
}

function checkLock(ex: Executor, request: Request): void {
  if ((request.lock ?? '') !== '' && ex.frame === undefined) throw new OrmError('CONFIG', 'row locks are allowed only inside a transaction');
}

function driverLimit(driver: string): number { return driver === 'sqlite' ? 999 : 65535; }

export async function query(ex: Executor, request: Request, params: readonly unknown[]): Promise<Result> {
  return guarded(ex, async () => {
    checkLock(ex, request);
    const db = ex.db;
    const cached = await db.plan(request);
    if ((request.lock ?? '') !== '') await db.rowLock(ex.frame!, request.lock!);
    const parts = rootInParts(request, cached.plan, db.driver, params);
    let main: unknown[][];
    if (parts.length > 1) {
      main = [];
      const seen = new Set<string>();
      for (const part of parts) {
        const partPlan = await db.plan(part);
        const step = partPlan.plan.steps[0]!;
        for (const row of await select(ex, partPlan, step, params)) {
          const key = rowKey(row, step.assemble!.key) ?? '';
          if (!seen.has(key)) { seen.add(key); main.push(row); }
        }
      }
    } else main = await select(ex, cached, cached.plan.steps[0]!, params);
    return relations(ex, cached, params, main);
  });
}

async function relations(ex: Executor, cached: Cached, params: readonly unknown[], main: unknown[][]): Promise<Result> {
  const out: Result = { plan: cached.plan, main, steps: new Map(), params };
  for (const step of cached.plan.steps.slice(1)) {
    if (step.role !== 'relation') continue;
    const parents = step.parent!.step === 0 ? main : out.steps.get(step.parent!.step)?.data ?? [];
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
  const result = await ex.db.execute(ex, cached, sql, step, params, values);
  for (const row of result.rows) decodeAssembly(row, step.assemble!, ex.db);
  return result.rows;
}

function decodeAssembly(row: unknown[], assemble: Assemble, db: Db): void {
  let version = db.aesKeyring?.currentVersion ?? 1;
  if (assemble.aes_version !== undefined) {
    const at = row[assemble.columns[assemble.aes_version]!.index];
    if (at !== null) version = Number(at);
  }
  for (const column of assemble.columns) {
    let value = row[column.index];
    if (value === undefined || column.styles.length === 0) continue;
    const host = column.styles.filter(style => style === 'aes' || style === 'hex' || style === 'ip');
    const client = column.styles.filter(style => style !== 'aes' && style !== 'hex' && style !== 'ip');
    const key = host.includes('aes') ? db.aesKeyring?.key(version) ?? db.aesKey : db.aesKey;
    if (value !== null && host.length > 0) value = hostDecode(value as string | Uint8Array, host, key);
    if (client.length > 0) value = decode(client, value as string | Uint8Array | null);
    row[column.index] = value;
  }
  for (const child of assemble.children) if (child.kind === 'join' && child.assemble) decodeAssembly(row, child.assemble, db);
}

export async function scalar(ex: Executor, request: Request, params: readonly unknown[]): Promise<unknown> {
  return guarded(ex, async () => {
    checkLock(ex, request);
    const db = ex.db;
    const cached = await db.plan(request);
    const parts = rootInParts(request, cached.plan, db.driver, params);
    if (parts.length > 1) {
      if (request.kind !== 'count') throw new OrmError('IR_INVALID', 'a split IN list can be merged only for a count');
      let total = 0;
      for (const part of parts) {
        const partPlan = await db.plan(part);
        total += Number((await db.execute(ex, partPlan, partPlan.plan.steps[0]!.sql, partPlan.plan.steps[0]!, params)).rows[0]?.[0] ?? 0);
      }
      return total;
    }
    const step = cached.plan.steps[0]!;
    return (await db.execute(ex, cached, step.sql, step, params)).rows[0]?.[0] ?? null;
  });
}

export async function paginate(ex: Executor, request: Request, params: readonly unknown[]): Promise<{ result: Result; total: number }> {
  return guarded(ex, async () => {
    checkLock(ex, request);
    const db = ex.db;
    const cached = await db.plan(request);
    const main = await select(ex, cached, cached.plan.steps[0]!, params);
    const result = await relations(ex, cached, params, main);
    const step = cached.plan.steps.find(s => s.role === 'count');
    if (!step) throw new OrmError('INTERNAL', 'paginate plan has no count step');
    const total = Number((await db.execute(ex, cached, step.sql, step, params)).rows[0]?.[0] ?? 0);
    return { result, total };
  });
}

export async function write(ex: Executor, request: Request, params: readonly unknown[]): Promise<{ id: number | null; affected: number }> {
  return guarded(ex, async () => {
    const db = ex.db;
    const cached = await db.plan(request);
    const step = cached.plan.steps[0]!;
    const result = await db.execute(ex, cached, step.sql, step, params);
    if (request.kind === 'insert' && / RETURNING /.test(step.sql)) return { id: Number(result.rows[0]?.[0]), affected: 1 };
    if (request.kind === 'update' && request.optimistic && result.affected === 0) throw new OrmError('OPTIMISTIC_LOCK', 'the row changed after it was read');
    const id = request.kind === 'insert' && !request.rows && result.insertId !== null ? Number(result.insertId) : null;
    return { id, affected: result.affected };
  });
}

/** Returns the statement of a select request without executing it. */
export async function statement(ex: Executor, request: Request, params: readonly unknown[]): Promise<{ sql: string; binds: unknown[] }> {
  const cached = await ex.db.plan(request);
  const step = cached.plan.steps[0]!;
  return { sql: step.sql, binds: ex.db.args(step, params).masked };
}

function parentValues(step: PlanStep, parents: readonly unknown[][], params: readonly unknown[]): unknown[] {
  const ref = step.parent!;
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
  const width = step.parent!.keys.length;
  const nonParent = step.bind_slots.filter(slot => slot.from !== 'parent').length;
  const max = Math.floor((driverLimit(driver) - nonParent) / width);
  if (max < 1) throw new OrmError('IR_INVALID', `relation ${step.id} needs more bind parameters than ${driver} permits`);
  let size = 1;
  while (size * 2 <= max) size *= 2;
  const tuples = values.length / width;
  const out: unknown[][] = [];
  for (let start = 0; start < tuples; start += size) out.push(values.slice(start * width, Math.min(start + size, tuples) * width));
  return out;
}

function expandParent(step: PlanStep, source: readonly unknown[]): { sql: string; values: unknown[] } {
  const width = step.parent!.keys.length;
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
  throw new OrmError('INTERNAL', `relation step ${id} has no child`);
}

function itemConn(item: Group['items'][number]): string | undefined {
  return item.pred?.conn ?? item.group?.conn ?? item.joined?.conn;
}

/** Splits a root IN list joined with AND that exceeds the driver bind limit. */
function rootInParts(request: Request, plan: Plan, driver: string, params: readonly unknown[]): Request[] {
  const main = plan.steps[0]!;
  const limit = driverLimit(driver);
  if (main.bind_slots.length <= limit) return [request];
  const tooLarge = new OrmError('IR_INVALID', `the statement needs ${main.bind_slots.length} bind parameters but ${driver} permits ${limit}`);
  if (request.limit || request.order?.length || request.group_by?.length || request.group_by_expr?.length || !request.where) throw tooLarge;
  const items = request.where.items;
  let target = -1;
  items.forEach((item, i) => {
    if (!item.pred) return;
    if (item.pred.conn === 'or' || (i + 1 < items.length && itemConn(items[i + 1]!) === 'or')) throw tooLarge;
    if (item.pred.op === 'in' && !item.pred.sub && (target < 0 || (item.pred.ps?.length ?? 0) > (items[target]!.pred!.ps?.length ?? 0))) target = i;
  });
  if (target < 0) throw tooLarge;
  const ps = items[target]!.pred!.ps!;
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
    while (slice.length < n) slice.push(slice[slice.length - 1]!);
    part.where!.items[target]!.pred!.ps = slice;
    parts.push(part);
  }
  return parts;
}
