// The type of connection that dbspec apply and introspection take. This type does not use the driver module's type,
// and lists only the methods that dbspec calls. If a public declaration imports pg, mysql2, or node:sqlite,
// a type check fails without that driver's type (when only the MySQL or SQLite driver is installed).
// mysql2 promise connections and pools, pg clients and pools, and node:sqlite DatabaseSync all match this type
// (checked by tests/typecheck.ts).

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
