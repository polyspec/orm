// One database session for the schema tools, named by a DSN URI
// (mysql://, postgres://, sqlite:///path).
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { quoted } from '../schema/json.js';

export type ToolDriver = 'mysql' | 'postgres' | 'sqlite';
export type ToolValue = null | string | number | boolean;

export interface ToolDb {
  readonly driver: ToolDriver;
  /** Returns the rows as arrays in column order. */
  query(sql: string, params?: readonly ToolValue[]): Promise<unknown[][]>;
  /** Runs a statement and returns the affected row count. */
  exec(sql: string, params?: readonly ToolValue[]): Promise<number>;
  close(): Promise<void>;
}

/**
 * A database named by the DSN URI the clients accept: mysql://, postgres://,
 * or sqlite://<absolute path>. The scheme selects the dialect.
 */
export interface ToolDsn {
  readonly dialect: ToolDriver;
  readonly raw: string;
  readonly url: URL;
}

function configError(message: string): Error {
  return new Error(`MIGRATION_CONFIG: ${message}`);
}

export function parseToolDsn(raw: string): ToolDsn {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)?.[1];
  let url: URL | undefined;
  try { url = new URL(raw); } catch { url = undefined; }
  if (!scheme || !url) throw configError('dsn must be a URI using mysql://, postgres://, or sqlite://');
  const dialect = scheme.toLowerCase();
  const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  switch (dialect) {
    case 'mysql':
      if (url.host === '' || path === '') throw configError('mysql DSN must include host and database');
      break;
    case 'postgres':
      if ((url.host === '' && !url.searchParams.get('host')) || path === '') throw configError('postgres DSN must include host and database');
      break;
    case 'sqlite':
      if (!url.pathname.startsWith('/') || url.host !== '') throw configError('sqlite DSN must be sqlite://<absolute path>');
      break;
    default:
      throw configError(`unsupported DSN scheme ${quoted(dialect)}; want mysql, postgres, or sqlite`);
  }
  return { dialect: dialect as ToolDriver, raw, url };
}

/** The DSN without its password, as Go's URL.Redacted writes it. */
export function redactedDsn(dsn: ToolDsn): string {
  if (dsn.url.password === '') return dsn.raw;
  const copy = new URL(dsn.raw);
  copy.password = 'xxxxx';
  return copy.toString();
}

/** Opens the database named by a DSN URI. */
export async function openToolDb(raw: string): Promise<{ db: ToolDb; dsn: ToolDsn }> {
  const dsn = parseToolDsn(raw);
  try {
    switch (dsn.dialect) {
      case 'mysql': return { db: await openMySql(dsn.url), dsn };
      case 'postgres': return { db: await openPostgres(dsn.url), dsn };
      default: return { db: openSqlite(dsn.url), dsn };
    }
  } catch (error) {
    throw new Error(`MIGRATION_CONNECT: dsn=${redactedDsn(dsn)}: ${(error as Error).message}`);
  }
}

function text(value: unknown): unknown {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

async function openMySql(url: URL): Promise<ToolDb> {
  const socket = url.searchParams.get('socket');
  const connection = await mysql.createConnection({
    ...(socket ? { socketPath: socket } : { host: url.hostname, port: url.port ? Number(url.port) : undefined }),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  const zone = url.searchParams.get('timezone');
  if (zone) await connection.query(`SET time_zone = '${zone.replaceAll("'", "''")}'`);
  return {
    driver: 'mysql',
    async query(sql, params = []) {
      const [rows] = await connection.query({ sql, rowsAsArray: true }, [...params]);
      return Array.isArray(rows) ? (rows as unknown[][]).map(row => row.map(text)) : [];
    },
    async exec(sql, params = []) {
      const [result] = await connection.query(sql, [...params]);
      return Array.isArray(result) ? 0 : (result as { affectedRows: number }).affectedRows;
    },
    async close() { await connection.end(); },
  };
}

async function openPostgres(source: URL): Promise<ToolDb> {
  const url = new URL(source.toString());
  url.searchParams.delete('timezone');
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return {
    driver: 'postgres',
    async query(sql, params = []) {
      const result = await client.query({ text: sql, values: [...params], rowMode: 'array' });
      return result.rows as unknown[][];
    },
    async exec(sql, params = []) {
      const result = await client.query({ text: sql, values: [...params] });
      return result.rowCount ?? 0;
    },
    async close() { await client.end(); },
  };
}

function openSqlite(url: URL): ToolDb {
  const db = new DatabaseSync(decodeURIComponent(url.pathname), { enableForeignKeyConstraints: false });
  const rows = (sql: string, params: readonly ToolValue[]): unknown[][] => {
    const stmt = db.prepare(sql);
    const values = params.map(v => typeof v === 'boolean' ? Number(v) : v);
    if (typeof (stmt as { setReturnArrays?: unknown }).setReturnArrays === 'function') {
      (stmt as unknown as { setReturnArrays(enabled: boolean): void }).setReturnArrays(true);
      return stmt.all(...values) as unknown as unknown[][];
    }
    return (stmt.all(...values) as Array<Record<string, unknown>>).map(row => Object.values(row));
  };
  return {
    driver: 'sqlite',
    async query(sql, params = []) { return rows(sql, params); },
    async exec(sql, params = []) {
      if (params.length === 0 && !/^\s*(insert|update|delete|replace)\b/i.test(sql)) {
        db.exec(sql);
        return 0;
      }
      const stmt = db.prepare(sql);
      return Number(stmt.run(...params.map(v => typeof v === 'boolean' ? Number(v) : v)).changes);
    },
    async close() { db.close(); },
  };
}
