import { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import mysql, { type Pool as MySqlPool, type PoolConnection as MySqlConnection } from 'mysql2/promise';
import type { PoolConnection as MySqlCoreConnection } from 'mysql2';
import pg from 'pg';
import QueryStream from 'pg-query-stream';
import { OrmError } from './runtime_error.js';
import { createHash } from 'node:crypto';

pg.types.setTypeParser(20, value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new OrmError('DRIVER', `postgres int8 is outside the TypeScript safe integer range: ${value}`);
  return parsed;
});
pg.types.setTypeParser(1700, value => Number(value));
pg.types.setTypeParser(1082, value => value);
pg.types.setTypeParser(1114, value => value);
pg.types.setTypeParser(114, value => value);
pg.types.setTypeParser(3802, value => value);

export type DriverName = 'mysql' | 'postgres' | 'sqlite';
export type DriverIsolation = 'default' | 'read_uncommitted' | 'read_committed' | 'repeatable_read' | 'serializable';
export interface DriverTransactionOptions { isolation?: DriverIsolation; readOnly?: boolean; }
export type DriverValue = null | boolean | number | string | bigint | Uint8Array | Date;

export interface DriverResult {
  rows: unknown[][];
  columns: string[];
  affected: number;
  insertId: number | bigint | string | null;
}

export interface DriverStreamResult { count: number; exhausted: boolean; }
export type DriverRowVisitor = (row: unknown[]) => boolean | Promise<boolean>;

export interface DriverConnection {
  readonly name: DriverName;
  execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult>;
  stream(sql: string, params: readonly DriverValue[], visit: DriverRowVisitor): Promise<DriverStreamResult>;
  begin(options?: DriverTransactionOptions): Promise<DriverTransaction>;
  close(): Promise<void>;
}

export interface DriverTransaction extends DriverConnection {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  savepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
  releaseSavepoint(name: string): Promise<void>;
}

function savepointName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new OrmError('CONFIG', 'savepoint name must match [A-Za-z_][A-Za-z0-9_]*');
  return name;
}

async function closeReadable(readable: Readable | undefined): Promise<void> {
  if (readable === undefined || readable.closed) return;
  await new Promise<void>(resolve => {
    readable.once('close', resolve);
    if (!readable.destroyed) readable.destroy();
  });
}

function driverError(name: DriverName, error: unknown): OrmError {
  const source = error as { code?: string; errno?: number; message?: string };
  const duplicate = source.code === 'ER_DUP_ENTRY' || source.code === '23505' || source.code === 'SQLITE_CONSTRAINT_UNIQUE';
  const deadlock = source.code === 'ER_LOCK_DEADLOCK' || source.code === '40P01' || source.code === 'SQLITE_BUSY';
  return new OrmError(duplicate ? 'DUPLICATE' : deadlock ? 'DEADLOCK' : 'DRIVER', `${name}: ${source.message ?? String(error)}`, error);
}

type MySqlExecutor = MySqlPool | MySqlConnection;
class MySqlDriver implements DriverConnection {
  public readonly name = 'mysql' as const;
  public constructor(protected readonly connection: MySqlExecutor, private readonly owner = false) {}
  public async execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
    try {
      const [value, fields] = await this.connection.execute({ sql, rowsAsArray: true }, [...params]);
      if (Array.isArray(value)) {
        return { rows: value as unknown[][], columns: (fields ?? []).map(field => field.name), affected: 0, insertId: null };
      }
      const result = value as { affectedRows: number; insertId: number };
      return { rows: [], columns: [], affected: result.affectedRows, insertId: result.insertId || null };
    } catch (error) { throw driverError(this.name, error); }
  }
  public async stream(sql: string, params: readonly DriverValue[], visit: DriverRowVisitor): Promise<DriverStreamResult> {
    let borrowed: MySqlConnection | undefined;
    let readable: Readable | undefined;
    let count = 0;
    let visitorError: unknown;
    try {
      const executor = 'getConnection' in this.connection ? (borrowed = await this.connection.getConnection()) : this.connection;
      const core = executor.connection as unknown as MySqlCoreConnection;
      readable = core.query({ sql, values: [...params], rowsAsArray: true }).stream({ highWaterMark: 1 });
      for await (const row of readable) {
        count++;
        let keep: boolean;
        try { keep = await visit(row as unknown[]); } catch (error) { visitorError = error; throw error; }
        if (!keep) return { count, exhausted: false };
      }
      return { count, exhausted: true };
    } catch (error) { if (error === visitorError) throw error; throw driverError(this.name, error); }
    finally {
      await closeReadable(readable);
      borrowed?.release();
    }
  }
  public async begin(options: DriverTransactionOptions = {}): Promise<DriverTransaction> {
    if (!('getConnection' in this.connection)) throw new OrmError('CONFIG', 'nested transactions are not supported');
    const connection = await this.connection.getConnection();
    try {
      await configureTransaction(connection, this.name, options);
      await connection.beginTransaction();
    } catch (error) {
      connection.release();
      throw error;
    }
    return new MySqlTx(connection);
  }
  public async close(): Promise<void> { if (this.owner && 'end' in this.connection) await this.connection.end(); }
}
class MySqlTx extends MySqlDriver implements DriverTransaction {
  private active = true;
  public constructor(private readonly tx: MySqlConnection) { super(tx); }
  public override async execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
    if (!this.active) throw new OrmError('CONFIG', 'transaction already finished');
    return super.execute(sql, params);
  }
  public override async stream(sql: string, params: readonly DriverValue[], visit: DriverRowVisitor): Promise<DriverStreamResult> {
    if (!this.active) throw new OrmError('CONFIG', 'transaction already finished');
    return super.stream(sql, params, visit);
  }
  public async commit(): Promise<void> { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); await this.tx.commit(); this.finish(); }
  public async rollback(): Promise<void> { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); await this.tx.rollback(); this.finish(); }
  public async savepoint(name: string): Promise<void> { this.assertControl(); await this.tx.query(`SAVEPOINT ${savepointName(name)}`); }
  public async rollbackTo(name: string): Promise<void> { this.assertControl(); await this.tx.query(`ROLLBACK TO SAVEPOINT ${savepointName(name)}`); }
  public async releaseSavepoint(name: string): Promise<void> { this.assertControl(); await this.tx.query(`RELEASE SAVEPOINT ${savepointName(name)}`); }
  private assertControl(): void { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); }
  private finish(): void { this.active = false; this.tx.release(); }
}

type PgExecutor = pg.Pool | pg.PoolClient;
class StatementNames {
  private readonly names = new Map<string, string>();
  public constructor(public readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new OrmError('CONFIG', 'statement cache size must be a positive integer');
  }
  public name(sql: string): string {
    const existing = this.names.get(sql);
    if (existing !== undefined) {
      this.names.delete(sql);
      this.names.set(sql, existing);
      return existing;
    }
    // PostgreSQL limits prepared statement names to 63 bytes. The 59 hex
    // characters after the prefix retain 236 bits of hash space.
    const name = `orm_${createHash('sha256').update(sql).digest('hex').slice(0, 59)}`;
    this.names.set(sql, name);
    return name;
  }
  public evicted(): string | undefined {
    if (this.names.size <= this.limit) return undefined;
    const oldest = this.names.entries().next().value as [string, string] | undefined;
    if (oldest !== undefined) this.names.delete(oldest[0]);
    return oldest?.[1];
  }
}
class PostgresDriver implements DriverConnection {
  public readonly name = 'postgres' as const;
  private readonly statementCacheSize: number;
  private readonly statements = new WeakMap<object, StatementNames>();
  public constructor(protected readonly connection: PgExecutor, private readonly owner = false, statementCacheSize = 256) {
    if (!Number.isSafeInteger(statementCacheSize) || statementCacheSize < 1) throw new OrmError('CONFIG', 'statement cache size must be a positive integer');
    this.statementCacheSize = statementCacheSize;
  }
  private statementCache(client: PgExecutor): StatementNames {
    const key = client as object;
    let cache = this.statements.get(key);
    if (cache === undefined) {
      cache = new StatementNames(this.statementCacheSize);
      this.statements.set(key, cache);
    }
    return cache;
  }
  public async execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
    const client = this.connection instanceof pg.Pool ? await this.connection.connect() : this.connection;
    try {
      const statements = this.statementCache(client);
      const name = statements.name(sql);
      const result = await client.query({ name, text: sql, values: [...params], rowMode: 'array' });
      const evicted = statements.evicted();
      if (evicted !== undefined) await client.query(`DEALLOCATE "${evicted}"`);
      return { rows: result.rows as unknown[][], columns: result.fields.map(field => field.name), affected: result.rowCount ?? 0, insertId: result.rows[0]?.[0] as DriverResult['insertId'] ?? null };
    } catch (error) { throw driverError(this.name, error); } finally { if (this.connection instanceof pg.Pool) client.release(); }
  }
  public async stream(sql: string, params: readonly DriverValue[], visit: DriverRowVisitor): Promise<DriverStreamResult> {
    let borrowed: pg.PoolClient | undefined;
    const executor = this.connection instanceof pg.Pool ? (borrowed = await this.connection.connect()) : this.connection;
    const readable = executor.query(new QueryStream(sql, [...params], { rowMode: 'array', batchSize: 64 }));
    let count = 0;
    let visitorError: unknown;
    try {
      for await (const row of readable) {
        count++;
        let keep: boolean;
        try { keep = await visit(row as unknown[]); } catch (error) { visitorError = error; throw error; }
        if (!keep) return { count, exhausted: false };
      }
      return { count, exhausted: true };
    } catch (error) { if (error === visitorError) throw error; throw driverError(this.name, error); }
    finally {
      await closeReadable(readable);
      borrowed?.release();
    }
  }
  public async begin(options: DriverTransactionOptions = {}): Promise<DriverTransaction> {
    if (!(this.connection instanceof pg.Pool)) throw new OrmError('CONFIG', 'nested transactions are not supported');
    const connection: pg.PoolClient = await this.connection.connect();
    try {
      await configureTransaction(connection, this.name, options);
      await connection.query('BEGIN');
    } catch (error) {
      connection.release();
      throw error;
    }
    return new PostgresTx(connection, undefined, this.statementCacheSize);
  }
  public async close(): Promise<void> { if (this.owner && 'end' in this.connection) await this.connection.end(); }
}
class PostgresTx extends PostgresDriver implements DriverTransaction {
  private active = true;
  public constructor(private readonly tx: pg.PoolClient, owner?: boolean, statementCacheSize = 256) { super(tx, owner, statementCacheSize); }
  public override async execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
    if (!this.active) throw new OrmError('CONFIG', 'transaction already finished');
    return super.execute(sql, params);
  }
  public override async stream(sql: string, params: readonly DriverValue[], visit: DriverRowVisitor): Promise<DriverStreamResult> {
    if (!this.active) throw new OrmError('CONFIG', 'transaction already finished');
    return super.stream(sql, params, visit);
  }
  public async commit(): Promise<void> { await this.end('COMMIT'); }
  public async rollback(): Promise<void> { await this.end('ROLLBACK'); }
  public async savepoint(name: string): Promise<void> { this.assertControl(); await this.tx.query(`SAVEPOINT ${savepointName(name)}`); }
  public async rollbackTo(name: string): Promise<void> { this.assertControl(); await this.tx.query(`ROLLBACK TO SAVEPOINT ${savepointName(name)}`); }
  public async releaseSavepoint(name: string): Promise<void> { this.assertControl(); await this.tx.query(`RELEASE SAVEPOINT ${savepointName(name)}`); }
  private assertControl(): void { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); }
  private async end(sql: string): Promise<void> { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); await this.tx.query(sql); this.active = false; this.tx.release(); }
}

class SqliteDriver implements DriverConnection {
  public readonly name = 'sqlite' as const;
  protected active = true;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private readonly statementOrder: string[] = [];
  public constructor(protected readonly connection: DatabaseSync, private readonly owner = false, private readonly transaction = false, private readonly statementCacheSize = 256) {
    if (!Number.isSafeInteger(statementCacheSize) || statementCacheSize < 1) throw new OrmError('CONFIG', 'statement cache size must be a positive integer');
  }
  private statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    const existing = this.statements.get(sql);
    if (existing !== undefined) return existing;
    const statement = this.connection.prepare(sql);
    this.statements.set(sql, statement);
    this.statementOrder.push(sql);
    while (this.statementOrder.length > this.statementCacheSize) {
      const oldest = this.statementOrder.shift();
      if (oldest !== undefined) this.statements.delete(oldest);
    }
    return statement;
  }
  public async execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
    if (!this.active) throw new OrmError('CONFIG', 'transaction already finished');
    try {
      const statement = this.statement(sql);
      const values = params.map(value => value instanceof Date ? sqlDate(value) : typeof value === 'boolean' ? Number(value) : value);
      if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
        statement.setReturnArrays(true);
        const rows = statement.all(...values) as unknown as unknown[][];
        return { rows, columns: statement.columns().map(column => column.name), affected: rows.length, insertId: rows[0]?.[0] as DriverResult['insertId'] ?? null };
      }
      const result = statement.run(...values);
      return { rows: [], columns: [], affected: Number(result.changes), insertId: result.lastInsertRowid };
    } catch (error) { throw driverError(this.name, error); }
  }
  public async stream(sql: string, params: readonly DriverValue[], visit: DriverRowVisitor): Promise<DriverStreamResult> {
    if (!this.active) throw new OrmError('CONFIG', 'transaction already finished');
    let visitorError: unknown;
    try {
      const statement = this.statement(sql);
      statement.setReturnArrays(true);
      const values = params.map(value => value instanceof Date ? sqlDate(value) : typeof value === 'boolean' ? Number(value) : value);
      let count = 0;
      for (const row of statement.iterate(...values) as unknown as Iterable<unknown[]>) {
        count++;
        try {
          if (!await visit(row)) return { count, exhausted: false };
        } catch (error) { visitorError = error; throw error; }
      }
      return { count, exhausted: true };
    } catch (error) {
      if (typeof visitorError !== 'undefined' && error === visitorError) throw error;
      throw driverError(this.name, error);
    }
  }
  public async begin(options: DriverTransactionOptions = {}): Promise<DriverTransaction> {
    if (this.transaction) throw new OrmError('CONFIG', 'nested transactions are not supported');
    if (options.isolation !== undefined && options.isolation !== 'default' || options.readOnly) throw new OrmError('CAPABILITY_UNSUPPORTED', 'sqlite does not support transaction isolation or read-only mode');
    this.connection.exec('BEGIN IMMEDIATE');
    return new SqliteTx(this.connection);
  }
  public async close(): Promise<void> { if (this.owner) this.connection.close(); }
  protected finish(): void { this.active = false; }
}

async function configureTransaction(connection: { query(sql: string): Promise<unknown> }, driver: DriverName, options: DriverTransactionOptions): Promise<void> {
  const isolation = options.isolation ?? 'default';
  if (isolation !== 'default') await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation.replaceAll('_', ' ').toUpperCase()}`);
  if (options.readOnly) await connection.query('SET TRANSACTION READ ONLY');
}
class SqliteTx extends SqliteDriver implements DriverTransaction {
  public constructor(connection: DatabaseSync, statementCacheSize = 256) { super(connection, false, true, statementCacheSize); }
  public async commit(): Promise<void> { this.connection.exec('COMMIT'); this.finish(); }
  public async rollback(): Promise<void> { this.connection.exec('ROLLBACK'); this.finish(); }
  public async savepoint(name: string): Promise<void> { this.assertControl(); this.connection.exec(`SAVEPOINT ${savepointName(name)}`); }
  public async rollbackTo(name: string): Promise<void> { this.assertControl(); this.connection.exec(`ROLLBACK TO SAVEPOINT ${savepointName(name)}`); }
  public async releaseSavepoint(name: string): Promise<void> { this.assertControl(); this.connection.exec(`RELEASE SAVEPOINT ${savepointName(name)}`); }
  private assertControl(): void { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); }
}

export function openMySql(uri: string, pool = 10, statementCacheSize = 256): DriverConnection {
  return new MySqlDriver(mysql.createPool({
    uri,
    connectionLimit: pool,
    namedPlaceholders: false,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
    jsonStrings: true,
    maxPreparedStatements: statementCacheSize,
  }), true);
}
export function openPostgres(connectionString: string, pool = 10, statementCacheSize = 256): DriverConnection {
  return new PostgresDriver(new pg.Pool({ connectionString, max: pool }), true, statementCacheSize);
}
export function openSqlite(path: string, statementCacheSize = 256): DriverConnection {
  if (!path.startsWith('/')) throw new OrmError('CONFIG', `sqlite path must be absolute: ${path}`);
  const connection = new DatabaseSync(path);
  connection.exec('PRAGMA busy_timeout=5000');
  connection.exec('PRAGMA journal_mode=WAL');
  return new SqliteDriver(connection, true, false, statementCacheSize);
}

function sqlDate(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '').replace(/\.([0-9]{3})$/, '.$1000');
}
