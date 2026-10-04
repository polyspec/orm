import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, isIP } from 'node:net';
import mysql, { type Pool as MySqlPool, type PoolConnection as MySqlConnection } from 'mysql2/promise';
import pg from 'pg';
import { OrmError } from './runtime_error.js';

pg.types.setTypeParser(20, value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new OrmError('CODEC_DECODE', `postgres int8 is outside the TypeScript safe integer range: ${value}`);
  return parsed;
});
pg.types.setTypeParser(1700, value => value);
pg.types.setTypeParser(1082, value => value);
pg.types.setTypeParser(1114, value => value);
pg.types.setTypeParser(1184, value => value);
pg.types.setTypeParser(114, value => value);
pg.types.setTypeParser(3802, value => value);

export type DriverName = 'mysql' | 'postgres' | 'sqlite';
export type Isolation = 'read_uncommitted' | 'read_committed' | 'repeatable_read' | 'serializable';
export type DriverValue = null | boolean | number | string | bigint | Uint8Array;

export interface DriverResult {
  rows: unknown[][];
  affected: number;
  insertId: number | bigint | string | null;
}

export interface PoolStats { maxOpenConnections: number; openConnections: number; inUse: number; idle: number; }

/**
 * driver가 보낸 statement의 출처다. statement는 호출자가 보낸 statement, deallocate는 PostgreSQL이
 * statement cache에서 밀어낸 prepared statement를 푸는 statement, kill은 MySQL이 다른 연결에서
 * 실행 중인 statement를 멈추는 statement다.
 */
export type SentOrigin = 'statement' | 'deallocate' | 'kill';

/**
 * driver가 statement 하나의 결과를 읽었거나 statement가 실패했을 때 부른다. elapsed는 statement를
 * 보낸 때부터의 초이고 error는 statement의 오류다. 던진 오류는 operation의 오류가 된다.
 */
export type StatementDone = (sql: string, elapsed: number, error: OrmError | null, origin: SentOrigin) => void;

/** statement를 보내지만 event를 publish하지 않는 done이다. 연결을 여는 statement가 쓴다. */
export const unobserved: StatementDone = () => undefined;

/** A connection pool or one reserved connection. */
export interface DriverConnection {
  readonly name: DriverName;
  /** Runs one prepared statement; an aborted signal cancels it and raises CANCELED. */
  execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult>;
}

export interface DriverPool extends DriverConnection {
  /**
   * 연결 하나를 잡는다. transaction과, transaction 밖에서 한 연결로 실행해야 하는 statement(MySQL
   * schema statement와 그것이 읽는 catalog, foreign key를 끄는 SQLite statement)가 쓴다.
   */
  reserve(): Promise<DriverSession>;
  stats(): PoolStats;
  close(): Promise<void>;
}

/** 잡아 둔 연결 하나다. 끝나면 release로 돌려준다. */
export interface DriverSession extends DriverConnection {
  /** Runs a statement that is not prepared (transaction control, savepoints, locks, session values, schema statements). */
  control(sql: string, params: readonly DriverValue[], done: StatementDone): Promise<DriverResult>;
  /** SQLite 연결이 transaction 안에 있는지다. 다른 driver는 알리지 않는다. */
  inTransaction?(): boolean;
  /**
   * 연결을 돌려준다. discard면 pool에 돌려주지 않고 닫아 server가 그 session을 끝내게 한다. SQLite의
   * 하나뿐인 연결은 닫지 않는다.
   */
  release(discard: boolean): void;
}

function seconds(started: number): number { return (performance.now() - started) / 1000; }

/**
 * work가 보내는 statement 하나를 실행하고, 결과를 읽었거나 실패했을 때 done을 부른다. 실패는
 * driver 오류로 바꾸어 done에 주고 던진다.
 */
async function observed<T>(name: DriverName, sql: string, done: StatementDone, origin: SentOrigin, work: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  let result: T;
  try {
    result = await work();
  } catch (error) {
    const mapped = driverError(name, error);
    done(sql, seconds(started), mapped, origin);
    throw mapped;
  }
  done(sql, seconds(started), null, origin);
  return result;
}

/** Milliseconds a SQLite connection waits for a lock when the DSN sets no _pragma=busy_timeout(ms). */
const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Reports SQLITE_BUSY or one of its extended codes. */
export function sqliteBusy(name: DriverName, error: unknown): boolean {
  return name === 'sqlite' && (Number((error as { errcode?: number }).errcode) & 0xff) === 5;
}

function driverError(name: DriverName, error: unknown): OrmError {
  if (error instanceof OrmError) return error;
  const source = error as { code?: string; errcode?: number; message?: string };
  const message = source.message ?? String(error);
  const lockNotAvailable = source.code === 'ER_LOCK_NOWAIT' || source.errcode === 3572 || source.code === '55P03';
  // MySQL 1317/3024, PostgreSQL 57014, and SQLite 9 all report a statement
  // that was stopped before it finished; SQLite BUSY reports a lock that
  // another connection still held when busy_timeout ended.
  if (source.code === 'ER_QUERY_INTERRUPTED' || source.code === 'ER_QUERY_TIMEOUT' || source.code === '57014' || source.errcode === 9 || sqliteBusy(name, error)) {
    return new OrmError('CANCELED', `${name}: ${message}`, error);
  }
  const duplicate = source.code === 'ER_DUP_ENTRY' || source.code === '23505' || source.errcode === 2067 || source.errcode === 1555;
  const foreignKey = source.code === 'ER_NO_REFERENCED_ROW_2' || source.code === 'ER_ROW_IS_REFERENCED_2' || source.code === '23503' || source.errcode === 787 ||
    // SQLite는 RESTRICT action의 FK 위반을 CONSTRAINT_TRIGGER(1811)로 보고한다. trigger RAISE의 1811은 DRIVER다.
    (source.errcode === 1811 && message.includes('FOREIGN KEY constraint failed'));
  const deadlock = source.code === 'ER_LOCK_DEADLOCK' || source.code === '40P01' || source.code === '40001' || source.errcode === 6 || source.errcode === 262;
  // MySQL 1290/1792, PostgreSQL 25006, and SQLite READONLY (8) with its
  // extended codes report a write the read-only server or connection rejects.
  const readOnly = source.code === 'ER_OPTION_PREVENTS_STATEMENT' || source.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' || source.code === '25006' || (typeof source.errcode === 'number' && (source.errcode & 0xff) === 8);
  // MySQL 3819/4025, PostgreSQL 23514, and SQLite CONSTRAINT_CHECK (275) report a CHECK violation.
  const constraint = source.code === 'ER_CHECK_CONSTRAINT_VIOLATED' || source.code === 'ER_CONSTRAINT_FAILED' || source.code === '23514' || source.errcode === 275;
  // Every other driver error, such as a write that a trigger refuses, is DRIVER.
  const code = lockNotAvailable ? 'LOCK_NOT_AVAILABLE' : duplicate ? 'DUPLICATE_KEY' : foreignKey ? 'FOREIGN_KEY' : deadlock ? 'DEADLOCK' : readOnly ? 'READ_ONLY' : constraint ? 'CONSTRAINT' : 'DRIVER';
  return new OrmError(code, `${name}: ${message}`, error);
}

/** The error of a statement the caller cancelled. */
function canceled(name: DriverName): OrmError {
  return new OrmError('CANCELED', `${name}: the statement was cancelled`);
}

/**
 * Awaits work while signal is watched: an abort asks the database to stop the
 * statement with stop, and the statement itself ends with CANCELED.
 */
async function cancellable<T>(name: DriverName, signal: AbortSignal, stop: () => Promise<void>, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    await work.catch(() => undefined);
    throw canceled(name);
  }
  // 멈추는 statement의 실패는 statement의 CANCELED가 보고하므로 버린다. 그 event의 subscriber
  // 실패(SUBSCRIBER)만 statement가 끝난 뒤 operation의 오류로 던진다.
  let stopping: Promise<unknown> | undefined;
  const abort = () => { stopping = stop().then(() => undefined, (error: unknown) => error); };
  signal.addEventListener('abort', abort, { once: true });
  let result: T;
  try {
    result = await work;
  } catch (error) {
    await subscriberFailure(stopping);
    if (signal.aborted) throw error instanceof OrmError && error.code === 'CANCELED' ? error : canceled(name);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
  await subscriberFailure(stopping);
  return result;
}

/** 멈추는 statement의 subscriber가 실패했으면 그 SUBSCRIBER 오류를 던진다. */
async function subscriberFailure(stopping: Promise<unknown> | undefined): Promise<void> {
  if (stopping === undefined) return;
  const error = await stopping;
  if (error instanceof OrmError && error.code === 'SUBSCRIBER') throw error;
}

export function isolationSql(isolation: Isolation): string {
  if (!['read_uncommitted', 'read_committed', 'repeatable_read', 'serializable'].includes(isolation)) throw new OrmError('CONFIG', `unsupported transaction isolation ${isolation}`);
  return isolation.replaceAll('_', ' ').toUpperCase();
}

async function mysqlExecute(connection: MySqlPool | MySqlConnection, sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
  const [value] = await connection.execute({ sql, rowsAsArray: true }, [...params]);
  if (Array.isArray(value)) return { rows: value as unknown[][], affected: 0, insertId: null };
  const result = value as { affectedRows: number; insertId: number };
  return { rows: [], affected: result.affectedRows, insertId: result.insertId || null };
}

async function mysqlControl(connection: MySqlConnection, sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
  const [value] = await connection.query({ sql, rowsAsArray: true }, [...params]);
  if (Array.isArray(value)) return { rows: value as unknown[][], affected: 0, insertId: null };
  return { rows: [], affected: (value as { affectedRows: number }).affectedRows, insertId: null };
}

/** Stops the statement running on connection from another connection of the pool. */
async function mysqlKill(pool: MySqlPool, connection: MySqlConnection, done: StatementDone): Promise<void> {
  const id = (connection as unknown as { threadId: number }).threadId;
  const sql = `KILL QUERY ${Number(id)}`;
  await observed('mysql', sql, done, 'kill', () => pool.query(sql));
}

/** The failure of the session setup that runs on each new MySQL connection. */
interface SessionSetup { error?: unknown; }

function sessionError(setup: SessionSetup): OrmError | undefined {
  const error = setup.error as { errno?: number; sqlMessage?: string; message?: string } | undefined;
  if (error === undefined) return undefined;
  return driverError('mysql', error);
}

class MySqlPoolDriver implements DriverPool {
  public readonly name = 'mysql' as const;
  public constructor(private readonly pool: MySqlPool, private readonly setup: SessionSetup, private readonly maxOpen: number) {}
  // The session setup is queued ahead of the statement on the same
  // connection, so its outcome is known when the statement settles.
  private checked<T>(result: Promise<T>): Promise<T> {
    return result.then(
      value => { const failure = sessionError(this.setup); if (failure) throw failure; return value; },
      error => { throw sessionError(this.setup) ?? error; },
    );
  }
  public async execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    if (signal === undefined) return observed(this.name, sql, done, 'statement', () => this.checked(mysqlExecute(this.pool, sql, params)));
    // A cancellable statement holds its own connection, so KILL QUERY names
    // the thread that runs it.
    let connection: MySqlConnection;
    try { connection = await this.checked(this.pool.getConnection()); } catch (error) { throw driverError(this.name, error); }
    try {
      return await cancellable(this.name, signal, () => mysqlKill(this.pool, connection, done),
        observed(this.name, sql, done, 'statement', () => this.checked(mysqlExecute(connection, sql, params))));
    } finally {
      connection.release();
    }
  }
  public async reserve(): Promise<DriverSession> {
    let connection: MySqlConnection;
    try { connection = await this.checked(this.pool.getConnection()); } catch (error) { throw driverError(this.name, error); }
    return new MySqlSession(connection, this.pool);
  }
  public stats(): PoolStats {
    const inner = (this.pool as unknown as { pool: { _allConnections: { length: number }; _freeConnections: { length: number } } }).pool;
    const open = inner._allConnections.length;
    const idle = inner._freeConnections.length;
    return { maxOpenConnections: this.maxOpen, openConnections: open, inUse: open - idle, idle };
  }
  public async close(): Promise<void> { await this.pool.end(); }
}

class MySqlSession implements DriverSession {
  public readonly name = 'mysql' as const;
  public constructor(private readonly connection: MySqlConnection, private readonly pool: MySqlPool) {}
  public execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    const work = observed(this.name, sql, done, 'statement', () => mysqlExecute(this.connection, sql, params));
    return signal === undefined ? work : cancellable(this.name, signal, () => mysqlKill(this.pool, this.connection, done), work);
  }
  public control(sql: string, params: readonly DriverValue[], done: StatementDone): Promise<DriverResult> {
    return observed(this.name, sql, done, 'statement', () => mysqlControl(this.connection, sql, params));
  }
  public release(discard: boolean): void {
    if (discard) this.connection.destroy();
    else this.connection.release();
  }
}

class StatementNames {
  private readonly names = new Map<string, string>();
  public constructor(private readonly limit: number) {}
  public name(sql: string): { name: string; evicted?: string } {
    const existing = this.names.get(sql);
    if (existing !== undefined) {
      this.names.delete(sql);
      this.names.set(sql, existing);
      return { name: existing };
    }
    // PostgreSQL limits statement names to 63 bytes.
    const name = `orm_${createHash('sha256').update(sql).digest('hex').slice(0, 59)}`;
    this.names.set(sql, name);
    if (this.names.size <= this.limit) return { name };
    const oldest = this.names.entries().next().value as [string, string];
    this.names.delete(oldest[0]);
    return { name, evicted: oldest[1] };
  }
}

const statementCaches = new WeakMap<object, StatementNames>();

/**
 * prepared statement를 실행한다. statement cache가 밀어낸 prepared statement는 statement의 결과를 읽은
 * 뒤 같은 연결에서 DEALLOCATE로 푼다. 그 statement는 statement 다음의 event다.
 */
async function pgExecute(client: pg.PoolClient, sql: string, params: readonly DriverValue[], cacheSize: number, done: StatementDone): Promise<DriverResult> {
  let cache = statementCaches.get(client);
  if (cache === undefined) {
    cache = new StatementNames(cacheSize);
    statementCaches.set(client, cache);
  }
  const { name, evicted } = cache.name(sql);
  const result = await observed('postgres', sql, done, 'statement', () => client.query({ name, text: sql, values: [...params], rowMode: 'array' }));
  if (evicted !== undefined) {
    const deallocate = `DEALLOCATE "${evicted}"`;
    await observed('postgres', deallocate, done, 'deallocate', () => client.query(deallocate));
  }
  return { rows: result.rows as unknown[][], affected: result.rowCount ?? 0, insertId: (result.rows[0] as unknown[] | undefined)?.[0] as DriverResult['insertId'] ?? null };
}

/**
 * Sends the protocol cancel request for the statement of a client: the
 * process id and secret key the server sent the client at startup, on a
 * socket of its own so a busy pool cannot hold it up. A pooler maps the pair
 * to the server connection that runs the statement.
 */
function pgCancel(config: pg.PoolConfig, client: pg.PoolClient): Promise<void> {
  const key = client as unknown as { processID: number | null; secretKey: number | null };
  if (key.processID === null || key.secretKey === null) return Promise.resolve();
  const target = new pg.Client(config as pg.ClientConfig) as unknown as { host: string; port: number };
  const request = Buffer.alloc(16);
  request.writeInt32BE(16, 0);
  request.writeInt32BE(80877102, 4);
  request.writeInt32BE(key.processID, 8);
  request.writeInt32BE(key.secretKey, 12);
  return new Promise((resolve, reject) => {
    const socket = target.host.startsWith('/') ? netConnect(`${target.host}/.s.PGSQL.${target.port}`) : netConnect(target.port, target.host);
    socket.once('error', reject);
    socket.once('connect', () => socket.end(request));
    // The server closes the socket after it has handled the request.
    socket.once('close', () => resolve());
  });
}

class PostgresPoolDriver implements DriverPool {
  public readonly name = 'postgres' as const;
  public constructor(private readonly pool: pg.Pool, private readonly cacheSize: number, private readonly maxOpen: number, private readonly idleSize: number, private readonly config: pg.PoolConfig) {
    // The server can end a connection while it waits in the pool (pg_terminate_backend, DROP
    // DATABASE ... WITH (FORCE), a server shutdown) or while the pool closes it. pg removes that
    // connection from the pool and reports the server's message as an 'error' event of the pool;
    // no statement runs on it, so no caller receives the error, and the next statement opens a
    // new connection. Without a listener the event would end the calling process.
    pool.on('error', () => {});
  }
  /** Returns client to the pool, or closes it when it failed or the pool already keeps idleSize idle connections. */
  private release(client: pg.PoolClient, failed = false): void {
    client.release(failed || this.pool.idleCount >= this.idleSize);
  }
  public async execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    let client: pg.PoolClient;
    try { client = await this.pool.connect(); } catch (error) { throw driverError(this.name, error); }
    try {
      const work = pgExecute(client, sql, params, this.cacheSize, done);
      return await (signal === undefined ? work : cancellable(this.name, signal, () => pgCancel(this.config, client), work));
    } finally { this.release(client); }
  }
  public async reserve(): Promise<DriverSession> {
    let client: pg.PoolClient;
    try { client = await this.pool.connect(); } catch (error) { throw driverError(this.name, error); }
    return new PostgresSession(client, this.cacheSize, this.config, failed => this.release(client, failed));
  }
  public stats(): PoolStats {
    return { maxOpenConnections: this.maxOpen, openConnections: this.pool.totalCount, inUse: this.pool.totalCount - this.pool.idleCount, idle: this.pool.idleCount };
  }
  public async close(): Promise<void> { await this.pool.end(); }
}

class PostgresSession implements DriverSession {
  public readonly name = 'postgres' as const;
  /** The connection error the server reported between statements, such as the end of its session. */
  private failure: unknown;
  private readonly onError = (error: unknown) => { this.failure = error; };
  public constructor(private readonly client: pg.PoolClient, private readonly cacheSize: number, private readonly config: pg.PoolConfig, private readonly done: (failed: boolean) => void) {
    // A checked-out client reports a connection error between statements as an event; the next statement then fails.
    client.on('error', this.onError);
  }
  public release(discard: boolean): void {
    this.client.removeListener('error', this.onError);
    this.done(discard || this.failure !== undefined);
  }
  public execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    const work = pgExecute(this.client, sql, params, this.cacheSize, done);
    return signal === undefined ? work : cancellable(this.name, signal, () => pgCancel(this.config, this.client), work);
  }
  public async control(sql: string, params: readonly DriverValue[], done: StatementDone): Promise<DriverResult> {
    const result = await observed(this.name, sql, done, 'statement', () => this.client.query({ text: sql, values: [...params], rowMode: 'array' }));
    return { rows: result.rows as unknown[][], affected: result.rowCount ?? 0, insertId: null };
  }
}

class SqliteState {
  public busy = false;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  public constructor(public readonly db: DatabaseSync, private readonly cacheSize: number) {}
  public statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    const existing = this.statements.get(sql);
    if (existing !== undefined) return existing;
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    this.statements.set(sql, statement);
    if (this.statements.size > this.cacheSize) this.statements.delete(this.statements.keys().next().value as string);
    return statement;
  }
}

function sqliteExecute(state: SqliteState, sql: string, params: readonly DriverValue[]): DriverResult {
  const statement = state.statement(sql);
  const values = params.map(value => typeof value === 'boolean' ? Number(value) : value) as Array<null | number | string | bigint | Uint8Array>;
  if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
    statement.setReturnArrays(true);
    const rows = statement.all(...values) as unknown as unknown[][];
    return { rows, affected: rows.length, insertId: rows[0]?.[0] as DriverResult['insertId'] ?? null };
  }
  const result = statement.run(...values);
  return { rows: [], affected: Number(result.changes), insertId: result.lastInsertRowid };
}

class SqlitePoolDriver implements DriverPool {
  public readonly name = 'sqlite' as const;
  private readonly state: SqliteState;
  private waiters: Array<() => void> = [];
  public constructor(db: DatabaseSync, cacheSize: number) { this.state = new SqliteState(db, cacheSize); }
  public async execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    await this.idle();
    // node:sqlite runs a statement to its end without yielding, so the signal
    // is read before the statement starts.
    if (signal?.aborted) throw canceled(this.name);
    return observed(this.name, sql, done, 'statement', () => sqliteExecute(this.state, sql, params));
  }
  /** transaction이나 session이 쓰지 않을 때 하나뿐인 SQLite 연결을 잡는다. */
  public async reserve(): Promise<DriverSession> {
    await this.idle();
    this.state.busy = true;
    return new SqliteSession(this.state, () => this.release());
  }
  /** Waits until no session holds the single SQLite connection. */
  private async idle(): Promise<void> {
    while (this.state.busy) await new Promise<void>(resolve => this.waiters.push(resolve));
  }
  private release(): void {
    this.state.busy = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
  public stats(): PoolStats { return { maxOpenConnections: 1, openConnections: 1, inUse: this.state.busy ? 1 : 0, idle: this.state.busy ? 0 : 1 }; }
  public async close(): Promise<void> { this.state.db.close(); }
}

class SqliteSession implements DriverSession {
  public readonly name = 'sqlite' as const;
  private released = false;
  public constructor(private readonly state: SqliteState, private readonly done: () => void) {}
  public async execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    if (signal?.aborted) throw canceled(this.name);
    return observed(this.name, sql, done, 'statement', () => sqliteExecute(this.state, sql, params));
  }
  public control(sql: string, params: readonly DriverValue[], done: StatementDone): Promise<DriverResult> {
    return observed(this.name, sql, done, 'statement', () => sqliteExecute(this.state, sql, params));
  }
  public inTransaction(): boolean { return this.state.db.isTransaction; }
  public release(): void {
    if (this.released) return;
    this.released = true;
    this.done();
  }
}

export interface ParsedDsn { driver: DriverName; zone: string; sslCa?: string; }

/** scheme마다 DSN이 받는 parameter다(docs/config.md). 다른 parameter는 CONFIG다. */
const DSN_PARAMETERS: Record<string, readonly string[]> = {
  'mysql:': ['timezone', 'socket', 'ssl-mode', 'ssl-ca'],
  'postgres:': ['timezone', 'host', 'sslmode'],
  'sqlite:': ['timezone', '_pragma', '_txlock'],
};

/**
 * MySQL TLS parameter를 검사한다: `ssl-ca`에 CA file의 절대 경로를 둔
 * `ssl-mode=VERIFY_IDENTITY`로 TCP 연결하거나, 둘 다 없다. CA 경로나 undefined를 돌려준다.
 */
function mysqlTls(url: URL): string | undefined {
  const mode = url.searchParams.get('ssl-mode');
  const ca = url.searchParams.get('ssl-ca');
  if (mode === null && ca === null) return undefined;
  if (mode !== 'VERIFY_IDENTITY') throw new OrmError('CONFIG', `mysql DSN ssl-mode ${JSON.stringify(mode)} is not supported; the TLS mode is ssl-mode=VERIFY_IDENTITY with ssl-ca`);
  if (ca === null || ca === '') throw new OrmError('CONFIG', 'mysql DSN ssl-mode=VERIFY_IDENTITY needs ssl-ca, the absolute path of the CA file');
  if (!ca.startsWith('/')) throw new OrmError('CONFIG', `mysql DSN ssl-ca ${ca} is not an absolute path`);
  if (url.searchParams.has('socket')) throw new OrmError('CONFIG', 'mysql DSN ssl-mode connects over TCP and does not accept socket');
  // identity 검사는 host 이름을 인증서와 비교한다. driver는 IP 주소 host를 이름 localhost와 비교한다.
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) throw new OrmError('CONFIG', `mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address ${url.hostname}`);
  return ca;
}

/**
 * ssl-mode=VERIFY_IDENTITY의 mysql2 TLS option이거나 undefined다: `ssl-ca`의 CA, 그 CA가
 * 서명하지 않은 인증서의 거부, host 이름 검사다.
 */
export function mysqlSsl(parsed: ParsedDsn): { ca: string; rejectUnauthorized: true; verifyIdentity: true } | undefined {
  if (parsed.sslCa === undefined) return undefined;
  try { return { ca: readFileSync(parsed.sslCa, 'utf8'), rejectUnauthorized: true, verifyIdentity: true }; } catch (error) {
    throw new OrmError('CONFIG', `mysql DSN ssl-ca ${parsed.sslCa} cannot be read: ${(error as Error).message}`, error);
  }
}

/**
 * Splits a DSN URI into the dialect and the connection time zone. Every
 * connection reads and writes datetime values in UTC (docs/dialects.md "Date
 * and time"), so the timezone parameter accepts only UTC or +00:00.
 */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try { url = new URL(dsn); } catch { throw new OrmError('CONFIG', 'dsn must be a URI using mysql://, postgres://, or sqlite://'); }
  const accepted = DSN_PARAMETERS[url.protocol];
  if (accepted !== undefined) {
    for (const name of url.searchParams.keys()) {
      if (!accepted.includes(name)) throw new OrmError('CONFIG', `${url.protocol.replace(/:$/, '')} DSN has the unknown parameter ${name}; it accepts ${accepted.join(', ')}`);
    }
  }
  const requested = url.searchParams.get('timezone');
  if (requested !== null && requested !== 'UTC' && requested !== '+00:00') throw new OrmError('CONFIG', `dsn timezone ${requested}: every connection reads and writes datetime values in UTC`);
  const zone = '+00:00';
  switch (url.protocol) {
    case 'mysql:': {
      if (url.hostname === '' || url.pathname.replace(/\//g, '') === '') throw new OrmError('CONFIG', 'mysql DSN must include host and database');
      const sslCa = mysqlTls(url);
      return sslCa === undefined ? { driver: 'mysql', zone } : { driver: 'mysql', zone, sslCa };
    }
    case 'postgres:':
      if ((url.hostname === '' && !url.searchParams.has('host')) || url.pathname.replace(/\//g, '') === '') throw new OrmError('CONFIG', 'postgres DSN must include host and database');
      return { driver: 'postgres', zone };
    case 'sqlite:':
      if (url.hostname !== '' || !url.pathname.startsWith('/') || url.pathname === '/') throw new OrmError('CONFIG', 'sqlite DSN must include an absolute database path');
      if (url.searchParams.has('_txlock')) throw new OrmError('CONFIG', 'sqlite DSN does not accept _txlock; write transactions begin with BEGIN IMMEDIATE');
      sqlitePath(url);
      return { driver: 'sqlite', zone };
  }
  throw new OrmError('CONFIG', `unsupported DSN scheme ${url.protocol.replace(/:$/, '')}; want mysql, postgres, or sqlite`);
}

/**
 * Returns the percent-decoded path of a sqlite:// DSN. An invalid escape, a
 * path that is not UTF-8 after decoding and a NUL byte are CONFIG errors.
 */
function sqlitePath(url: URL): string {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new OrmError('CONFIG', 'sqlite DSN path has a % without two hexadecimal digits or is not UTF-8 after percent-decoding');
  }
  // NUL 뒤를 버리는 opener는 다른 file을 연다.
  if (path.includes('\0')) throw new OrmError('CONFIG', 'sqlite DSN path must not contain a NUL byte');
  return path;
}

/** Returns the offset of a fixed zone such as +00:00 in minutes east of UTC. */
export function zoneOffset(zone: string): number {
  const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (!fixed) throw new OrmError('INTERNAL', `connection zone ${zone} is not a fixed offset`);
  return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3]));
}

/**
 * Bounds of a connection pool: at most size open connections, at most
 * idleSize idle connections, and a connection lifetime of lifetimeMs
 * milliseconds when it is not zero.
 */
export interface PoolBounds { size: number; idleSize: number; lifetimeMs: number; }

/** The callback pool of mysql2 under its promise wrapper. */
interface MySqlCorePool {
  _closed: boolean;
  _freeConnections: { length: number; get(index: number): unknown };
  on(event: 'connection' | 'release', listener: (connection: MySqlCoreConnection) => void): void;
}

interface MySqlCoreConnection {
  query(sql: string, done: (error: unknown) => void): void;
  destroy(): void;
}

function mysqlIdle(pool: MySqlCorePool, connection: MySqlCoreConnection): boolean {
  for (let i = 0; i < pool._freeConnections.length; i++) if (pool._freeConnections.get(i) === connection) return true;
  return false;
}

/**
 * Applies the idle size and lifetime of bounds to a mysql2 pool: a released
 * connection is closed when the pool already keeps idleSize idle connections
 * or when its lifetime has passed, and an idle connection is closed when its
 * lifetime passes.
 */
function boundMySqlPool(pool: MySqlCorePool, bounds: PoolBounds): void {
  const expired = new WeakSet<MySqlCoreConnection>();
  if (bounds.lifetimeMs > 0) {
    pool.on('connection', connection => {
      setTimeout(() => {
        expired.add(connection);
        if (!pool._closed && mysqlIdle(pool, connection)) connection.destroy();
      }, bounds.lifetimeMs).unref();
    });
  }
  if (bounds.lifetimeMs > 0 || bounds.idleSize < bounds.size) {
    // mysql2 emits release after the connection joined the idle connections.
    pool.on('release', connection => {
      if (expired.has(connection) || pool._freeConnections.length > bounds.idleSize) connection.destroy();
    });
  }
}

export function openDriver(dsn: string, parsed: ParsedDsn, bounds: PoolBounds, statementCacheSize: number, statementTimeoutMs = 0): DriverPool {
  const url = new URL(dsn);
  url.searchParams.delete('timezone');
  switch (parsed.driver) {
    case 'mysql': {
      const socket = url.searchParams.get('socket');
      // ssl-mode=VERIFY_IDENTITY: server 인증서를 CA와 host 이름으로 검사하는 TLS이며,
      // rejectUnauthorized를 둔 Node TLS 기본값이다. password는 TLS 안에서만 오가고 client는
      // server의 RSA public key를 요청하지 않는다.
      const ssl = mysqlSsl(parsed);
      const created = mysql.createPool({
        ...(socket ? { socketPath: socket } : { host: url.hostname, port: url.port ? Number(url.port) : undefined }),
        ...(ssl ? { ssl } : {}),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        connectionLimit: bounds.size,
        namedPlaceholders: false,
        dateStrings: true,
        decimalNumbers: false,
        jsonStrings: true,
        maxPreparedStatements: statementCacheSize,
      });
      const setup: SessionSetup = {};
      const core = (created as unknown as { pool: MySqlCorePool }).pool;
      core.on('connection', connection => {
        // MySQL bounds SELECT statements with max_execution_time.
        const session = statementTimeoutMs > 0 ? `SET time_zone = '+00:00', SESSION max_execution_time = ${statementTimeoutMs}` : `SET time_zone = '+00:00'`;
        connection.query(session, error => { if (error) setup.error = error; });
      });
      boundMySqlPool(core, bounds);
      return new MySqlPoolDriver(created, setup, bounds.size);
    }
    case 'postgres': {
      const config: pg.PoolConfig = { connectionString: url.toString(), max: bounds.size };
      // pg closes a connection maxLifetimeSeconds after it opened, idle or at its release.
      if (bounds.lifetimeMs > 0) config.maxLifetimeSeconds = bounds.lifetimeMs / 1000;
      config.options = '-c TimeZone=UTC';
      if (statementTimeoutMs > 0) config.options += ` -c statement_timeout=${statementTimeoutMs}`;
      return new PostgresPoolDriver(new pg.Pool(config), statementCacheSize, bounds.size, bounds.idleSize, config);
    }
    case 'sqlite': {
      const pragmas = url.searchParams.getAll('_pragma').map(pragma => {
        const match = /^([a-z_]+)\(([A-Za-z0-9_]+)\)$/.exec(pragma);
        if (!match || (match[1] === 'busy_timeout' && !/^\d+$/.test(match[2]!))) throw new OrmError('CONFIG', `sqlite DSN _pragma ${pragma} is invalid`);
        return [match[1]!, match[2]!] as const;
      });
      // The connection waits for a lock up to busy_timeout from its first statement.
      const busyTimeout = pragmas.find(([name]) => name === 'busy_timeout');
      const db = new DatabaseSync(sqlitePath(url), { timeout: busyTimeout ? Number(busyTimeout[1]) : SQLITE_BUSY_TIMEOUT_MS });
      const version = String((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v);
      const [major, minor] = version.split('.').map(Number);
      if (major! < 3 || (major === 3 && minor! < 46)) {
        db.close();
        throw new OrmError('CAPABILITY_UNSUPPORTED', `SQLite ${version} is older than 3.46`);
      }
      db.exec('PRAGMA foreign_keys = ON');
      for (const [name, value] of pragmas) db.exec(`PRAGMA ${name} = ${value}`);
      return new SqlitePoolDriver(db, statementCacheSize);
    }
  }
}
