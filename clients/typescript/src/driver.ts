import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import mysql, { type Pool as MySqlPool, type PoolConnection as MySqlConnection } from 'mysql2/promise';
import pg from 'pg';
import { OrmError } from './runtime_error.js';

pg.types.setTypeParser(20, value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new OrmError('CODEC_DECODE', `postgres int8 is outside the TypeScript safe integer range: ${value}`);
  return parsed;
});
pg.types.setTypeParser(1700, value => Number(value));
pg.types.setTypeParser(1082, value => value);
pg.types.setTypeParser(1114, value => value);
pg.types.setTypeParser(1184, value => value);
pg.types.setTypeParser(114, value => value);
pg.types.setTypeParser(3802, value => value);

export type DriverName = 'mysql' | 'postgres' | 'sqlite';
export type Isolation = 'read_uncommitted' | 'read_committed' | 'repeatable_read' | 'serializable';
export interface DriverTransactionOptions { isolation?: Isolation; readOnly?: boolean; timeoutMs?: number; }
export type DriverValue = null | boolean | number | string | bigint | Uint8Array;

export interface DriverResult {
  rows: unknown[][];
  affected: number;
  insertId: number | bigint | string | null;
}

export interface PoolStats { maxOpenConnections: number; openConnections: number; inUse: number; idle: number; }

/** A connection pool or one transaction connection. */
export interface DriverConnection {
  readonly name: DriverName;
  /** Runs one statement; an aborted signal cancels it and raises CANCELED. */
  execute(sql: string, params: readonly DriverValue[], signal?: AbortSignal): Promise<DriverResult>;
}

export interface DriverPool extends DriverConnection {
  begin(options: DriverTransactionOptions): Promise<DriverTransaction>;
  /** Runs statements that are not prepared on one connection outside a transaction (MySQL schema statements). */
  unprepared?(statements: readonly string[]): Promise<void>;
  stats(): PoolStats;
  close(): Promise<void>;
}

export interface DriverTransaction extends DriverConnection {
  /** Runs a statement that is not prepared (savepoints, locks, session values). */
  control(sql: string, params?: readonly DriverValue[]): Promise<DriverResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  rowLock(mode: string): Promise<void>;
}

function driverError(name: DriverName, error: unknown): OrmError {
  if (error instanceof OrmError) return error;
  const source = error as { code?: string; errcode?: number; message?: string };
  const message = source.message ?? String(error);
  // MySQL 1317/3024, PostgreSQL 57014, and SQLite 9 all report a statement
  // that was stopped before it finished.
  if (source.code === 'ER_QUERY_INTERRUPTED' || source.code === 'ER_QUERY_TIMEOUT' || source.code === '57014' || source.errcode === 9) {
    return new OrmError('CANCELED', `${name}: ${message}`, error);
  }
  const duplicate = source.code === 'ER_DUP_ENTRY' || source.code === '23505' || source.errcode === 2067 || source.errcode === 1555;
  const foreignKey = source.code === 'ER_NO_REFERENCED_ROW_2' || source.code === 'ER_ROW_IS_REFERENCED_2' || source.code === '23503' || source.errcode === 787;
  const deadlock = source.code === 'ER_LOCK_DEADLOCK' || source.code === '40P01' || source.code === '40001' || source.errcode === 5 || source.errcode === 6 || source.errcode === 261 || source.errcode === 262;
  const code = duplicate ? 'DUPLICATE_KEY' : foreignKey ? 'FOREIGN_KEY' : deadlock ? 'DEADLOCK' : 'DRIVER';
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
  const abort = () => { void stop().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await work;
  } catch (error) {
    if (signal.aborted) throw error instanceof OrmError && error.code === 'CANCELED' ? error : canceled(name);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function isolationSql(isolation: Isolation): string {
  if (!['read_uncommitted', 'read_committed', 'repeatable_read', 'serializable'].includes(isolation)) throw new OrmError('CONFIG', `unsupported transaction isolation ${isolation}`);
  return isolation.replaceAll('_', ' ').toUpperCase();
}

async function mysqlExecute(connection: MySqlPool | MySqlConnection, sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
  try {
    const [value] = await connection.execute({ sql, rowsAsArray: true }, [...params]);
    if (Array.isArray(value)) return { rows: value as unknown[][], affected: 0, insertId: null };
    const result = value as { affectedRows: number; insertId: number };
    return { rows: [], affected: result.affectedRows, insertId: result.insertId || null };
  } catch (error) { throw driverError('mysql', error); }
}

/** Stops the statement running on connection from another connection of the pool. */
async function mysqlKill(pool: MySqlPool, connection: MySqlConnection): Promise<void> {
  const id = (connection as unknown as { threadId: number }).threadId;
  await pool.query(`KILL QUERY ${Number(id)}`);
}

/** The failure of the session setup that runs on each new MySQL connection. */
interface SessionSetup { error?: unknown; }

function sessionError(setup: SessionSetup): OrmError | undefined {
  const error = setup.error as { errno?: number; sqlMessage?: string; message?: string } | undefined;
  if (error === undefined) return undefined;
  if (error.errno === 1298) return new OrmError('CONFIG', `dsn timezone: ${error.sqlMessage ?? error.message}; a named zone needs the MySQL time zone tables (mysql_tzinfo_to_sql)`, error);
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
  public async execute(sql: string, params: readonly DriverValue[], signal?: AbortSignal): Promise<DriverResult> {
    if (signal === undefined) return this.checked(mysqlExecute(this.pool, sql, params));
    // A cancellable statement holds its own connection, so KILL QUERY names
    // the thread that runs it.
    let connection: MySqlConnection;
    try { connection = await this.checked(this.pool.getConnection()); } catch (error) { throw error instanceof OrmError ? error : driverError(this.name, error); }
    try {
      return await cancellable(this.name, signal, () => mysqlKill(this.pool, connection), this.checked(mysqlExecute(connection, sql, params)));
    } finally {
      connection.release();
    }
  }
  public async unprepared(statements: readonly string[]): Promise<void> {
    let connection: MySqlConnection;
    try { connection = await this.checked(this.pool.getConnection()); } catch (error) { throw error instanceof OrmError ? error : driverError(this.name, error); }
    try {
      for (const sql of statements) await connection.query(sql);
    } catch (error) {
      throw driverError(this.name, error);
    } finally {
      connection.release();
    }
  }
  public async begin(options: DriverTransactionOptions): Promise<DriverTransaction> {
    if ((options.timeoutMs ?? 0) > 0) throw new OrmError('CAPABILITY_UNSUPPORTED', 'transaction timeoutMs is supported only by postgres');
    let connection: MySqlConnection;
    try { connection = await this.checked(this.pool.getConnection()); } catch (error) { throw error instanceof OrmError ? error : driverError(this.name, error); }
    try {
      if (options.isolation) await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolationSql(options.isolation)}`);
      if (options.readOnly) await connection.query('SET TRANSACTION READ ONLY');
      await connection.beginTransaction();
    } catch (error) {
      connection.release();
      throw driverError(this.name, error);
    }
    return new MySqlTx(connection, this.pool);
  }
  public stats(): PoolStats {
    const inner = (this.pool as unknown as { pool: { _allConnections: { length: number }; _freeConnections: { length: number } } }).pool;
    const open = inner._allConnections.length;
    const idle = inner._freeConnections.length;
    return { maxOpenConnections: this.maxOpen, openConnections: open, inUse: open - idle, idle };
  }
  public async close(): Promise<void> { await this.pool.end(); }
}

class MySqlTx implements DriverTransaction {
  public readonly name = 'mysql' as const;
  public constructor(private readonly connection: MySqlConnection, private readonly pool: MySqlPool) {}
  public execute(sql: string, params: readonly DriverValue[], signal?: AbortSignal): Promise<DriverResult> {
    const work = mysqlExecute(this.connection, sql, params);
    return signal === undefined ? work : cancellable(this.name, signal, () => mysqlKill(this.pool, this.connection), work);
  }
  public async control(sql: string, params: readonly DriverValue[] = []): Promise<DriverResult> {
    try {
      const [value] = await this.connection.query({ sql, rowsAsArray: true }, [...params]);
      if (Array.isArray(value)) return { rows: value as unknown[][], affected: 0, insertId: null };
      return { rows: [], affected: (value as { affectedRows: number }).affectedRows, insertId: null };
    } catch (error) { throw driverError(this.name, error); }
  }
  public async commit(): Promise<void> {
    try { await this.connection.commit(); } catch (error) { throw driverError(this.name, error); } finally { this.connection.release(); }
  }
  public async rollback(): Promise<void> {
    try { await this.connection.rollback(); } finally { this.connection.release(); }
  }
  public async rowLock(): Promise<void> {}
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

async function pgExecute(client: pg.PoolClient, sql: string, params: readonly DriverValue[], cacheSize: number): Promise<DriverResult> {
  let cache = statementCaches.get(client);
  if (cache === undefined) {
    cache = new StatementNames(cacheSize);
    statementCaches.set(client, cache);
  }
  try {
    const { name, evicted } = cache.name(sql);
    const result = await client.query({ name, text: sql, values: [...params], rowMode: 'array' });
    if (evicted !== undefined) await client.query(`DEALLOCATE "${evicted}"`);
    return { rows: result.rows as unknown[][], affected: result.rowCount ?? 0, insertId: (result.rows[0] as unknown[] | undefined)?.[0] as DriverResult['insertId'] ?? null };
  } catch (error) { throw driverError('postgres', error); }
}

/**
 * Asks PostgreSQL to stop the statement of a backend. The request runs on a
 * connection of its own so a busy pool cannot hold it up.
 */
async function pgCancel(config: pg.PoolConfig, client: pg.PoolClient): Promise<void> {
  const pid = (client as unknown as { processID: number | null }).processID;
  if (pid === null || pid === undefined) return;
  const canceller = new pg.Client(config as pg.ClientConfig);
  await canceller.connect();
  try { await canceller.query('SELECT pg_cancel_backend($1)', [pid]); } finally { await canceller.end(); }
}

class PostgresPoolDriver implements DriverPool {
  public readonly name = 'postgres' as const;
  public constructor(private readonly pool: pg.Pool, private readonly cacheSize: number, private readonly maxOpen: number, private readonly config: pg.PoolConfig) {}
  public async execute(sql: string, params: readonly DriverValue[], signal?: AbortSignal): Promise<DriverResult> {
    let client: pg.PoolClient;
    try { client = await this.pool.connect(); } catch (error) { throw driverError(this.name, error); }
    try {
      const work = pgExecute(client, sql, params, this.cacheSize);
      return await (signal === undefined ? work : cancellable(this.name, signal, () => pgCancel(this.config, client), work));
    } finally { client.release(); }
  }
  public async begin(options: DriverTransactionOptions): Promise<DriverTransaction> {
    let client: pg.PoolClient;
    try { client = await this.pool.connect(); } catch (error) { throw driverError(this.name, error); }
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      if (options.isolation) await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationSql(options.isolation)}`);
      if (options.readOnly) await client.query('SET TRANSACTION READ ONLY');
      if ((options.timeoutMs ?? 0) > 0) await client.query(`SET LOCAL statement_timeout = ${Math.floor(options.timeoutMs!)}`);
    } catch (error) {
      if (began) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      throw driverError(this.name, error);
    }
    return new PostgresTx(client, this.cacheSize, this.config);
  }
  public stats(): PoolStats {
    return { maxOpenConnections: this.maxOpen, openConnections: this.pool.totalCount, inUse: this.pool.totalCount - this.pool.idleCount, idle: this.pool.idleCount };
  }
  public async close(): Promise<void> { await this.pool.end(); }
}

class PostgresTx implements DriverTransaction {
  public readonly name = 'postgres' as const;
  public constructor(private readonly client: pg.PoolClient, private readonly cacheSize: number, private readonly config: pg.PoolConfig) {}
  public execute(sql: string, params: readonly DriverValue[], signal?: AbortSignal): Promise<DriverResult> {
    const work = pgExecute(this.client, sql, params, this.cacheSize);
    return signal === undefined ? work : cancellable(this.name, signal, () => pgCancel(this.config, this.client), work);
  }
  public async control(sql: string, params: readonly DriverValue[] = []): Promise<DriverResult> {
    try {
      const result = await this.client.query({ text: sql, values: [...params], rowMode: 'array' });
      return { rows: result.rows as unknown[][], affected: result.rowCount ?? 0, insertId: null };
    } catch (error) { throw driverError(this.name, error); }
  }
  public async commit(): Promise<void> {
    try { await this.client.query('COMMIT'); } catch (error) { throw driverError(this.name, error); } finally { this.client.release(); }
  }
  public async rollback(): Promise<void> {
    try { await this.client.query('ROLLBACK'); } finally { this.client.release(); }
  }
  public async rowLock(): Promise<void> {}
}

class SqliteState {
  public busy = false;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  public constructor(public readonly db: DatabaseSync, private readonly cacheSize: number) {}
  public statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    const existing = this.statements.get(sql);
    if (existing !== undefined) return existing;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > this.cacheSize) this.statements.delete(this.statements.keys().next().value as string);
    return statement;
  }
}

function sqliteExecute(state: SqliteState, sql: string, params: readonly DriverValue[]): DriverResult {
  try {
    const statement = state.statement(sql);
    const values = params.map(value => typeof value === 'boolean' ? Number(value) : value) as Array<null | number | string | bigint | Uint8Array>;
    if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      statement.setReturnArrays(true);
      const rows = statement.all(...values) as unknown as unknown[][];
      return { rows, affected: rows.length, insertId: rows[0]?.[0] as DriverResult['insertId'] ?? null };
    }
    const result = statement.run(...values);
    return { rows: [], affected: Number(result.changes), insertId: result.lastInsertRowid };
  } catch (error) { throw driverError('sqlite', error); }
}

class SqlitePoolDriver implements DriverPool {
  public readonly name = 'sqlite' as const;
  private readonly state: SqliteState;
  private waiters: Array<() => void> = [];
  public constructor(db: DatabaseSync, cacheSize: number) { this.state = new SqliteState(db, cacheSize); }
  public async execute(sql: string, params: readonly DriverValue[], signal?: AbortSignal): Promise<DriverResult> {
    await this.idle();
    // node:sqlite runs a statement to its end without yielding, so the signal
    // is read before the statement starts.
    if (signal?.aborted) throw canceled(this.name);
    return sqliteExecute(this.state, sql, params);
  }
  /** Waits until no transaction holds the single SQLite connection. */
  private async idle(): Promise<void> {
    while (this.state.busy) await new Promise<void>(resolve => this.waiters.push(resolve));
  }
  public async begin(options: DriverTransactionOptions): Promise<DriverTransaction> {
    if ((options.timeoutMs ?? 0) > 0) throw new OrmError('CAPABILITY_UNSUPPORTED', 'transaction timeoutMs is supported only by postgres');
    if (options.isolation) isolationSql(options.isolation);
    await this.idle();
    this.state.busy = true;
    try {
      this.state.db.exec('BEGIN DEFERRED');
      if (options.isolation === 'read_uncommitted') this.state.db.exec('PRAGMA read_uncommitted = 1');
      if (options.readOnly) this.state.db.exec('PRAGMA query_only = 1');
    } catch (error) {
      this.release();
      throw driverError(this.name, error);
    }
    return new SqliteTx(this.state, options, () => this.release());
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

class SqliteTx implements DriverTransaction {
  public readonly name = 'sqlite' as const;
  public constructor(private readonly state: SqliteState, private readonly options: DriverTransactionOptions, private readonly release: () => void) {}
  public async execute(sql: string, params: readonly DriverValue[], signal?: AbortSignal): Promise<DriverResult> {
    if (signal?.aborted) throw canceled(this.name);
    return sqliteExecute(this.state, sql, params);
  }
  public async control(sql: string, params: readonly DriverValue[] = []): Promise<DriverResult> { return sqliteExecute(this.state, sql, params); }
  private finishModes(): void {
    if (this.options.readOnly) this.state.db.exec('PRAGMA query_only = 0');
    if (this.options.isolation === 'read_uncommitted') this.state.db.exec('PRAGMA read_uncommitted = 0');
  }
  public async commit(): Promise<void> {
    try {
      this.finishModes();
      this.state.db.exec('COMMIT');
    } catch (error) {
      try { this.state.db.exec('ROLLBACK'); } catch { /* the transaction already ended */ }
      throw driverError(this.name, error);
    } finally { this.release(); }
  }
  public async rollback(): Promise<void> {
    try {
      this.finishModes();
      this.state.db.exec('ROLLBACK');
    } finally { this.release(); }
  }
  /** SQLite has no row-lock clause; one lock row serializes ORM lock requests. */
  public async rowLock(mode: string): Promise<void> {
    if (mode === '') return;
    this.state.db.exec('CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))');
    this.state.db.exec('INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "id" = excluded."id"');
  }
}

export interface ParsedDsn { driver: DriverName; zone: string; }

/** Splits a DSN URI into the dialect and the connection time zone. */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try { url = new URL(dsn); } catch { throw new OrmError('CONFIG', 'dsn must be a URI using mysql://, postgres://, or sqlite://'); }
  const zone = url.searchParams.get('timezone') ?? '';
  if (zone !== '') zoneOffset(zone, new Date());
  switch (url.protocol) {
    case 'mysql:':
      if (url.hostname === '' || url.pathname.replace(/\//g, '') === '') throw new OrmError('CONFIG', 'mysql DSN must include host and database');
      return { driver: 'mysql', zone };
    case 'postgres:':
      if ((url.hostname === '' && !url.searchParams.has('host')) || url.pathname.replace(/\//g, '') === '') throw new OrmError('CONFIG', 'postgres DSN must include host and database');
      return { driver: 'postgres', zone };
    case 'sqlite:':
      if (url.hostname !== '' || !url.pathname.startsWith('/') || url.pathname === '/') throw new OrmError('CONFIG', 'sqlite DSN must include an absolute database path');
      if ((url.searchParams.get('_txlock') ?? 'deferred') !== 'deferred') throw new OrmError('CONFIG', 'sqlite DSN _txlock must be deferred');
      return { driver: 'sqlite', zone };
  }
  throw new OrmError('CONFIG', `unsupported DSN scheme ${url.protocol.replace(/:$/, '')}; want mysql, postgres, or sqlite`);
}

/** Returns the offset of zone at instant in minutes east of UTC. */
export function zoneOffset(zone: string, instant: Date): number {
  const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (fixed) return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3]));
  if (zone === '') return -instant.getTimezoneOffset();
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant);
  } catch { throw new OrmError('CONFIG', `dsn timezone ${zone} is unknown`); }
  const get = (type: string) => Number(parts.find(part => part.type === type)!.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Writes a fixed offset in the POSIX form PostgreSQL expects, where the sign
 * after the name is inverted: +09:00 becomes <+09:00>-09:00.
 */
export function postgresZone(zone: string): string {
  const fixed = /^([+-])(\d{2}:\d{2})$/.exec(zone);
  return fixed ? `<${zone}>${fixed[1] === '-' ? '+' : '-'}${fixed[2]}` : zone;
}

export function offsetText(minutes: number): string {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function openDriver(dsn: string, parsed: ParsedDsn, pool: number, statementCacheSize: number, statementTimeoutMs = 0): DriverPool {
  const url = new URL(dsn);
  url.searchParams.delete('timezone');
  switch (parsed.driver) {
    case 'mysql': {
      const socket = url.searchParams.get('socket');
      const created = mysql.createPool({
        ...(socket ? { socketPath: socket } : { host: url.hostname, port: url.port ? Number(url.port) : undefined }),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        connectionLimit: pool,
        namedPlaceholders: false,
        dateStrings: true,
        decimalNumbers: true,
        jsonStrings: true,
        maxPreparedStatements: statementCacheSize,
      });
      // Without a timezone parameter the session uses the offset of the process time zone.
      const zone = () => `'${(parsed.zone !== '' ? parsed.zone : offsetText(zoneOffset('', new Date()))).replaceAll("'", "''")}'`;
      const setup: SessionSetup = {};
      (created as unknown as { pool: { on(event: 'connection', listener: (connection: { query(sql: string, done: (error: unknown) => void): void }) => void): void } }).pool
        .on('connection', connection => {
          // MySQL bounds SELECT statements with max_execution_time.
          const session = statementTimeoutMs > 0 ? `SET time_zone = ${zone()}, SESSION max_execution_time = ${statementTimeoutMs}` : `SET time_zone = ${zone()}`;
          connection.query(session, error => { if (error) setup.error = error; });
        });
      return new MySqlPoolDriver(created, setup, pool);
    }
    case 'postgres': {
      const config: pg.PoolConfig = { connectionString: url.toString(), max: pool };
      // Without a timezone parameter the session uses the process time zone.
      config.options = `-c TimeZone=${parsed.zone !== '' ? postgresZone(parsed.zone) : Intl.DateTimeFormat().resolvedOptions().timeZone}`;
      if (statementTimeoutMs > 0) config.options += ` -c statement_timeout=${statementTimeoutMs}`;
      return new PostgresPoolDriver(new pg.Pool(config), statementCacheSize, pool, config);
    }
    case 'sqlite': {
      const db = new DatabaseSync(decodeURIComponent(url.pathname));
      const version = String((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v);
      const [major, minor] = version.split('.').map(Number);
      if (major! < 3 || (major === 3 && minor! < 46)) {
        db.close();
        throw new OrmError('CAPABILITY_UNSUPPORTED', `SQLite ${version} is older than 3.46`);
      }
      db.exec('PRAGMA foreign_keys = ON');
      for (const pragma of url.searchParams.getAll('_pragma')) {
        const match = /^([a-z_]+)\(([A-Za-z0-9_]+)\)$/.exec(pragma);
        if (!match) throw new OrmError('CONFIG', `sqlite DSN _pragma ${pragma} is invalid`);
        db.exec(`PRAGMA ${match[1]} = ${match[2]}`);
      }
      return new SqlitePoolDriver(db, statementCacheSize);
    }
  }
}
