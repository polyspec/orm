// dbspec apply와 introspection이 받는 connection의 type이다. 이 type은 driver module의 type을
// 쓰지 않고 dbspec이 부르는 method만 적는다. 공개 선언이 pg, mysql2, node:sqlite를 import하면
// 그 driver의 type 없이(MySQL이나 SQLite driver만 설치해) 하는 type 검사가 실패하기 때문이다.
// mysql2 promise connection과 pool, pg client와 pool, node:sqlite DatabaseSync가 이 type에 맞는다
// (tests/typecheck.ts가 확인한다).

/** The rows and fields that a mysql2 promise query resolves to. */
export type DbspecMySqlQueryResult = readonly unknown[];

/** A mysql2 promise connection, pool connection or pool: the query method that dbspec calls. */
export interface DbspecMySqlConnection {
  query(options: { sql: string; rowsAsArray?: boolean }, values?: unknown[]): Promise<DbspecMySqlQueryResult>;
}

/** A pg client, pool client or pool: the query method that dbspec calls. */
export interface DbspecPostgresConnection {
  query(config: { text: string; values?: unknown[]; rowMode?: 'array' }): Promise<{ rows: unknown[] }>;
}

/** A prepared node:sqlite statement: the methods that dbspec calls. */
export interface DbspecSqliteStatement {
  setReturnArrays(enabled: boolean): void;
  all(...parameters: (string | number)[]): unknown[];
  run(...parameters: (string | number)[]): unknown;
}

/** A node:sqlite database: the methods that dbspec calls. */
export interface DbspecSqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): DbspecSqliteStatement;
}

/** Whether `value` is an object with a function property `method`. */
function hasMethod(value: unknown, method: string): boolean {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, method) === 'function';
}

/**
 * Whether `value` has the query method of a mysql2 connection.
 *
 * @internal
 */
export function isMySqlConnection(value: unknown): value is DbspecMySqlConnection {
  return hasMethod(value, 'query');
}

/**
 * Whether `value` has the query method of a node-postgres client.
 *
 * @internal
 */
export function isPostgresConnection(value: unknown): value is DbspecPostgresConnection {
  return hasMethod(value, 'query');
}

/**
 * Whether `value` has the prepare method of a node:sqlite database.
 *
 * @internal
 */
export function isSqliteConnection(value: unknown): value is DbspecSqliteConnection {
  return hasMethod(value, 'prepare');
}

/**
 * The rows that a driver returned as arrays of values; throws an Error that names `source` when they are not.
 *
 * @internal
 */
export function rowArrays(value: unknown, source: string): unknown[][] {
  if (!Array.isArray(value)) throw new Error(`${source} returned no array of rows`);
  const rows: readonly unknown[] = value;
  return rows.map(row => {
    if (!Array.isArray(row)) throw new Error(`${source} returned a row that is not an array of values`);
    const values: unknown[] = row;
    return values;
  });
}
