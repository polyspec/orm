// connection의 database를 dbspec 문서로 읽는다 (docs/dialects.md "Introspection").
// dialect reader가 고정된 수의 catalog query로 중립 catalog을 채우고, catalog이
// 문서를 만들어 parse한다.
import type { DatabaseSync } from 'node:sqlite';
import type { Connection as MySqlConnection, Pool as MySqlPool } from 'mysql2/promise';
import type pg from 'pg';
import { CatalogRow, type Catalog, type CatalogQuery, type DbspecUnsupported } from './introspect_catalog.js';
import { readMySQL } from './introspect_mysql.js';
import { readPostgres } from './introspect_postgres.js';
import { readSQLite } from './introspect_sqlite.js';
import type { DbspecDocument } from './model.js';
import type { DbspecDialect } from './render.js';

export type { DbspecUnsupported } from './introspect_catalog.js';

/** A mysql2 promise connection, pool connection or pool. */
export type DbspecMySqlConnection = MySqlConnection | MySqlPool;
/** A pg client, pool client or pool. */
export type DbspecPostgresConnection = pg.ClientBase | pg.Pool;
/** A node:sqlite database. */
export type DbspecSqliteConnection = DatabaseSync;

/** The introspected document and the objects it leaves out, ordered by table, kind and name. */
export interface DbspecIntrospection {
  readonly document: DbspecDocument;
  readonly unsupported: readonly DbspecUnsupported[];
}

/**
 * Reads the current database (MySQL), the current schema (PostgreSQL) or the
 * main database (SQLite) of a connection into one dbspec document named
 * `name`, with a number of catalog queries that does not depend on the table
 * count (docs/dialects.md "Introspection"). A failing query rejects with the
 * driver's error; an unknown dialect, a connection without its query method
 * and a catalog that yields no document reject with an Error.
 */
export function introspectDbspec(connection: DbspecMySqlConnection, dialect: 'mysql', name: string): Promise<DbspecIntrospection>;
export function introspectDbspec(connection: DbspecPostgresConnection, dialect: 'postgres', name: string): Promise<DbspecIntrospection>;
export function introspectDbspec(connection: DbspecSqliteConnection, dialect: 'sqlite', name: string): Promise<DbspecIntrospection>;
export async function introspectDbspec(
  connection: DbspecMySqlConnection | DbspecPostgresConnection | DbspecSqliteConnection,
  dialect: DbspecDialect,
  name: string,
): Promise<DbspecIntrospection> {
  if (typeof name !== 'string') throw new TypeError('dbspec document name must be a string');
  switch (dialect) {
    case 'mysql':
      return introspectCatalog(mysqlQuery(connection as DbspecMySqlConnection), dialect, name);
    case 'postgres':
      return introspectCatalog(postgresQuery(connection as DbspecPostgresConnection), dialect, name);
    case 'sqlite':
      return introspectCatalog(sqliteQuery(connection as DbspecSqliteConnection), dialect, name);
    default:
      throw new TypeError(`unknown dbspec dialect ${String(dialect)}`);
  }
}

/**
 * catalog query를 query로 보내 introspectDbspec과 같은 문서를 읽는다. client의 연결처럼 driver
 * 객체가 아닌 query 함수로 catalog을 읽는 쪽이 쓴다.
 */
export async function introspectCatalog(query: CatalogQuery, dialect: DbspecDialect, name: string): Promise<DbspecIntrospection> {
  let catalog: Catalog;
  switch (dialect) {
    case 'mysql':
      catalog = await readMySQL(query);
      break;
    case 'postgres':
      catalog = await readPostgres(query);
      break;
    case 'sqlite':
      catalog = await readSQLite(query);
      break;
    default:
      throw new TypeError(`unknown dbspec dialect ${String(dialect)}`);
  }
  const { document, unsupported } = catalog.document(name);
  return Object.freeze({ document, unsupported: Object.freeze(unsupported.map(u => Object.freeze({ ...u }))) });
}

function requireMethod(connection: unknown, method: string, dialect: DbspecDialect): void {
  if (connection === null || typeof connection !== 'object' || typeof (connection as Record<string, unknown>)[method] !== 'function') {
    throw new TypeError(`a ${dialect} connection must have a ${method} method`);
  }
}

/** mysql2의 text protocol query다. row는 값 배열이다. */
function mysqlQuery(connection: DbspecMySqlConnection): CatalogQuery {
  requireMethod(connection, 'query', 'mysql');
  return async sql => {
    const [rows] = await connection.query({ sql, rowsAsArray: true });
    return (rows as unknown[][]).map(values => new CatalogRow(sql, values));
  };
}

function postgresQuery(connection: DbspecPostgresConnection): CatalogQuery {
  requireMethod(connection, 'query', 'postgres');
  return async sql => {
    const result = await connection.query({ text: sql, rowMode: 'array' });
    return (result.rows as unknown[][]).map(values => new CatalogRow(sql, values));
  };
}

/** node:sqlite statement 하나를 준비해 값 배열의 row로 읽는다. 같은 이름의 결과 column이 겹치지 않도록 배열로 받는다. */
function sqliteQuery(connection: DbspecSqliteConnection): CatalogQuery {
  requireMethod(connection, 'prepare', 'sqlite');
  return async sql => {
    const statement = connection.prepare(sql);
    statement.setReturnArrays(true);
    return (statement.all() as unknown as unknown[][]).map(values => new CatalogRow(sql, values));
  };
}
