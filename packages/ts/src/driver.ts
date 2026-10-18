import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, isIP } from 'node:net';
import mysql, { type Pool as MySqlPool, type PoolConnection as MySqlConnection } from 'mysql2/promise';
import pg from 'pg';
import { OrmError } from './runtime_error.js';
import { parseMarkdownDsn, type MarkdownDsn } from './markdown.js';
import * as codes from './codes.js';

pg.types.setTypeParser(20, value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new OrmError(codes.CODEC_DECODE, `postgres int8 is outside the TypeScript safe integer range: ${value}`);
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
 * The source of a statement the driver sent. A statement is one the caller sent; deallocate is the statement PostgreSQL
 * sends to release a prepared statement evicted from the statement cache; kill is the statement MySQL uses from another connection
 * to stop a running statement.
 */
export type SentOrigin = 'statement' | 'deallocate' | 'kill';

/**
 * Called when the driver has read one statement's result or the statement failed. elapsed is the time in seconds since the statement
 * was sent, and error is the statement's error. An error that is thrown becomes the error of the operation.
 */
export type StatementDone = (sql: string, elapsed: number, error: OrmError | null, origin: SentOrigin) => void;


/** A connection pool or one reserved connection. */
interface DriverConnection {
  readonly name: DriverName;
  /** Runs one prepared statement; an aborted signal cancels it and raises CANCELED. */
  execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult>;
}

export interface DriverPool extends DriverConnection {
  /**
   * Takes one connection. It is used by a transaction, and by statements that must run on one connection outside a transaction (MySQL
   * schema statements and the catalog they read, and the SQLite statement that turns off foreign keys).
   */
  reserve(): Promise<DriverSession>;
  stats(): PoolStats;
  close(): Promise<void>;
}

/** One held connection. It is returned with release when finished. */
export interface DriverSession extends DriverConnection {
  /** Runs a statement that is not prepared (transaction control, savepoints, locks, session values, schema statements). */
  control(sql: string, params: readonly DriverValue[], done: StatementDone): Promise<DriverResult>;
  /** Whether the SQLite connection is inside a transaction. Other drivers do not report it. */
  inTransaction?(): boolean;
  /**
   * Returns the connection. With discard, it is not returned to the pool but closed, so the server ends that session. For SQLite
   * a single connection is not closed.
   */
  release(discard: boolean): void;
}

function seconds(started: number): number { return (performance.now() - started) / 1000; }

/**
 * Runs one statement that work sends, and calls done when the result has been read or the statement failed. A failure is
 * converted into a driver error, given to done, and thrown.
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

/**
 * `value` as a parameter of a statement; a value that no driver binds is a CODEC_ENCODE error that names `what`.
 *
 * @internal
 */
export function driverValue(value: unknown, what: string): DriverValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
    || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  throw new OrmError(codes.CODEC_ENCODE, `${what} is a ${typeof value}, which no driver binds`);
}

/** The property `name` of `value`, or undefined when value is no object: the drivers keep the fields read here untyped. */
function property(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

/** The number property `name` of a driver object; another value is an INTERNAL error that names `what`. */
function numberProperty(value: unknown, name: string, what: string): number {
  const found = property(value, name);
  if (typeof found !== 'number') throw new OrmError(codes.INTERNAL, `${what} has no number ${name}`);
  return found;
}

/** The message of a thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The rows of a driver result in array mode; a row that is no array is an INTERNAL error. */
function arrayRows(value: unknown): unknown[][] {
  if (!Array.isArray(value)) throw new OrmError(codes.INTERNAL, 'a driver answered rows that are no list');
  return value.map((row: unknown): unknown[] => {
    if (!Array.isArray(row)) throw new OrmError(codes.INTERNAL, 'a driver answered a row that is no list');
    return row;
  });
}

/**
 * The first column of the first row as an insert id. PostgreSQL answers every statement with rows, and only an insert's
 * RETURNING row holds an id, so a first cell that no id takes (none, NULL, or another type) is no insert id: null.
 */
function insertIdOf(rows: readonly (readonly unknown[])[]): DriverResult['insertId'] {
  const [row] = rows;
  const value = row === undefined ? null : row[0];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  return null;
}

/** Reports SQLITE_BUSY or one of its extended codes. */
export function sqliteBusy(name: DriverName, error: unknown): boolean {
  return name === 'sqlite' && (Number(property(error, 'errcode')) & 0xff) === 5;
}

/**
 * Whether the error is a driver error for a lost connection: the server ended the connection or it dropped. mysql2 sets fatal on an error after which
 * the connection cannot be used any more, and a fatal error that failed to open the connection (ECONNREFUSED, authentication failure) has a different code.
 * A fatal error without a code is a statement sent to a connection that was already closed. MySQL 4031 means the server ended a connection that was idle.
 * PostgreSQL treats class 08 (connection exception) and the codes sent when the server ends a session
 * 57P01 (admin_shutdown), 57P02 (crash_shutdown), and 57P05 (idle_session_timeout) as lost connections.
 */
function connectionLost(name: DriverName, source: { code: string | undefined; errno: number | undefined; fatal: boolean }): boolean {
  if (name === 'mysql') {
    return source.errno === 4031 || (source.fatal === true && (source.code === undefined || source.code === 'PROTOCOL_CONNECTION_LOST' || source.code === 'ECONNRESET' || source.code === 'EPIPE'));
  }
  return name === 'postgres' && typeof source.code === 'string' && (source.code.startsWith('08') || source.code === '57P01' || source.code === '57P02' || source.code === '57P05');
}

function driverError(name: DriverName, error: unknown): OrmError {
  if (error instanceof OrmError) return error;
  const driverCode = property(error, 'code');
  const errcode = property(error, 'errcode');
  const errno = property(error, 'errno');
  const source = {
    code: typeof driverCode === 'string' ? driverCode : undefined,
    errcode: typeof errcode === 'number' ? errcode : undefined,
    errno: typeof errno === 'number' ? errno : undefined,
    fatal: property(error, 'fatal') === true,
  };
  const text = property(error, 'message');
  const message = typeof text === 'string' ? text : errorText(error);
  if (connectionLost(name, source)) return new OrmError(codes.CONNECTION_LOST, `${name}: ${message}`, error);
  const lockNotAvailable = source.code === 'ER_LOCK_NOWAIT' || source.errcode === 3572 || source.code === '55P03';
  // MySQL 1317/3024, PostgreSQL 57014, and SQLite 9 all report a statement
  // that was stopped before it finished; SQLite BUSY reports a lock that
  // another connection still held when busy_timeout ended.
  if (source.code === 'ER_QUERY_INTERRUPTED' || source.code === 'ER_QUERY_TIMEOUT' || source.code === '57014' || source.errcode === 9 || sqliteBusy(name, error)) {
    return new OrmError(codes.CANCELED, `${name}: ${message}`, error);
  }
  const duplicate = source.code === 'ER_DUP_ENTRY' || source.code === '23505' || source.errcode === 2067 || source.errcode === 1555;
  const foreignKey = source.code === 'ER_NO_REFERENCED_ROW_2' || source.code === 'ER_ROW_IS_REFERENCED_2' || source.code === '23503' || source.errcode === 787 ||
    // SQLite reports an FK violation of a RESTRICT action as CONSTRAINT_TRIGGER (1811). The 1811 of a trigger RAISE is DRIVER.
    (source.errcode === 1811 && message.includes('FOREIGN KEY constraint failed'));
  const deadlock = source.code === 'ER_LOCK_DEADLOCK' || source.code === '40P01' || source.code === '40001' || source.errcode === 6 || source.errcode === 262;
  // MySQL 1290/1792, PostgreSQL 25006, and SQLite READONLY (8) with its
  // extended codes report a write the read-only server or connection rejects.
  const readOnly = source.code === 'ER_OPTION_PREVENTS_STATEMENT' || source.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' || source.code === '25006' || (typeof source.errcode === 'number' && (source.errcode & 0xff) === 8);
  // MySQL 3819/4025, PostgreSQL 23514, and SQLite CONSTRAINT_CHECK (275) report a CHECK violation.
  const constraint = source.code === 'ER_CHECK_CONSTRAINT_VIOLATED' || source.code === 'ER_CONSTRAINT_FAILED' || source.code === '23514' || source.errcode === 275;
  // Every other driver error, such as a write that a trigger refuses, is DRIVER.
  const code = lockNotAvailable ? codes.LOCK_NOT_AVAILABLE : duplicate ? codes.DUPLICATE_KEY : foreignKey ? codes.FOREIGN_KEY : deadlock ? codes.DEADLOCK : readOnly ? codes.READ_ONLY : constraint ? codes.CONSTRAINT : codes.DRIVER;
  return new OrmError(code, `${name}: ${message}`, error);
}

/** The error of a statement the caller cancelled. */
function canceled(name: DriverName): OrmError {
  return new OrmError(codes.CANCELED, `${name}: the statement was cancelled`);
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
  // The failure of a statement that is being stopped is reported as the statement's CANCELED, so it is discarded. Only the subscriber's
  // failure (SUBSCRIBER) is thrown as the operation's error after the statement ends.
  let stopping: Promise<unknown> | undefined;
  const abort = () => { stopping = stop().then(() => undefined, (error: unknown) => error); };
  signal.addEventListener('abort', abort, { once: true });
  let result: T;
  try {
    result = await work;
  } catch (error) {
    await subscriberFailure(stopping);
    if (signal.aborted) throw error instanceof OrmError && error.code === codes.CANCELED ? error : canceled(name);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
  await subscriberFailure(stopping);
  return result;
}

/** If the subscriber of a statement being stopped failed, throws that SUBSCRIBER error. */
async function subscriberFailure(stopping: Promise<unknown> | undefined): Promise<void> {
  if (stopping === undefined) return;
  const error = await stopping;
  if (error instanceof OrmError && error.code === codes.SUBSCRIBER) throw error;
}

export function isolationSql(isolation: Isolation): string {
  if (!['read_uncommitted', 'read_committed', 'repeatable_read', 'serializable'].includes(isolation)) throw new OrmError(codes.CONFIG, `unsupported transaction isolation ${isolation}`);
  return isolation.replaceAll('_', ' ').toUpperCase();
}

async function mysqlExecute(connection: MySqlPool | MySqlConnection, sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
  const [value] = await connection.execute({ sql, rowsAsArray: true }, [...params]);
  if (Array.isArray(value)) return { rows: arrayRows(value), affected: 0, insertId: null };
  const result = value as { affectedRows: number; insertId: number };
  return { rows: [], affected: result.affectedRows, insertId: result.insertId || null };
}

async function mysqlControl(connection: MySqlConnection, sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
  const [value] = await connection.query({ sql, rowsAsArray: true }, [...params]);
  if (Array.isArray(value)) return { rows: arrayRows(value), affected: 0, insertId: null };
  return { rows: [], affected: (value as { affectedRows: number }).affectedRows, insertId: null };
}

/** Stops the statement running on connection from another connection of the pool. */
async function mysqlKill(pool: MySqlPool, connection: MySqlConnection, done: StatementDone): Promise<void> {
  const id = connection.threadId;
  const sql = `KILL QUERY ${Number(id)}`;
  await observed('mysql', sql, done, 'kill', () => pool.query(sql));
}

/** The failure of the session setup that runs on each new MySQL connection. */
interface SessionSetup { error?: unknown; }

function sessionError(setup: SessionSetup): OrmError | undefined {
  if (setup.error === undefined) return undefined;
  return driverError('mysql', setup.error);
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
    const open = numberProperty(property(this.pool.pool, '_allConnections'), 'length', 'the connections of a mysql2 pool');
    const idle = numberProperty(property(this.pool.pool, '_freeConnections'), 'length', 'the free connections of a mysql2 pool');
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
    const [oldest] = this.names;
    if (oldest === undefined) return { name };
    const [oldestSql, oldestName] = oldest;
    this.names.delete(oldestSql);
    return { name, evicted: oldestName };
  }
}

const statementCaches = new WeakMap<object, StatementNames>();

/**
 * Runs a prepared statement. A prepared statement that the statement cache evicted is released with DEALLOCATE on the same connection after
 * the statement's result is read. That statement is the event after the statement.
 */
async function pgExecute(client: pg.PoolClient, sql: string, params: readonly DriverValue[], cacheSize: number, done: StatementDone, failure: () => unknown): Promise<DriverResult> {
  let cache = statementCaches.get(client);
  if (cache === undefined) {
    cache = new StatementNames(cacheSize);
    statementCaches.set(client, cache);
  }
  const { name, evicted } = cache.name(sql);
  const result = await observed('postgres', sql, done, 'statement', () => afterFailure(client.query({ name, text: sql, values: [...params], rowMode: 'array' }), failure));
  if (evicted !== undefined) {
    const deallocate = `DEALLOCATE "${evicted}"`;
    await observed('postgres', deallocate, done, 'deallocate', () => afterFailure(client.query(deallocate), failure));
  }
  const rows = arrayRows(result.rows);
  return { rows, affected: result.rowCount ?? 0, insertId: insertIdOf(rows) };
}

/**
 * If the held connection reported a connection error through its 'error' event, the failure of the statement is a lost-connection error. pg then
 * rejects the connection's next statement with an error that has no code (`Client has encountered a connection error and is not
 * queryable`), so the error the connection reported is taken as the judgment. The failure is that error or undefined.
 */
async function afterFailure<T>(work: Promise<T>, failure: () => unknown): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const lost = failure();
    if (lost === undefined || error instanceof OrmError) throw error;
    throw new OrmError(codes.CONNECTION_LOST, `postgres: ${errorText(error)} (${errorText(lost)})`, error);
  }
}

/**
 * Sends the protocol cancel request for the statement of a client: the
 * process id and secret key the server sent the client at startup, on a
 * socket of its own so a busy pool cannot hold it up. A pooler maps the pair
 * to the server connection that runs the statement.
 */
function pgCancel(config: pg.PoolConfig, client: pg.PoolClient): Promise<void> {
  const processID = property(client, 'processID');
  const secretKey = property(client, 'secretKey');
  if (typeof processID !== 'number' || typeof secretKey !== 'number') return Promise.resolve();
  const target = new pg.Client(config);
  const request = Buffer.alloc(16);
  request.writeInt32BE(16, 0);
  request.writeInt32BE(80877102, 4);
  request.writeInt32BE(processID, 8);
  request.writeInt32BE(secretKey, 12);
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
      // A connection error on a connection that the pool lent out is received by the pool. The statement's error has that code.
      const work = pgExecute(client, sql, params, this.cacheSize, done, () => undefined);
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
    const work = pgExecute(this.client, sql, params, this.cacheSize, done, () => this.failure);
    return signal === undefined ? work : cancellable(this.name, signal, () => pgCancel(this.config, this.client), work);
  }
  public async control(sql: string, params: readonly DriverValue[], done: StatementDone): Promise<DriverResult> {
    const result = await observed(this.name, sql, done, 'statement', () => afterFailure(this.client.query({ text: sql, values: [...params], rowMode: 'array' }), () => this.failure));
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
    const [oldest] = this.statements.keys();
    if (this.statements.size > this.cacheSize && oldest !== undefined) this.statements.delete(oldest);
    return statement;
  }
}

function sqliteExecute(state: SqliteState, sql: string, params: readonly DriverValue[]): DriverResult {
  const statement = state.statement(sql);
  const values = params.map(value => typeof value === 'boolean' ? Number(value) : value) as Array<null | number | string | bigint | Uint8Array>;
  if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
    statement.setReturnArrays(true);
    const rows = arrayRows(statement.all(...values));
    return { rows, affected: rows.length, insertId: insertIdOf(rows) };
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
  /** Takes the one SQLite connection when no transaction or session uses it. */
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

/** A DSN of a SQL database: the driver, the connection time zone and the MySQL TLS CA. */
export interface SqlDsn { driver: DriverName; zone: string; sslCa?: string; }

/** A markdown:// DSN: the flowmark server address, the corpus and the token of the markdown IR executor (docs/protocol.md §5). */
interface MarkdownParsedDsn { driver: 'markdown'; zone: string; markdown: MarkdownDsn; }

export type ParsedDsn = SqlDsn | MarkdownParsedDsn;

/** The parameters a DSN accepts for each scheme (docs/config.md). Any other parameter is CONFIG. */
const DSN_PARAMETERS: Record<string, readonly string[]> = {
  'mysql:': ['timezone', 'socket', 'ssl-mode', 'ssl-ca'],
  'postgres:': ['timezone', 'host', 'sslmode'],
  'sqlite:': ['timezone', '_pragma', '_txlock'],
};

/**
 * Checks the MySQL TLS parameters: a TCP connection that puts the absolute path of the CA file in `ssl-ca`
 * with `ssl-mode=VERIFY_IDENTITY`, or neither. Returns the CA path or undefined.
 */
function mysqlTls(url: URL): string | undefined {
  const mode = url.searchParams.get('ssl-mode');
  const ca = url.searchParams.get('ssl-ca');
  if (mode === null && ca === null) return undefined;
  if (mode !== 'VERIFY_IDENTITY') throw new OrmError(codes.CONFIG, `mysql DSN ssl-mode ${JSON.stringify(mode)} is not supported; the TLS mode is ssl-mode=VERIFY_IDENTITY with ssl-ca`);
  if (ca === null || ca === '') throw new OrmError(codes.CONFIG, 'mysql DSN ssl-mode=VERIFY_IDENTITY needs ssl-ca, the absolute path of the CA file');
  if (!ca.startsWith('/')) throw new OrmError(codes.CONFIG, `mysql DSN ssl-ca ${ca} is not an absolute path`);
  if (url.searchParams.has('socket')) throw new OrmError(codes.CONFIG, 'mysql DSN ssl-mode connects over TCP and does not accept socket');
  // The identity check compares the host name with the certificate. The driver compares a host that is an IP address with the name localhost.
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) throw new OrmError(codes.CONFIG, `mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address ${url.hostname}`);
  return ca;
}

/**
 * The mysql2 TLS option for ssl-mode=VERIFY_IDENTITY, or undefined: the CA of `ssl-ca`, the rejection of
 * certificates not signed by that CA, and the host name check.
 */
function mysqlSsl(parsed: SqlDsn): { ca: string; rejectUnauthorized: true; verifyIdentity: true } | undefined {
  if (parsed.sslCa === undefined) return undefined;
  try { return { ca: readFileSync(parsed.sslCa, 'utf8'), rejectUnauthorized: true, verifyIdentity: true }; } catch (error) {
    throw new OrmError(codes.CONFIG, `mysql DSN ssl-ca ${parsed.sslCa} cannot be read: ${errorText(error)}`, error);
  }
}

/**
 * Splits a DSN URI into the dialect and the connection time zone. Every
 * connection reads and writes datetime values in UTC (docs/dialects.md "Date
 * and time"), so the timezone parameter accepts only UTC or +00:00.
 */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try { url = new URL(dsn); } catch { throw new OrmError(codes.CONFIG, 'dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://'); }
  const accepted = DSN_PARAMETERS[url.protocol];
  if (accepted !== undefined) {
    for (const name of url.searchParams.keys()) {
      if (!accepted.includes(name)) throw new OrmError(codes.CONFIG, `${url.protocol.replace(/:$/, '')} DSN has the unknown parameter ${name}; it accepts ${accepted.join(', ')}`);
    }
  }
  const requested = url.searchParams.get('timezone');
  if (requested !== null && requested !== 'UTC' && requested !== '+00:00') throw new OrmError(codes.CONFIG, `dsn timezone ${requested}: every connection reads and writes datetime values in UTC`);
  const zone = '+00:00';
  switch (url.protocol) {
    case 'mysql:': {
      if (url.hostname === '' || url.pathname.replace(/\//g, '') === '') throw new OrmError(codes.CONFIG, 'mysql DSN must include host and database');
      const sslCa = mysqlTls(url);
      return sslCa === undefined ? { driver: 'mysql', zone } : { driver: 'mysql', zone, sslCa };
    }
    case 'postgres:':
      if ((url.hostname === '' && !url.searchParams.has('host')) || url.pathname.replace(/\//g, '') === '') throw new OrmError(codes.CONFIG, 'postgres DSN must include host and database');
      return { driver: 'postgres', zone };
    case 'sqlite:':
      if (url.hostname !== '' || !url.pathname.startsWith('/') || url.pathname === '/') throw new OrmError(codes.CONFIG, 'sqlite DSN must include an absolute database path');
      if (url.searchParams.has('_txlock')) throw new OrmError(codes.CONFIG, 'sqlite DSN does not accept _txlock; write transactions begin with BEGIN IMMEDIATE');
      sqlitePath(url);
      return { driver: 'sqlite', zone };
    case 'markdown:':
      return { driver: 'markdown', zone, markdown: parseMarkdownDsn(url) };
  }
  throw new OrmError(codes.CONFIG, `unsupported DSN scheme ${url.protocol.replace(/:$/, '')}; want mysql, postgres, sqlite, or markdown`);
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
    throw new OrmError(codes.CONFIG, 'sqlite DSN path has a % without two hexadecimal digits or is not UTF-8 after percent-decoding');
  }
  // An opener that drops what follows a NUL opens a different file.
  if (path.includes('\0')) throw new OrmError(codes.CONFIG, 'sqlite DSN path must not contain a NUL byte');
  return path;
}

/** Returns the offset of a fixed zone such as +00:00 in minutes east of UTC. */
export function zoneOffset(zone: string): number {
  const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (!fixed) throw new OrmError(codes.INTERNAL, `connection zone ${zone} is not a fixed offset`);
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
  closed(): boolean;
  freeConnections(): number;
  idle(connection: MySqlCoreConnection): boolean;
  on(event: 'connection' | 'release', listener: (connection: MySqlCoreConnection) => void): void;
}

/** The callback pool under the promise pool `pool`, through the fields of mysql2 that its typings leave out. */
function mysqlCorePool(pool: MySqlPool): MySqlCorePool {
  const core = pool.pool;
  const free = (): { length: number; get: unknown; queue: unknown } => {
    const queue = property(core, '_freeConnections');
    return { length: numberProperty(queue, 'length', 'the free connections of a mysql2 pool'), get: property(queue, 'get'), queue };
  };
  return {
    closed: () => property(core, '_closed') === true,
    freeConnections: () => free().length,
    idle: connection => {
      const { length, get, queue } = free();
      if (typeof get !== 'function') throw new OrmError(codes.INTERNAL, 'the free connections of a mysql2 pool have no get');
      for (let i = 0; i < length; i++) if (Reflect.apply(get, queue, [i]) === connection) return true;
      return false;
    },
    on: (event, listener) => {
      if (event === 'connection') core.on('connection', listener);
      else core.on('release', listener);
    },
  };
}

interface MySqlCoreConnection {
  query(sql: string, done: (error: unknown) => void): void;
  destroy(): void;
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
        if (!pool.closed() && pool.idle(connection)) connection.destroy();
      }, bounds.lifetimeMs).unref();
    });
  }
  if (bounds.lifetimeMs > 0 || bounds.idleSize < bounds.size) {
    // mysql2 emits release after the connection joined the idle connections.
    pool.on('release', connection => {
      if (expired.has(connection) || pool.freeConnections() > bounds.idleSize) connection.destroy();
    });
  }
}

/**
 * The session sql_mode of every MySQL connection, so that a coercion, truncation or grouping result does not depend on
 * the server's setting; it also replaces the IGNORE_SPACE that mysql2's default client flags add
 * (tests/dsn/mysql-session.json, docs/config.md "Runtime connection").
 */
const MYSQL_SQL_MODE = 'STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

export function openDriver(dsn: string, parsed: SqlDsn, bounds: PoolBounds, statementCacheSize: number, statementTimeoutMs = 0): DriverPool {
  const url = new URL(dsn);
  url.searchParams.delete('timezone');
  switch (parsed.driver) {
    case 'mysql': {
      const socket = url.searchParams.get('socket');
      // ssl-mode=VERIFY_IDENTITY: TLS that checks the server certificate against the CA and the host name, and
      // is the Node TLS default with rejectUnauthorized. The password travels only inside TLS, and the client
      // does not request the server's RSA public key.
      const ssl = mysqlSsl(parsed);
      const created = mysql.createPool({
        ...(socket ? { socketPath: socket } : { host: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) }),
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
      const core = mysqlCorePool(created);
      core.on('connection', connection => {
        // MySQL bounds SELECT statements with max_execution_time.
        const zone = `SET time_zone = '+00:00', sql_mode = '${MYSQL_SQL_MODE}'`;
        const session = statementTimeoutMs > 0 ? `${zone}, SESSION max_execution_time = ${statementTimeoutMs}` : zone;
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
        const [, name, value] = match ?? [];
        if (name === undefined || value === undefined || (name === 'busy_timeout' && !/^\d+$/.test(value))) throw new OrmError(codes.CONFIG, `sqlite DSN _pragma ${pragma} is invalid`);
        return [name, value] as const;
      });
      // The connection waits for a lock up to busy_timeout from its first statement.
      const busyTimeout = pragmas.find(([name]) => name === 'busy_timeout');
      const db = new DatabaseSync(sqlitePath(url), { timeout: busyTimeout ? Number(busyTimeout[1]) : SQLITE_BUSY_TIMEOUT_MS });
      // The version of the SQLite library that node:sqlite links. The connection does not send a statement that asks for it.
      const version = process.versions.sqlite ?? '';
      const [major = 0, minor = 0] = version.split('.').map(Number);
      if (major < 3 || (major === 3 && minor < 46)) {
        db.close();
        throw new OrmError(codes.CAPABILITY_UNSUPPORTED, `SQLite ${version} is older than 3.46`);
      }
      db.exec('PRAGMA foreign_keys = ON');
      for (const [name, value] of pragmas) db.exec(`PRAGMA ${name} = ${value}`);
      return new SqlitePoolDriver(db, statementCacheSize);
    }
  }
}
