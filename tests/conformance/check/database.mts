// The connection of the checker to a bench database: the state digest and the counters read and restore through it, and the
// physical tests write through it. Every value is read as the database sends it, without a conversion that could lose
// precision: MySQL values are the bytes of the text protocol, PostgreSQL values their text form, SQLite integers bigint.
import { DatabaseSync } from 'node:sqlite';
import { inspect } from 'node:util';
import mysql from 'mysql2/promise';
import pg from 'pg';

/** The rows of a statement: its column names and each row as an array of values. */
export type Rows = { columns: string[]; rows: unknown[][] };

/** A connection to one database. */
export type StateDatabase = {
  readonly driver: string;
  /** query runs a statement that returns rows; params bind ? (MySQL, SQLite) or $n (PostgreSQL). */
  query(sql: string, params?: unknown[]): Promise<Rows>;
  /** exec runs a statement and returns the id of the row it inserted, when the database reports one (MySQL, SQLite). */
  exec(sql: string, params?: unknown[]): Promise<{ lastInsertId: bigint | null }>;
  close(): Promise<void>;
};

/** text reads a value of a row as text: a string, the UTF-8 of bytes or an integer. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  throw new Error(`a value that is not text: ${String(value)}`);
}

/**
 * openStateDatabase opens the database of a DSN URI whose scheme must be the driver. MySQL takes the account, the database
 * and the host or a socket (?socket=); PostgreSQL takes the URI without its timezone; SQLite takes an absolute path and
 * runs each `_pragma` of the query.
 */
export async function openStateDatabase(driver: string, raw: string): Promise<StateDatabase> {
  const url = new URL(raw);
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== driver) throw new Error(`state DSN scheme ${JSON.stringify(scheme)} differs from database ${JSON.stringify(driver)}`);
  switch (driver) {
    case 'mysql': {
      const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const socket = url.searchParams.get('socket') ?? '';
      if (database === '' || (url.host === '' && socket === '')) throw new Error('state DSN must name a database and host or socket');
      const connection = await mysql.createConnection({
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database,
        ...(socket === '' ? { host: url.hostname, port: url.port === '' ? 3306 : Number(url.port) } : { socketPath: socket }),
        // The text protocol sends every value as bytes; without a cast none loses precision.
        typeCast: false, rowsAsArray: true,
      });
      return {
        driver,
        async query(sql, params = []) {
          const [rows, fields] = await connection.query({ sql, rowsAsArray: true }, params);
          if (!Array.isArray(rows) || !Array.isArray(fields)) throw new Error(`${sql}: the statement returned no rows`);
          return { columns: fields.map(field => field.name), rows: rows.filter(row => Array.isArray(row)) };
        },
        async exec(sql, params = []) {
          const [result] = await connection.query(sql, params);
          return { lastInsertId: 'insertId' in result && typeof result.insertId === 'number' ? BigInt(result.insertId) : null };
        },
        close: () => connection.end(),
      };
    }
    case 'postgres': {
      url.searchParams.delete('timezone');
      const client = new pg.Client({ connectionString: url.href });
      await client.connect();
      // Every value is its text form.
      const types = { getTypeParser: () => (value: string) => value };
      return {
        driver,
        async query(sql, params = []) {
          const result = await client.query({ text: sql, values: params, rowMode: 'array', types });
          return { columns: result.fields.map(field => field.name), rows: result.rows };
        },
        async exec(sql, params = []) {
          await client.query({ text: sql, values: params, types });
          return { lastInsertId: null };
        },
        close: () => client.end(),
      };
    }
    case 'sqlite': {
      if (url.host !== '' || !url.pathname.startsWith('/')) throw new Error('state SQLite DSN must use an absolute path');
      url.searchParams.delete('timezone');
      const pragmas: string[] = [];
      for (const [key, value] of url.searchParams) {
        if (key !== '_pragma') throw new Error(`state SQLite DSN has the unsupported query ${JSON.stringify(key)}`);
        pragmas.push(value);
      }
      const db = new DatabaseSync(decodeURIComponent(url.pathname));
      for (const pragma of pragmas) db.exec(`PRAGMA ${pragma}`);
      return sqliteDatabase(db);
    }
    default:
      throw new Error(`unsupported state database ${JSON.stringify(driver)}`);
  }
}

/** sqliteDatabase is a StateDatabase on an open SQLite database; integers read as bigint. */
export function sqliteDatabase(db: DatabaseSync): StateDatabase {
  const bind = (params: unknown[]): (null | number | bigint | string | Uint8Array)[] => params.map(value => {
    if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    throw new Error(`a SQLite parameter of an unsupported type: ${inspect(value)}`);
  });
  return {
    driver: 'sqlite',
    async query(sql, params = []) {
      const statement = db.prepare(sql);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      const rows: unknown[][] = [];
      for (const row of statement.all(...bind(params))) if (Array.isArray(row)) rows.push(row);
      return { columns: statement.columns().map(column => column.name), rows };
    },
    async exec(sql, params = []) {
      const statement = db.prepare(sql);
      statement.setReadBigInts(true);
      const result = statement.run(...bind(params));
      return { lastInsertId: BigInt(result.lastInsertRowid) };
    },
    async close() {
      db.close();
    },
  };
}
