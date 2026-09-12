import { DatabaseSync } from 'node:sqlite';
import mysql, { type Pool as MySqlPool, type PoolConnection as MySqlConnection } from 'mysql2/promise';
import pg from 'pg';
import { OrmError } from './runtime_error.js';

export type DriverName = 'mysql' | 'postgres' | 'sqlite';
export type DriverValue = null | boolean | number | string | bigint | Uint8Array | Date;

export interface DriverResult {
  rows: unknown[][];
  columns: string[];
  affected: number;
  insertId: number | bigint | string | null;
}

export interface DriverConnection {
  readonly name: DriverName;
  execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult>;
  begin(): Promise<DriverTransaction>;
  close(): Promise<void>;
}

export interface DriverTransaction extends DriverConnection {
  commit(): Promise<void>;
  rollback(): Promise<void>;
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
  public async begin(): Promise<DriverTransaction> {
    if (!('getConnection' in this.connection)) throw new OrmError('CONFIG', 'nested transactions are not supported');
    const connection = await this.connection.getConnection();
    await connection.beginTransaction();
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
  public async commit(): Promise<void> { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); await this.tx.commit(); this.finish(); }
  public async rollback(): Promise<void> { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); await this.tx.rollback(); this.finish(); }
  private finish(): void { this.active = false; this.tx.release(); }
}

type PgExecutor = pg.Pool | pg.PoolClient;
class PostgresDriver implements DriverConnection {
  public readonly name = 'postgres' as const;
  public constructor(protected readonly connection: PgExecutor, private readonly owner = false) {}
  public async execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
    try {
      const result = await this.connection.query({ text: sql, values: [...params], rowMode: 'array' });
      return { rows: result.rows as unknown[][], columns: result.fields.map(field => field.name), affected: result.rowCount ?? 0, insertId: result.rows[0]?.[0] as DriverResult['insertId'] ?? null };
    } catch (error) { throw driverError(this.name, error); }
  }
  public async begin(): Promise<DriverTransaction> {
    if (!(this.connection instanceof pg.Pool)) throw new OrmError('CONFIG', 'nested transactions are not supported');
    const connection: pg.PoolClient = await this.connection.connect();
    await connection.query('BEGIN');
    return new PostgresTx(connection);
  }
  public async close(): Promise<void> { if (this.owner && 'end' in this.connection) await this.connection.end(); }
}
class PostgresTx extends PostgresDriver implements DriverTransaction {
  private active = true;
  public constructor(private readonly tx: pg.PoolClient) { super(tx); }
  public override async execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
    if (!this.active) throw new OrmError('CONFIG', 'transaction already finished');
    return super.execute(sql, params);
  }
  public async commit(): Promise<void> { await this.end('COMMIT'); }
  public async rollback(): Promise<void> { await this.end('ROLLBACK'); }
  private async end(sql: string): Promise<void> { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); await this.tx.query(sql); this.active = false; this.tx.release(); }
}

class SqliteDriver implements DriverConnection {
  public readonly name = 'sqlite' as const;
  private active = true;
  public constructor(protected readonly connection: DatabaseSync, private readonly owner = false, private readonly transaction = false) {}
  public async execute(sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
    if (!this.active) throw new OrmError('CONFIG', 'transaction already finished');
    try {
      const statement = this.connection.prepare(sql);
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
  public async begin(): Promise<DriverTransaction> {
    if (this.transaction) throw new OrmError('CONFIG', 'nested transactions are not supported');
    this.connection.exec('BEGIN IMMEDIATE');
    return new SqliteTx(this.connection);
  }
  public async close(): Promise<void> { if (this.owner) this.connection.close(); }
  protected finish(): void { this.active = false; }
}
class SqliteTx extends SqliteDriver implements DriverTransaction {
  public constructor(connection: DatabaseSync) { super(connection, false, true); }
  public async commit(): Promise<void> { this.connection.exec('COMMIT'); this.finish(); }
  public async rollback(): Promise<void> { this.connection.exec('ROLLBACK'); this.finish(); }
}

export function openMySql(uri: string): DriverConnection {
  return new MySqlDriver(mysql.createPool({ uri, connectionLimit: 10, namedPlaceholders: false }), true);
}
export function openPostgres(connectionString: string): DriverConnection {
  return new PostgresDriver(new pg.Pool({ connectionString, max: 10 }), true);
}
export function openSqlite(path: string): DriverConnection {
  if (!path.startsWith('/')) throw new OrmError('CONFIG', `sqlite path must be absolute: ${path}`);
  const connection = new DatabaseSync(path);
  connection.exec('PRAGMA busy_timeout=5000');
  connection.exec('PRAGMA journal_mode=WAL');
  return new SqliteDriver(connection, true);
}

function sqlDate(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '').replace(/\.([0-9]{3})$/, '.$1000');
}
