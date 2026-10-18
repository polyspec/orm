// Reads the connection's database as a dbspec document (docs/dialects.md "Introspection").
// The dialect reader fills the neutral catalog with a fixed number of catalog queries, and the catalog
// makes a document and parses it.
import { isMySqlConnection, isPostgresConnection, isSqliteConnection, rowArrays, type DbspecMySqlConnection, type DbspecPostgresConnection, type DbspecSqliteConnection } from './connections.js';
import { CatalogRow, type Catalog, type CatalogQuery, type DbspecUnsupported } from './introspect_catalog.js';
import { readMySQL } from './introspect_mysql.js';
import { readPostgres } from './introspect_postgres.js';
import { readSQLite } from './introspect_sqlite.js';
import type { DbspecDocument } from './model.js';
import type { DbspecDialect } from './render.js';

export type { DbspecUnsupported } from './introspect_catalog.js';

export type { DbspecMySqlConnection, DbspecPostgresConnection, DbspecSqliteConnection } from './connections.js';

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
      if (!isMySqlConnection(connection)) throw missingMethod(dialect, 'query');
      return introspectCatalog(mysqlQuery(connection), dialect, name);
    case 'postgres':
      if (!isPostgresConnection(connection)) throw missingMethod(dialect, 'query');
      return introspectCatalog(postgresQuery(connection), dialect, name);
    case 'sqlite':
      if (!isSqliteConnection(connection)) throw missingMethod(dialect, 'prepare');
      return introspectCatalog(sqliteQuery(connection), dialect, name);
    default:
      throw new TypeError(`unknown dbspec dialect ${String(dialect)}`);
  }
}

/**
 * Sends the catalog queries as query and reads the same document as introspectDbspec. Unlike a client connection, which is a driver
 * object, it is used by the side that reads the catalog through a query function.
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

function missingMethod(dialect: DbspecDialect, method: string): TypeError {
  return new TypeError(`a ${dialect} connection must have a ${method} method`);
}

/** The text protocol query of mysql2. A row is an array of values. */
function mysqlQuery(connection: DbspecMySqlConnection): CatalogQuery {
  return async sql => {
    const [rows] = await connection.query({ sql, rowsAsArray: true });
    return rowArrays(rows, 'mysql').map(values => new CatalogRow(sql, values));
  };
}

function postgresQuery(connection: DbspecPostgresConnection): CatalogQuery {
  return async sql => {
    const result = await connection.query({ text: sql, rowMode: 'array' });
    return rowArrays(result.rows, 'postgres').map(values => new CatalogRow(sql, values));
  };
}

/** Prepares one node:sqlite statement and reads its rows as arrays of values. It takes arrays so that result columns with the same name do not collide. */
function sqliteQuery(connection: DbspecSqliteConnection): CatalogQuery {
  return async sql => {
    const statement = connection.prepare(sql);
    statement.setReturnArrays(true);
    return rowArrays(statement.all(), 'sqlite').map(values => new CatalogRow(sql, values));
  };
}
