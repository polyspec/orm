import { AsyncLocalStorage } from 'node:async_hooks';
import { blindIndex, decode, hostDecode, hostEncode } from './codec.js';
import type { Assemble, BindSlot, Group, KeyReference, Plan, PlanStep, Request } from './ir.js';
import { openDriver, parseDsn, zoneOffset, type DriverName, type DriverPool, type DriverResult, type DriverTransaction, type DriverValue, type Isolation, type PoolStats } from './driver.js';
import { OrmError, joinedErrors, rollbackFailed } from './runtime_error.js';
import { Utils } from './utils.js';
import { wallMicros } from './clock.js';
import { AesKeyring } from './aes.js';
import { Engine } from './engine/index.js';
import { modelOfManifest, type RuntimeModel } from './engine/model.js';
import { decimalScaled, normalizeDecimal } from './decimal.js';

export interface QueryEvent { sql: string; binds: readonly unknown[]; seconds: number; planId: string; error?: unknown; }

export interface ConnectOptions {
  /** key of aesVersion for aes writes; absent takes aesKeys[aesVersion] */
  aesKey?: string;
  blindIndexKey?: string;
  aesVersion?: number;
  aesKeys?: ReadonlyMap<number, string>;
  onQuery?: (event: QueryEvent) => void;
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
}

/** An operation id: a safe integer for an i64 operation column, a string for a uuid one. */
export type OperationId = number | string;

export interface TransactionOptions {
  isolation?: Isolation;
  readOnly?: boolean;
  timeoutMs?: number;
  /** Deadlock retries; the default is 3 and 0 disables retry. */
  retry?: number;
  /**
   * The operation id of the unit of work: every insert and update of an
   * audited table inside the transaction writes it into the operation column.
   */
  operation?: OperationId;
}

const models = new Map<string, RuntimeModel>();

/**
 * Builds and registers the runtime model of a manifest text; generated model
 * modules call it once when they are imported. Registering the same manifest
 * again returns the registered model. A text that does not hash to
 * manifestHash fails with SCHEMA_HASH_MISMATCH before any statement, also when
 * that hash is already registered, and registers nothing.
 */
export function registerModel(manifestText: string, manifestHash: string): RuntimeModel {
  const registered = models.get(manifestHash);
  if (registered !== undefined && registered.manifestText === manifestText) return registered;
  // 이미 등록된 hash라도 다른 text는 자기 hash로 검사한다: 잘못된 text는 SCHEMA_INVALID,
  // 다른 hash로 가는 text는 SCHEMA_HASH_MISMATCH다.
  const model = modelOfManifest(manifestText, manifestHash);
  models.set(manifestHash, model);
  return model;
}

/** One active transaction. */
export class TxFrame {
  public busy = false;
  public finished = false;
  public savepoints = 0;
  public readonly locals = new Map<string, string>();
  public readonly locks: string[] = [];
  public constructor(public readonly db: Db, public readonly tx: DriverTransaction, public readonly operation: OperationId | undefined) {}
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
  private readonly shared = { closed: false, rollbackFault: false };
  public readonly signal: AbortSignal | undefined = undefined;
  private readonly plans = new Map<string, Cached>();
  private readonly engines = new Map<string, Engine>();
  public readonly aesKey: string;
  public readonly blindIndexKey: string;
  public readonly aesVersion: number;
  public readonly aesKeyring: AesKeyring | undefined;
  public onQuery: ((event: QueryEvent) => void) | undefined;
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
    this.onQuery = options.onQuery;
    this.planCacheSize = options.planCacheSize ?? 256;
    if (!Number.isSafeInteger(this.planCacheSize) || this.planCacheSize < 1) throw new OrmError('CONFIG', 'plan cache size must be a positive integer');
  }

  /**
   * Opens the database selected by the DSN URI scheme. A request names the
   * manifest its models were generated from; the imported models register it.
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
    try { await pool.execute('SELECT 1', []); } catch (error) { await pool.close(); throw error; }
    return db;
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
    const operation = options.operation;
    if (operation !== undefined && !Number.isSafeInteger(operation) && (typeof operation !== 'string' || operation === '')) {
      throw new OrmError('CONFIG', 'transaction operation must be a safe integer or a non-empty string');
    }
    const outer = activeFor(this);
    if (outer) {
      if (options.isolation !== undefined || options.readOnly !== undefined || options.timeoutMs !== undefined || operation !== undefined) {
        throw new OrmError('CONFIG', 'a nested transaction of the same connection accepts only the retry option');
      }
      return this.savepoint(outer, callback);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.run(callback, { isolation: options.isolation, readOnly: options.readOnly, timeoutMs }, operation);
      } catch (error) {
        if (!(error instanceof OrmError) || error.code !== 'DEADLOCK' || attempt >= retry) throw error;
        await new Promise(resolve => setTimeout(resolve, (50 << attempt) + Math.floor(Math.random() * 20)));
      }
    }
  }

  private async run<T>(callback: () => Promise<T> | T, options: { isolation?: Isolation; readOnly?: boolean; timeoutMs: number }, operation: OperationId | undefined): Promise<T> {
    if (this.closed) throw new OrmError('CONFIG', 'database is closed');
    const tx = await this.pool.begin(options);
    const frame = new TxFrame(this, tx, operation);
    let result: T;
    try {
      result = await flow.run([...frames(), frame], callback);
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
   * transaction을 끝낸다. 끝내기 전에 MySQL named lock을 풀고 MySQL local 값을 지운다. 이 상태는
   * COMMIT과 ROLLBACK 뒤에도 connection에 남으므로 모든 단계를 시도하고 실패를 모두 보고한다.
   * cleanup이 실패한 commit은 rollback하고 cleanup 오류를 던진다.
   */
  private async finish(frame: TxFrame, commit: boolean): Promise<void> {
    if (frame.finished) return;
    frame.finished = true;
    const errors: unknown[] = [];
    for (const key of frame.locks.splice(0)) {
      try {
        const released = (await frame.tx.control('SELECT RELEASE_LOCK(?)', [key])).rows[0]?.[0];
        // 1이 아니면 이 connection이 lock을 갖고 있지 않았다.
        if (Number(released) !== 1) errors.push(new OrmError('CONFIG', `lock ${key} was not held at transaction end`));
      } catch (error) { errors.push(error); }
    }
    if (this.driver === 'mysql') {
      for (const key of frame.locals.keys()) {
        try { await frame.tx.control(`SET @\`orm.${key}\` = NULL`); } catch (error) { errors.push(error); }
      }
    }
    const failure = joinedErrors(errors);
    if (commit && failure === undefined) {
      await frame.tx.commit();
      return;
    }
    try {
      await frame.tx.rollback();
    } catch (rollback) {
      if (commit) throw rollbackFailed(failure, rollback);
      throw joinedErrors(failure === undefined ? [rollback] : [failure, rollback]);
    }
    if (failure !== undefined) throw failure;
  }

  private async savepoint<T>(frame: TxFrame, callback: () => Promise<T> | T): Promise<T> {
    frame.savepoints++;
    const name = `orm_sp_${frame.savepoints}`;
    try {
      await frame.tx.control(`SAVEPOINT ${name}`);
      let result: T;
      try {
        result = await flow.run([...frames(), frame], callback);
      } catch (error) {
        // savepoint 뒤의 작업을 되돌리고 savepoint를 푸는 두 statement를 모두 시도한다.
        const errors: unknown[] = [];
        for (const statement of [`ROLLBACK TO SAVEPOINT ${name}`, `RELEASE SAVEPOINT ${name}`]) {
          try { await frame.tx.control(statement); } catch (failure) { errors.push(failure); }
        }
        if (errors.length > 0) throw rollbackFailed(error, joinedErrors(errors));
        throw error;
      }
      await frame.tx.control(`RELEASE SAVEPOINT ${name}`);
      return result;
    } finally {
      frame.savepoints--;
    }
  }

  public async plan(request: Request): Promise<Cached> {
    if (this.closed) throw new OrmError('CONFIG', 'database is closed');
    const key = canonical(request);
    const cached = this.plans.get(key);
    if (cached) return cached;
    let engine = this.engines.get(request.manifest_hash);
    if (engine === undefined) {
      const model = models.get(request.manifest_hash);
      if (model === undefined) throw new OrmError('SCHEMA_HASH_MISMATCH', `no imported models were generated from manifest ${request.manifest_hash}`);
      engine = new Engine(model, this.driver);
      this.engines.set(request.manifest_hash, engine);
    }
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
  public args(step: PlanStep, params: readonly unknown[], parents: readonly unknown[] = [], operation?: OperationId): { values: unknown[]; masked: unknown[] } {
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
        case 'operation':
          push(operationValue(slot, operation));
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
    const { values, masked } = this.args(step, params, parents, ex.frame?.operation);
    const started = performance.now();
    const connection = ex.frame?.tx ?? this.pool;
    try {
      const result = await connection.execute(sql, values as DriverValue[], this.signal);
      this.onQuery?.({ sql, binds: masked, seconds: (performance.now() - started) / 1000, planId: cached.id });
      return result;
    } catch (error) {
      this.onQuery?.({ sql, binds: masked, seconds: (performance.now() - started) / 1000, planId: cached.id, error });
      throw error;
    }
  }
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
 * The operation id bound to the operation column of an audited table; a write
 * without an operation id, or with one of another type than the column, is
 * CONFIG.
 */
function operationValue(slot: BindSlot, operation: OperationId | undefined): OperationId {
  if (operation === undefined) {
    throw new OrmError('CONFIG', `${slot.name} is audited: run the write in a transaction with an operation id`);
  }
  if (slot.col_type === 'uuid' ? typeof operation !== 'string' : !Number.isSafeInteger(operation)) {
    throw new OrmError('CONFIG', `the operation column ${slot.name}.${slot.column} (${slot.col_type}) does not take the operation id ${JSON.stringify(operation)}`);
  }
  return operation;
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
    if ((request.lock ?? '') !== '') await ex.frame!.tx.rowLock(request.lock!);
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
