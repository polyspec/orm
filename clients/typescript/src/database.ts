import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { blindIndex, decode, hostDecode, hostEncode, parsePoint, pointText } from './codec.js';
import type { Assemble, Group, KeyReference, Plan, PlanStep, Request } from './ir.js';
import { offsetText, openDriver, parseDsn, zoneOffset, type DriverPool, type DriverResult, type DriverTransaction, type DriverValue, type Isolation, type PoolStats } from './driver.js';
import type { SchemaSet } from './names.js';
import { OrmError } from './runtime_error.js';
import { Utils } from './utils.js';
import { AesKeyring } from './aes.js';
import { Engine } from './engine/index.js';

export interface QueryEvent { sql: string; binds: readonly unknown[]; seconds: number; planId: string; error?: unknown; }

export interface ConnectOptions {
  aesKey?: string;
  blindIndexKey?: string;
  aesVersion?: number;
  aesKeys?: ReadonlyMap<number, string>;
  onQuery?: (event: QueryEvent) => void;
  planCacheSize?: number;
  statementCacheSize?: number;
  /** maximum open connections; zero uses the driver default */
  poolSize?: number;
  /** bound of every statement of the connection in milliseconds; zero keeps the server default */
  statementTimeoutMs?: number;
}

export interface TransactionOptions {
  isolation?: Isolation;
  readOnly?: boolean;
  timeoutMs?: number;
  /** Deadlock retries; the default is 3 and 0 disables retry. */
  retry?: number;
}

const schemas = new Map<string, SchemaSet>();

/** Called by generated model modules. */
export function registerSchema(set: SchemaSet): void { schemas.set(set.hash, set); }

export function registeredSchema(hash: string): SchemaSet | undefined { return schemas.get(hash); }

/** One active transaction. */
export class TxFrame {
  public busy = false;
  public finished = false;
  public savepoints = 0;
  public readonly locals = new Map<string, string>();
  public readonly locks: string[] = [];
  public contextRow = false;
  public constructor(public readonly db: Db, public readonly tx: DriverTransaction) {}
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

/** Formats an instant in a connection time zone as stored date-time text. */
export function formatInstant(instant: Date, zone: string): string {
  const shifted = new Date(instant.getTime() + zoneOffset(zone, instant) * 60_000);
  const micro = String(shifted.getUTCMilliseconds()).padStart(3, '0') + '000';
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}.${micro}`;
}

/** Normalizes stored date or time text to `YYYY-MM-DD HH:MM:SS.ffffff` in the connection zone. */
export function normalizeTime(value: unknown, zone: string): string {
  if (value instanceof Date) return formatInstant(value, zone);
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(text);
  if (!match) throw new OrmError('CODEC_DECODE', `invalid date-time value ${text}`);
  if (match[4] !== undefined) {
    const offset = match[4] === 'Z' ? 'Z' : match[4].length === 3 ? `${match[4]}:00` : match[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const instant = new Date(`${match[1]}T${match[2] ?? '00:00:00'}${match[3] ? `.${match[3].slice(0, 3)}` : ''}${offset}`);
    const base = formatInstant(instant, zone);
    return base.slice(0, 20) + (match[3] ?? '').padEnd(6, '0').slice(0, 6);
  }
  return `${match[1]} ${match[2] ?? '00:00:00'}.${(match[3] ?? '').padEnd(6, '0').slice(0, 6)}`;
}

const sqliteDateTimeText = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/;
const sqliteDateText = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalidTimeText(value: string, colType: string): OrmError {
  const form = colType === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:MM:SS[.ffffff][Z|±HH:MM]';
  return new OrmError('CODEC_ENCODE', `${colType} value ${JSON.stringify(value)} is not ${form}`);
}

function validDate(y: string, m: string, d: string, h = '00', mi = '00', sec = '00'): boolean {
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(sec)));
  return t.getUTCFullYear() === Number(y) && t.getUTCMonth() + 1 === Number(m) && t.getUTCDate() === Number(d)
    && t.getUTCHours() === Number(h) && t.getUTCMinutes() === Number(mi) && t.getUTCSeconds() === Number(sec);
}

/**
 * Writes a datetime or date value in the text form SQLite stores, so a string
 * value compares equal to the stored value. A datetime string with an offset
 * is converted to the connection time zone.
 */
export function sqliteTimeValue(value: unknown, colType: string, zone: string): unknown {
  if (value instanceof Date) return colType === 'date' ? formatInstant(value, zone).slice(0, 10) : value;
  if (typeof value !== 'string') return value;
  if (colType === 'date') {
    const m = sqliteDateText.exec(value);
    if (!m || !validDate(m[1]!, m[2]!, m[3]!)) throw invalidTimeText(value, colType);
    return value;
  }
  const m = sqliteDateTimeText.exec(value);
  if (!m || !validDate(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!)) throw invalidTimeText(value, colType);
  const fraction = (m[7] ?? '').padEnd(6, '0');
  const wall = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  if (m[8] === undefined) return `${wall}.${fraction}`;
  const sign = m[8] === 'Z' || m[8].startsWith('+') ? 1 : -1;
  const offset = m[8] === 'Z' ? 0 : sign * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4, 6)));
  const instant = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000);
  return `${formatInstant(instant, zone).slice(0, 19)}.${fraction}`;
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

/** A database connection with its schemas, plan cache, and statement cache. */
export class Db {
  // State every handle of one connection shares.
  private readonly shared = { closed: false };
  public readonly signal: AbortSignal | undefined = undefined;
  private readonly plans = new Map<string, Cached>();
  private readonly engines = new Map<string, Engine>();
  public readonly aesKey: string;
  public readonly blindIndexKey: string;
  public readonly aesVersion: number;
  public readonly aesKeyring: AesKeyring | undefined;
  public onQuery: ((event: QueryEvent) => void) | undefined;
  private readonly planCacheSize: number;

  private constructor(public readonly pool: DriverPool, public readonly zone: string, engine: Engine, options: ConnectOptions) {
    this.engines.set(engine.schemaHash, engine);
    this.aesKey = options.aesKey ?? '';
    this.blindIndexKey = options.blindIndexKey ?? '';
    this.aesVersion = options.aesVersion ?? 1;
    if (!Number.isSafeInteger(this.aesVersion) || this.aesVersion < 1) throw new OrmError('CONFIG', 'aes version must be a positive integer');
    const keys = options.aesKeys ?? (this.aesKey === '' ? undefined : new Map([[this.aesVersion, this.aesKey]]));
    this.aesKeyring = keys === undefined ? undefined : new AesKeyring(keys, this.aesVersion);
    this.onQuery = options.onQuery;
    this.planCacheSize = options.planCacheSize ?? 256;
    if (!Number.isSafeInteger(this.planCacheSize) || this.planCacheSize < 1) throw new OrmError('CONFIG', 'plan cache size must be a positive integer');
  }

  /**
   * Opens the database selected by the DSN URI scheme with the schema.json
   * the imported models were generated from.
   */
  public static async connect(dsn: string, schemaPath: string, options: ConnectOptions = {}): Promise<Db> {
    const parsed = parseDsn(dsn);
    const statementCacheSize = options.statementCacheSize ?? 256;
    if (!Number.isSafeInteger(statementCacheSize) || statementCacheSize < 1) throw new OrmError('CONFIG', 'statement cache size must be a positive integer');
    let text: string;
    try { text = await readFile(schemaPath, 'utf8'); } catch (error) { throw new OrmError('CONFIG', `read schema ${schemaPath}: ${(error as Error).message}`); }
    const engine = Engine.load(text, parsed.driver);
    if (!schemas.has(engine.schemaHash)) {
      throw new OrmError('SCHEMA_HASH_MISMATCH', `no imported models were generated from schema ${engine.schemaHash}: generate the models again`);
    }
    if ((options.poolSize ?? 0) < 0) throw new OrmError('CONFIG', 'pool size must not be negative');
    if ((options.statementTimeoutMs ?? 0) < 0) throw new OrmError('CONFIG', 'statement timeout must not be negative');
    const pool = openDriver(dsn, parsed, options.poolSize ?? 10, statementCacheSize, options.statementTimeoutMs ?? 0);
    const db = new Db(pool, parsed.zone, engine, options);
    try { await pool.execute('SELECT 1', []); } catch (error) { await pool.close(); throw error; }
    return db;
  }

  /** Adds an installed schema to the connection. */
  public registerEngine(engine: Engine): void {
    if (engine.dialect !== this.driver) throw new OrmError('CONFIG', `schema compiled for ${engine.dialect} on a ${this.driver} connection`);
    this.engines.set(engine.schemaHash, engine);
  }

  public get driver(): string { return this.pool.name; }

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
    const outer = activeFor(this);
    if (outer) {
      if (options.isolation !== undefined || options.readOnly !== undefined || options.timeoutMs !== undefined) {
        throw new OrmError('CONFIG', 'a nested transaction of the same connection accepts only the retry option');
      }
      return this.savepoint(outer, callback);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.run(callback, { isolation: options.isolation, readOnly: options.readOnly, timeoutMs });
      } catch (error) {
        if (!(error instanceof OrmError) || error.code !== 'DEADLOCK' || attempt >= retry) throw error;
        await new Promise(resolve => setTimeout(resolve, (50 << attempt) + Math.floor(Math.random() * 20)));
      }
    }
  }

  private async run<T>(callback: () => Promise<T> | T, options: { isolation?: Isolation; readOnly?: boolean; timeoutMs: number }): Promise<T> {
    if (this.closed) throw new OrmError('CONFIG', 'database is closed');
    const tx = await this.pool.begin(options);
    const frame = new TxFrame(this, tx);
    let result: T;
    try {
      result = await flow.run([...frames(), frame], callback);
    } catch (error) {
      await this.finish(frame, false).catch(() => undefined);
      throw error;
    }
    await this.finish(frame, true);
    return result;
  }

  private async finish(frame: TxFrame, commit: boolean): Promise<void> {
    if (frame.finished) return;
    frame.finished = true;
    try {
      for (const key of frame.locks) await frame.tx.control('SELECT RELEASE_LOCK(?)', [key]);
      if (this.driver === 'mysql') for (const key of frame.locals.keys()) await frame.tx.control(`SET @\`orm.${key}\` = NULL`);
      if (commit && frame.contextRow) await frame.tx.control('DELETE FROM "orm__context"');
    } catch (error) {
      await frame.tx.rollback();
      throw error;
    }
    if (commit) await frame.tx.commit();
    else await frame.tx.rollback();
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
        await frame.tx.control(`ROLLBACK TO SAVEPOINT ${name}`);
        await frame.tx.control(`RELEASE SAVEPOINT ${name}`);
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
    const engine = this.engines.get(request.schema_hash);
    if (engine === undefined) throw new OrmError('SCHEMA_HASH_MISMATCH', `the models use schema ${request.schema_hash}, which the connection has not loaded`);
    const plan = engine.compile(request);
    const entry = { plan, id: planId(key) };
    this.plans.set(key, entry);
    if (this.plans.size > this.planCacheSize) this.plans.delete(this.plans.keys().next().value as string);
    return entry;
  }

  /** The executor clock in the connection zone; PostgreSQL receives the offset because its columns store instants. */
  public now(): string {
    const instant = new Date();
    const text = formatInstant(instant, this.zone);
    return this.driver === 'postgres' ? text + offsetText(zoneOffset(this.zone, instant)) : text;
  }

  /** Resolves the bind slots of a step; masked marks secret and clock positions. */
  public args(step: PlanStep, params: readonly unknown[], parents: readonly unknown[] = []): { values: unknown[]; masked: unknown[] } {
    const values: unknown[] = [];
    const masked: unknown[] = [];
    const push = (value: unknown, mask?: string) => { values.push(value); masked.push(mask ?? value); };
    let clock: string | undefined;
    for (const slot of step.bind_slots) {
      switch (slot.from) {
        case 'param': {
          let value = params[slot.param];
          if (this.driver === 'sqlite' && (slot.col_type === 'datetime' || slot.col_type === 'date') && value !== null) {
            value = sqliteTimeValue(value, slot.col_type, this.zone);
          }
          if (slot.transform) {
            if (typeof value !== 'string') throw new OrmError('CONFIG', `${slot.transform} requires a string value`);
            value = transform(slot.transform, value);
          }
          if (slot.host_styles.includes('blind_index')) {
            if (value !== null) value = blindIndex(value, this.blindIndexKey);
          } else if (slot.host_styles.length > 0) value = hostEncode(value, slot.host_styles, this.aesKey);
          if (slot.col_type === 'point' && value !== null) {
            const [x, y] = parsePoint(value as string);
            value = this.driver === 'postgres' ? `(${pointText([x, y]).slice(6, -1).replace(' ', ',')})` : pointText([x, y]);
          }
          if (value instanceof Date) value = formatInstant(value, this.zone);
          push(value);
          break;
        }
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
          clock ??= this.now();
          push(clock, NOW);
          break;
        default:
          throw new OrmError('INTERNAL', `bind from ${slot.from}`);
      }
    }
    return { values, masked };
  }

  public async execute(ex: Executor, cached: Cached, sql: string, step: PlanStep, params: readonly unknown[], parents: readonly unknown[] = []): Promise<DriverResult> {
    const { values, masked } = this.args(step, params, parents);
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

function transform(kind: string, value: string): string {
  if (kind === 'fulltext_boolean') return value.trim() === '' ? '' : `+${value.trim().replaceAll(' ', ' +')}*`;
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
  for (const column of assemble.columns) if (column.hidden && column.column === 'aes_key_version' && row[column.index] !== null) version = Number(row[column.index]);
  for (const column of assemble.columns) {
    let value = row[column.index];
    if (value === null || value === undefined || column.styles.length === 0) continue;
    const host = column.styles.filter(style => style === 'aes' || style === 'hex' || style === 'ip');
    const app = column.styles.filter(style => style !== 'aes' && style !== 'hex' && style !== 'ip');
    const key = host.includes('aes') ? db.aesKeyring?.key(version) ?? db.aesKey : db.aesKey;
    if (host.length > 0) value = hostDecode(value as string | Uint8Array, host, key);
    if (app.length > 0) value = decode(app, value as string | Uint8Array);
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
