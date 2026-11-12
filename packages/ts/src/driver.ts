import { isUtf8 } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, isIP } from 'node:net';
import mysql, { type Pool as MySqlPool, type PoolConnection as MySqlConnection } from 'mysql2/promise';
import type { FieldPacket, QueryResult } from 'mysql2';
import pg from 'pg';
import { PostgresListener } from './listen.js';
import { OrmError } from './runtime_error.js';
import { sqliteResultCodeSuffix } from './sqlite-codes.js';
import { parseMarkdownDsn, type MarkdownDsn } from './markdown.js';
import * as codes from './codes.js';
import type { MySqlServer } from './engine/dialect.js';
import { quote as messageQuote } from './message.js';

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

/** A column of a result: its name, and its native type name as the driver reports it (MySQL and PostgreSQL names, the SQLite declared type). */
export interface DriverColumn { name: string; type: string; }

export interface DriverResult {
  rows: unknown[][];
  affected: number;
  insertId: number | bigint | string | null;
  columns: DriverColumn[];
}

/**
 * Receives a streamed result: columns once, before the first row, then each row. A row returns false to stop the result; the
 * statement then ends and the connection is no longer usable for the rows that remain, so the caller discards it. On MySQL, stop
 * runs when a row stops the result: when it answers true, it has killed the statement, and the scan reads the end of the
 * statement, so the connection stays usable (CFG-35).
 */
export interface RowSink {
  columns(columns: DriverColumn[]): void;
  row(values: unknown[]): boolean;
  stop?(): Promise<boolean>;
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
  /**
   * Runs one prepared statement; an aborted signal cancels it and raises CANCELED. nowait says that the statement takes a row lock
   * `*_nowait`, whose failure MariaDB reports as 1205 (DIA-209).
   */
  execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone, nowait?: boolean): Promise<DriverResult>;
}

export interface DriverPool extends DriverConnection {
  /**
   * The server that the pool reached (DIA-201, DIA-203): on mysql, mysql or mariadb as the session setup read it by VERSION(), which
   * a reserve waits for, so it is known once Db.connect has reserved its connection; on postgres and sqlite, the driver's name.
   */
  readonly server: MySqlServer | 'postgres' | 'sqlite';
  /**
   * Takes one connection. It is used by a transaction, and by statements that must run on one connection outside a transaction (MySQL
   * schema statements and the catalog they read, and the SQLite statement that turns off foreign keys).
   */
  reserve(): Promise<DriverSession>;
  /** Opens a LISTEN connection of its own, outside the pool (DIA-194); only PostgreSQL has one. */
  openListener?(): Promise<PostgresListener>;
  stats(): PoolStats;
  close(): Promise<void>;
}

/** One held connection. It is returned with release when finished. */
export interface DriverSession extends DriverConnection {
  /** Runs a statement that is not prepared (transaction control, savepoints, locks, session values, schema statements). */
  control(sql: string, params: readonly DriverValue[], done: StatementDone): Promise<DriverResult>;
  /** Streams the rows of one statement into sink, which may stop it early (see RowSink). */
  scan(sql: string, params: readonly DriverValue[], sink: RowSink, done: StatementDone): Promise<void>;
  /** Whether the SQLite connection is inside a transaction. Other drivers do not report it. */
  inTransaction?(): boolean;
  /**
   * The MySQL connection id of the connection: the thread id of its handshake, which is the id of the server session, or, through
   * ProxySQL, the id of the ProxySQL session, which its KILL QUERY names (CFG-35). Other drivers have none.
   */
  readonly threadId?: number;
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
 *
 * @internal
 */
export async function observed<T>(name: DriverName, sql: string, done: StatementDone, origin: SentOrigin, work: () => Promise<T> | T, server?: MySqlServer, nowait = false): Promise<T> {
  const started = performance.now();
  let result: T;
  try {
    result = await work();
  } catch (error) {
    const mapped = driverError(name, error, server, nowait);
    done(sql, seconds(started), mapped, origin);
    throw mapped;
  }
  done(sql, seconds(started), null, origin);
  return result;
}

/** Milliseconds a SQLite connection waits for a lock when the DSN sets no _pragma=busy_timeout(ms). */
const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Checks the SQLite library version. @internal */
export function checkSqliteVersion(version: string): void {
  const parts = version.split('.');
  const numbers = parts.map(Number);
  if (
    (parts.length !== 3 && parts.length !== 4)
    || parts.some(part => !/^[0-9]+$/.test(part))
    || numbers.some(number => number > 0xffff_ffff)
  ) {
    throw new OrmError(codes.INTERNAL, `SQLite library version ${messageQuote(version)} is invalid; expected three or four decimal components that each fit u32`);
  }
  const [major = 0, minor = 0] = numbers;
  if (major < 3 || (major === 3 && minor < 46)) {
    throw new OrmError(codes.CAPABILITY_UNSUPPORTED, `SQLite ${version} is older than 3.46`);
  }
}

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
 * 57P01 (admin_shutdown), 57P02 (crash_shutdown), 57P05 (idle_session_timeout) and 25P03 (idle_in_transaction_session_timeout) as lost connections.
 */
function connectionLost(name: DriverName, source: { code: string | undefined; errno: number | undefined; fatal: boolean }, server: MySqlServer): boolean {
  if (name === 'mysql') {
    // 4031 is MySQL's ER_CLIENT_INTERACTION_TIMEOUT; MariaDB's 4031 is a trigger error (DIA-201).
    return (server === 'mysql' && source.errno === 4031) || (source.fatal === true && (source.code === undefined || source.code === 'PROTOCOL_CONNECTION_LOST' || source.code === 'ECONNRESET' || source.code === 'EPIPE'));
  }
  return name === 'postgres' && typeof source.code === 'string' && (source.code.startsWith('08') || source.code === '25P03' || source.code === '57P01' || source.code === '57P02' || source.code === '57P05');
}

export type { MySqlServer } from './engine/dialect.js';

/**
 * The codes of the error numbers of each server of the mysql dialect (DIA-201): MariaDB numbers its errors above 1999
 * otherwise than MySQL, so a number is read by the table of its server. MySQL's 4025 is ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE
 * and MariaDB's ER_CONSTRAINT_FAILED; MariaDB has no 3572, 3819 or 3024 and reports a statement timeout as 1969.
 */
const MYSQL_CODES: Record<MySqlServer, ReadonlyMap<number, string>> = {
  mysql: new Map([[3572, codes.LOCK_NOT_AVAILABLE], [1205, codes.CANCELED], [1317, codes.CANCELED], [3024, codes.CANCELED], [1062, codes.DUPLICATE_KEY], [1451, codes.FOREIGN_KEY], [1452, codes.FOREIGN_KEY], [1213, codes.DEADLOCK], [1290, codes.READ_ONLY], [1792, codes.READ_ONLY], [3819, codes.CONSTRAINT]]),
  mariadb: new Map([[1205, codes.CANCELED], [1317, codes.CANCELED], [1969, codes.CANCELED], [1062, codes.DUPLICATE_KEY], [1451, codes.FOREIGN_KEY], [1452, codes.FOREIGN_KEY], [1213, codes.DEADLOCK], [1290, codes.READ_ONLY], [1792, codes.READ_ONLY], [4025, codes.CONSTRAINT]]),
};

/**
 * The OrmError of a driver error. server is the server of a mysql connection (DIA-201), and nowait says that the failing statement
 * takes a row lock `*_nowait`: MariaDB fails a NOWAIT lock that it cannot take at once with 1205, which is LOCK_NOT_AVAILABLE then,
 * as MySQL's 3572 is, and CANCELED otherwise (DIA-209).
 */
export function driverError(name: DriverName, error: unknown, server: MySqlServer = 'mysql', nowait = false): OrmError {
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
  // A SQLite message ends with the name of its extended result code (INT-154).
  const suffix = name === 'sqlite' && source.errcode !== undefined ? sqliteResultCodeSuffix(source.errcode) : '';
  const message = (typeof text === 'string' ? text : errorText(error)) + suffix;
  if (connectionLost(name, source, server)) return new OrmError(codes.CONNECTION_LOST, `${name}: ${message}`, error);
  // A certificate that the CA or the host of ssl-mode=VERIFY_IDENTITY or of sslmode=verify-full refuses is CONFIG (CFG-16, CFG-45).
  if ((name === 'mysql' || name === 'postgres') && source.code !== undefined && /CERT|UNABLE_TO_VERIFY|SELF_SIGNED|HANDSHAKE_SSL_ERROR/.test(source.code)) {
    return new OrmError(codes.CONFIG, `${name} TLS connection failed: ${message}`, error);
  }
  // A mysql error is read by its number in the table of its server (DIA-201).
  if (name === 'mysql') {
    if (server === 'mariadb' && nowait && source.errno === 1205) return new OrmError(codes.LOCK_NOT_AVAILABLE, `${name}: ${message}`, error);
    return new OrmError(source.errno === undefined ? codes.DRIVER : MYSQL_CODES[server].get(source.errno) ?? codes.DRIVER, `${name}: ${message}`, error);
  }
  const lockNotAvailable = source.code === '55P03';
  // PostgreSQL 57014 and SQLite 9 report a statement that was stopped before it finished; SQLite BUSY reports a lock that
  // another connection still held when busy_timeout ended.
  if (source.code === '57014' || source.errcode === 9 || sqliteBusy(name, error)) {
    return new OrmError(codes.CANCELED, `${name}: ${message}`, error);
  }
  const duplicate = source.code === '23505' || source.errcode === 2067 || source.errcode === 1555;
  const foreignKey = source.code === '23503' || source.errcode === 787 ||
    // SQLite reports an FK violation of a RESTRICT action as CONSTRAINT_TRIGGER (1811). The 1811 of a trigger RAISE is DRIVER.
    (source.errcode === 1811 && message.includes('FOREIGN KEY constraint failed'));
  const deadlock = source.code === '40P01' || source.code === '40001';
  // PostgreSQL 25006 and SQLite READONLY (8) with its extended codes report a write the read-only server or connection
  // rejects.
  const readOnly = source.code === '25006' || (typeof source.errcode === 'number' && (source.errcode & 0xff) === 8);
  // PostgreSQL 23514 and SQLite CONSTRAINT_CHECK (275) report a CHECK violation.
  const constraint = source.code === '23514' || source.errcode === 275;
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

/** The native type name of a MySQL column: the type code, UNSIGNED for an unsigned integer, and BLOB, BINARY or VARBINARY for binary strings. */
function mysqlColumn(field: FieldPacket): DriverColumn {
  const code = Number(field.columnType ?? -1);
  const charset = field.characterSet ?? 0;
  const flags = field.flags ?? 0;
  const base = MYSQL_TYPE_NAMES[code] ?? `MYSQL_TYPE_${code}`;
  let type = base;
  if (code >= 249 && code <= 252) type = charset === MYSQL_BINARY_CHARSET ? 'BLOB' : 'TEXT';
  else if (code === 15 || code === 253 || code === 254) {
    if (charset === MYSQL_BINARY_CHARSET) type = code === 254 ? 'BINARY' : 'VARBINARY';
  }
  if (MYSQL_INTEGER_TYPES.has(base) && (Number(flags) & MYSQL_UNSIGNED_FLAG) !== 0) type = `${base} UNSIGNED`;
  return { name: field.name, type };
}

const MYSQL_BINARY_CHARSET = 63;
// Every MySQL connection sends this statement when it connects (DIA-202): the character set utf8mb4, with no collation, which
// a pooler in front of the server may not know (ProxySQL refuses utf8mb4_0900_bin with 1115). A text column that the renderer
// writes compares under its own utf8mb4_0900_bin, and SQL that compares text with no such column states COLLATE
// utf8mb4_0900_bin, which MySQL and MariaDB both accept with the same result.
const MYSQL_SET_NAMES = 'SET NAMES utf8mb4';
const MYSQL_UNSIGNED_FLAG = 32;
const MYSQL_INTEGER_TYPES = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT']);
/** The MySQL column type codes of the protocol, by name (mysql2 TypeCode). */
const MYSQL_TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL', 1: 'TINYINT', 2: 'SMALLINT', 3: 'INT', 4: 'FLOAT', 5: 'DOUBLE', 6: 'NULL', 7: 'TIMESTAMP', 8: 'BIGINT', 9: 'MEDIUMINT',
  10: 'DATE', 11: 'TIME', 12: 'DATETIME', 13: 'YEAR', 14: 'DATE', 15: 'VARCHAR', 16: 'BIT', 245: 'JSON', 246: 'DECIMAL', 247: 'ENUM',
  248: 'SET', 249: 'BLOB', 250: 'BLOB', 251: 'BLOB', 252: 'BLOB', 253: 'VARCHAR', 254: 'CHAR', 255: 'GEOMETRY',
};

/** The PostgreSQL native type name of a column's type OID; an OID without a name is reported as OID:<n>. */
const PG_TYPE_NAMES: Record<number, string> = {
  16: 'BOOL', 17: 'BYTEA', 18: 'CHAR', 19: 'NAME', 20: 'INT8', 21: 'INT2', 23: 'INT4', 25: 'TEXT', 26: 'OID', 114: 'JSON', 142: 'XML',
  700: 'FLOAT4', 701: 'FLOAT8', 790: 'MONEY', 1042: 'BPCHAR', 1043: 'VARCHAR', 1082: 'DATE', 1083: 'TIME', 1114: 'TIMESTAMP',
  1184: 'TIMESTAMPTZ', 1186: 'INTERVAL', 1266: 'TIMETZ', 1560: 'BIT', 1562: 'VARBIT', 1700: 'NUMERIC', 2950: 'UUID', 3802: 'JSONB',
  650: 'CIDR', 774: 'MACADDR8', 829: 'MACADDR', 869: 'INET', 3220: 'PG_LSN', 3614: 'TSVECTOR', 3615: 'TSQUERY',
  600: 'POINT', 601: 'LSEG', 602: 'PATH', 603: 'BOX', 604: 'POLYGON', 628: 'LINE', 718: 'CIRCLE',
  24: 'REGPROC', 2202: 'REGPROCEDURE', 2203: 'REGOPER', 2204: 'REGOPERATOR', 2205: 'REGCLASS', 2206: 'REGTYPE', 3734: 'REGCONFIG',
  3769: 'REGDICTIONARY', 4191: 'REGCOLLATION',
};

/**
 * A member that a driver keeps off its public types: mysql2 holds its callback connection under `connection`, and pg's client holds
 * its socket under `connection`. Each caller names the one member it reads; the driver's own code is the only reader.
 */
// oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unsafe-return -- Reflect.get returns any, and these members have no public type to check it against; the caller's type argument is the declared contract.
function privateMember<T>(target: object, key: string): T {
  return Reflect.get(target, key) as T;
}
// oxlint-enable typescript/no-unsafe-type-assertion, typescript/no-unsafe-return

/** Whether a pg result's fields are an array, which pg's query object exposes as result.fields. */
function isPgFieldList(fields: unknown): fields is Array<{ name: string; dataTypeID: number }> {
  return Array.isArray(fields);
}

/** The row description fields of a pg result, which the query object exposes as result.fields. */
function pgFields(result: unknown): Array<{ name: string; dataTypeID: number }> {
  const fields: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'fields') : undefined;
  if (!isPgFieldList(fields)) throw new OrmError(codes.INTERNAL, 'a pg result has no fields');
  return fields;
}

function pgColumn(field: { name: string; dataTypeID: number }): DriverColumn {
  return { name: field.name, type: PG_TYPE_NAMES[field.dataTypeID] ?? `OID:${field.dataTypeID}` };
}

/**
 * The parameters of a MySQL prepared statement: mysql2 sends a JS number as a DOUBLE, which a server or a pooler may refuse where
 * an integer is required (ProxySQL refuses a DOUBLE LIMIT, T273), so an integral number is sent as a bigint, a LONGLONG.
 */
export function mysqlParams(params: readonly DriverValue[]): DriverValue[] {
  return params.map(value => (typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : value));
}

/** A MySQL answer as a driver result: the rows of a statement that returns them, or the counts of one that does not. */
function mysqlResult(value: QueryResult, fields: FieldPacket[] | undefined): DriverResult {
  const columns = (fields ?? []).map(mysqlColumn);
  if (Array.isArray(value)) return { rows: arrayRows(value), affected: 0, insertId: null, columns };
  return { rows: [], affected: value.affectedRows, insertId: value.insertId || null, columns };
}

async function mysqlExecute(connection: MySqlPool | MySqlConnection, sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
  const [value, fields] = await connection.execute({ sql, rowsAsArray: true }, mysqlParams(params));
  return mysqlResult(value, fields);
}

async function mysqlControl(connection: MySqlConnection, sql: string, params: readonly DriverValue[]): Promise<DriverResult> {
  const [value, fields] = await connection.query({ sql, rowsAsArray: true }, [...params]);
  return mysqlResult(value, fields);
}

/** Streams the rows of one MySQL statement. A row that sink refuses ends the statement; the connection is then discarded by its caller. */
function mysqlScan(connection: MySqlConnection, sql: string, params: readonly DriverValue[], sink: RowSink): Promise<void> {
  // mysql2's promise connection wraps the callback connection, whose query object emits the rows as they are read.
  const core = privateMember<{ query(options: { sql: string; rowsAsArray: boolean }, values: DriverValue[]): CoreQuery }>(connection, 'connection');
  return new Promise<void>((resolve, reject) => {
    let stopped = false;
    // A stop that killed the statement waits for its end, which the killed statement reaches with an error: both ends are kept until
    // the kill answers.
    let ended = false;
    let killed: boolean | undefined;
    const query = core.query({ sql, rowsAsArray: true }, [...params]);
    query.on('fields', (fields: FieldPacket[] | undefined) => {
      sink.columns((fields ?? []).map(mysqlColumn));
    });
    query.on('result', (row: unknown) => {
      if (stopped) return;
      if (!sink.row(arrayRows([row])[0] ?? [])) {
        stopped = true;
        if (sink.stop === undefined) {
          resolve();
          return;
        }
        sink.stop().then(answer => {
          killed = answer;
          if (!answer || ended) resolve();
        }, reject);
      }
    });
    const end = (error?: unknown): void => {
      if (!stopped) {
        if (error === undefined) resolve();
        else reject(error);
        return;
      }
      ended = true;
      if (killed === true) resolve();
    };
    query.on('end', () => { end(); });
    query.on('error', (error: unknown) => { end(error ?? new Error('the statement failed')); });
  });
}

/** The callback query object of mysql2: an event emitter that streams the rows of one statement. */
interface CoreQuery {
  on(event: 'fields', listener: (fields: FieldPacket[] | undefined) => void): CoreQuery;
  on(event: 'result', listener: (row: unknown) => void): CoreQuery;
  on(event: 'end' | 'error', listener: (error?: unknown) => void): CoreQuery;
}

/** Stops the statement running on connection from another connection of the pool. */
async function mysqlKill(pool: MySqlPool, connection: MySqlConnection, done: StatementDone, server: MySqlServer): Promise<void> {
  const id = connection.threadId;
  const sql = `KILL QUERY ${Number(id)}`;
  await observed('mysql', sql, done, 'kill', () => pool.query(sql), server);
}

/**
 * The failure of the session setup that runs on each new MySQL connection, and the server that the setup read by VERSION(),
 * never by the handshake (DIA-201). ready holds, for each connection of the pool, the end of its setup: the statement timeout is the
 * variable of the server that the connection reads (DIA-208), so it is set after VERSION() answers, and no statement of the caller
 * is sent on a connection before its ready settles.
 */
interface SessionSetup { error?: unknown; server: MySqlServer; readonly ready: WeakMap<object, Promise<void>>; }

/** The statement that bounds the statements of a connection to the server by timeoutMs milliseconds (DIA-208). */
function mysqlStatementTimeout(server: MySqlServer, timeoutMs: number): string {
  return server === 'mariadb' ? `SET SESSION max_statement_time = ${(timeoutMs / 1000).toFixed(3)}` : `SET SESSION max_execution_time = ${timeoutMs}`;
}

/** Waits for the session setup of a connection that the pool gave out, which every statement of the caller on it follows. */
async function setUp(setup: SessionSetup, connection: MySqlConnection): Promise<MySqlConnection> {
  const ready = setup.ready.get(privateMember<object>(connection, 'connection'));
  if (ready === undefined) throw new OrmError(codes.INTERNAL, 'a mysql connection of the pool has no session setup');
  await ready;
  return connection;
}

function sessionError(setup: SessionSetup): OrmError | undefined {
  if (setup.error === undefined) return undefined;
  return driverError('mysql', setup.error, setup.server);
}

class MySqlPoolDriver implements DriverPool {
  public readonly name = 'mysql' as const;
  public constructor(private readonly pool: MySqlPool, private readonly setup: SessionSetup, private readonly maxOpen: number) {}
  public get server(): MySqlServer { return this.setup.server; }
  // The session setup is queued ahead of the statement on the same
  // connection, so its outcome is known when the statement settles.
  private checked<T>(result: Promise<T>): Promise<T> {
    return result.then(
      value => { const failure = sessionError(this.setup); if (failure) throw failure; return value; },
      error => { throw sessionError(this.setup) ?? error; },
    );
  }
  public async execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone, nowait = false): Promise<DriverResult> {
    // The statement holds a connection whose session setup has ended (DIA-208); a cancellable statement holds it so that KILL QUERY
    // names the thread that runs it.
    let connection: MySqlConnection;
    try { connection = await this.checked(this.pool.getConnection().then(async held => setUp(this.setup, held))); } catch (error) { throw driverError(this.name, error, this.setup.server); }
    try {
      const work = observed(this.name, sql, done, 'statement', () => this.checked(mysqlExecute(connection, sql, params)), this.setup.server, nowait);
      return await (signal === undefined ? work : cancellable(this.name, signal, () => mysqlKill(this.pool, connection, done, this.setup.server), work));
    } finally {
      connection.release();
    }
  }
  public async reserve(): Promise<DriverSession> {
    let connection: MySqlConnection;
    // The session takes the server that the setup read, so the reserve waits for the setup of its connection (DIA-201, DIA-208).
    try { connection = await this.checked(this.pool.getConnection().then(async held => setUp(this.setup, held))); } catch (error) { throw driverError(this.name, error, this.setup.server); }
    return new MySqlSession(connection, this.pool, this.setup.server);
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
  public constructor(private readonly connection: MySqlConnection, private readonly pool: MySqlPool, private readonly server: MySqlServer) {}
  public get threadId(): number { return Number(this.connection.threadId); }
  public execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone, nowait = false): Promise<DriverResult> {
    const work = observed(this.name, sql, done, 'statement', () => mysqlExecute(this.connection, sql, params), this.server, nowait);
    return signal === undefined ? work : cancellable(this.name, signal, () => mysqlKill(this.pool, this.connection, done, this.server), work);
  }
  public control(sql: string, params: readonly DriverValue[], done: StatementDone): Promise<DriverResult> {
    return observed(this.name, sql, done, 'statement', () => mysqlControl(this.connection, sql, params), this.server);
  }
  public scan(sql: string, params: readonly DriverValue[], sink: RowSink, done: StatementDone): Promise<void> {
    return observed(this.name, sql, done, 'statement', () => mysqlScan(this.connection, sql, params, sink), this.server);
  }
  public release(discard: boolean): void {
    // A discarded connection can still have rows in flight (a streamed result that stopped early). mysql2's destroy ends the stream
    // gracefully, so the server would keep sending; the socket itself is destroyed so the server ends the statement.
    if (discard) {
      this.connection.destroy();
      privateMember<{ stream: { destroy(): void } }>(this.connection, 'connection').stream.destroy();
    } else this.connection.release();
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
/**
 * Whether error is one that a named statement from before a schema change can raise: the result type changed (0A000), a parameter keeps
 * its old type against the new column (42883, 42804), or a value is read as that old type (22P02, 22003, 22007, 22008). A statement
 * outside a transaction that fails has changed nothing, so it can run again, and a statement that fails for another reason fails the same
 * way the second time (CFG-28).
 */
function stalePlan(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  if (code === '0A000') return error.message.includes('cached plan must not change result type');
  return typeof code === 'string' && ['42883', '42804', '22P02', '22003', '22007', '22008'].includes(code);
}

/**
 * Runs a statement that failed with stalePlan once more, in one transaction that holds one server connection through PgBouncer:
 * DEALLOCATE ALL makes the server parse the statement after the change. The statement is unnamed here, since the client still lists
 * its names as parsed; the caller discards the client for the same reason (CFG-28).
 */
async function pgAgain(client: pg.PoolClient, sql: string, params: readonly DriverValue[]): Promise<pg.QueryArrayResult> {
  await client.query('BEGIN');
  await client.query('DEALLOCATE ALL');
  const result = await client.query({ text: sql, values: [...params], rowMode: 'array' });
  await client.query('COMMIT');
  return result;
}

/** pgExecute runs one statement on client. again, given outside a transaction, receives that the statement ran again, so that the caller discards client. */
async function pgExecute(client: pg.PoolClient, sql: string, params: readonly DriverValue[], cacheSize: number, done: StatementDone, failure: () => unknown, again?: () => void): Promise<DriverResult> {
  let cache = statementCaches.get(client);
  if (cache === undefined) {
    cache = new StatementNames(cacheSize);
    statementCaches.set(client, cache);
  }
  const { name, evicted } = cache.name(sql);
  const result = await observed('postgres', sql, done, 'statement', async () => {
    try {
      return await afterFailure(client.query({ name, text: sql, values: [...params], rowMode: 'array' }), failure);
    } catch (error) {
      if (again === undefined || !stalePlan(error)) throw error;
      again();
      return afterFailure(pgAgain(client, sql, params), failure);
    }
  });
  if (evicted !== undefined) {
    const deallocate = `DEALLOCATE "${evicted}"`;
    await observed('postgres', deallocate, done, 'deallocate', () => afterFailure(client.query(deallocate), failure));
  }
  const rows = arrayRows(result.rows);
  return { rows, affected: result.rowCount ?? 0, insertId: insertIdOf(rows), columns: result.fields.map(pgColumn) };
}

/** Streams the rows of one PostgreSQL statement. A row that sink refuses ends the statement; the connection is then discarded by its caller. */
function pgScan(client: pg.PoolClient, sql: string, params: readonly DriverValue[], sink: RowSink): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let announced = false;
    let stopped = false;
    const announce = (fields: Array<{ name: string; dataTypeID: number }>): void => {
      if (announced) return;
      announced = true;
      sink.columns(fields.map(pgColumn));
    };
    const config: pg.QueryArrayConfig = { text: sql, values: [...params], rowMode: 'array' };
    const query = new pg.Query(config);
    query.on('row', (row: unknown[], result: unknown) => {
      if (stopped) return;
      announce(pgFields(result));
      if (!sink.row(row)) {
        stopped = true;
        resolve();
      }
    });
    query.on('end', (result: unknown) => {
      if (stopped) return;
      announce(pgFields(result));
      resolve();
    });
    query.on('error', (error: unknown) => { if (!stopped) reject(error); });
    client.query(query);
  });
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
  public readonly server = 'postgres' as const;
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
    let discard = false;
    try {
      // A connection error on a connection that the pool lent out is received by the pool. The statement's error has that code.
      const work = pgExecute(client, sql, params, this.cacheSize, done, () => undefined, () => { discard = true; });
      return await (signal === undefined ? work : cancellable(this.name, signal, () => pgCancel(this.config, client), work));
    } finally { this.release(client, discard); }
  }
  public async reserve(): Promise<DriverSession> {
    let client: pg.PoolClient;
    try { client = await this.pool.connect(); } catch (error) { throw driverError(this.name, error); }
    return new PostgresSession(client, this.cacheSize, this.config, failed => this.release(client, failed));
  }
  public async openListener(): Promise<PostgresListener> {
    const client = new pg.Client(this.config);
    // The listener attaches its own error handler before the connection opens, so an error during connect is reported by it.
    const listener = new PostgresListener(client, error => new OrmError(codes.CONNECTION_LOST, `postgres: ${errorText(error)}`, error));
    try { await client.connect(); } catch (error) { throw driverError(this.name, error); }
    return listener;
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
    // A discarded client can still have rows in flight (a streamed result that stopped early); the socket is destroyed so that the server ends the statement.
    if (discard) privateMember<{ stream: { destroy(): void } }>(this.client, 'connection').stream.destroy();
    this.client.removeListener('error', this.onError);
    this.done(discard || this.failure !== undefined);
  }
  public execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    const work = pgExecute(this.client, sql, params, this.cacheSize, done, () => this.failure);
    return signal === undefined ? work : cancellable(this.name, signal, () => pgCancel(this.config, this.client), work);
  }
  public scan(sql: string, params: readonly DriverValue[], sink: RowSink, done: StatementDone): Promise<void> {
    return observed(this.name, sql, done, 'statement', () => pgScan(this.client, sql, params, sink));
  }
  public async control(sql: string, params: readonly DriverValue[], done: StatementDone): Promise<DriverResult> {
    // The server forgets its named statements here, and a client from the pool may list some of an earlier session: it forgets them
    // too, or the next use of a text it remembers would name a statement that the server has released.
    if (sql === 'DEALLOCATE ALL') {
      statementCaches.delete(this.client);
      privateMember<{ parsedStatements: Record<string, string> }>(this.client, 'connection').parsedStatements = {};
    }
    const result = await observed(this.name, sql, done, 'statement', () => afterFailure(this.client.query({ text: sql, values: [...params], rowMode: 'array' }), () => this.failure));
    return { rows: result.rows as unknown[][], affected: result.rowCount ?? 0, insertId: null, columns: result.fields.map(pgColumn) };
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

/** The statement's parameters as node:sqlite binds them; a boolean is 0 or 1. */
function sqliteValues(params: readonly DriverValue[]): Array<null | number | string | bigint | Uint8Array> {
  return params.map(value => typeof value === 'boolean' ? Number(value) : value);
}

function sqliteColumns(statement: ReturnType<DatabaseSync['prepare']>): DriverColumn[] {
  return statement.columns().map(column => ({ name: column.name, type: column.type ?? '' }));
}

/**
 * The read of a SQLite query that keeps the stored bytes of each text: for each column its storage class and its value,
 * a text as a BLOB. node:sqlite has no raw read of a text column and decodes what is not UTF-8 with U+FFFD.
 */
export function sqliteStoredRead(query: string, width: number): string {
  const names = Array.from({ length: width }, (_, index) => `c${String(index)}`);
  const cells = names.map(name => `typeof(${name}),CASE typeof(${name}) WHEN 'text' THEN CAST(${name} AS BLOB) ELSE ${name} END`);
  return `WITH q(${names.join(',')}) AS (${query}\n) SELECT ${cells.join(',')} FROM q`;
}

/** The cells of a row of sqliteStoredRead: a text is its text when it is valid UTF-8 and its bytes when not (INT-153, COD-69). */
export function sqliteStoredCells(values: readonly unknown[]): unknown[] {
  const cells: unknown[] = [];
  for (let at = 0; at < values.length; at += 2) {
    const value = values[at + 1];
    const text = values[at] === 'text' && value instanceof Uint8Array;
    cells.push(text && isUtf8(value) ? Buffer.from(value).toString('utf8') : value);
  }
  return cells;
}

function sqliteExecute(state: SqliteState, sql: string, params: readonly DriverValue[]): DriverResult {
  const statement = state.statement(sql);
  const values = sqliteValues(params);
  if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
    statement.setReturnArrays(true);
    const columns = sqliteColumns(statement);
    const rows = arrayRows(statement.all(...values));
    if (/^\s*(?:SELECT|WITH)\b/i.test(sql) && !/\bRETURNING\b/i.test(sql) && rows.some(row => row.some(cell => typeof cell === 'string' && cell.includes('\uFFFD')))) {
      // A text may have lost its bytes to U+FFFD: the whole answer comes from a read that keeps them, so no row of the two
      // reads is mixed, and a text that is not UTF-8 is its bytes, which a model column refuses (COD-69).
      const stored = state.statement(sqliteStoredRead(sql.replace(/[\s;]+$/, ''), columns.length));
      stored.setReturnArrays(true);
      const kept = arrayRows(stored.all(...values)).map(sqliteStoredCells);
      return { rows: kept, affected: kept.length, insertId: insertIdOf(kept), columns };
    }
    return { rows, affected: rows.length, insertId: insertIdOf(rows), columns };
  }
  const result = statement.run(...values);
  return { rows: [], affected: Number(result.changes), insertId: result.lastInsertRowid, columns: [] };
}

/** Streams the rows of one SQLite statement. node:sqlite reads a row when the loop asks for it, so a break stops the statement at once. */
function sqliteScan(state: SqliteState, sql: string, params: readonly DriverValue[], sink: RowSink): void {
  const statement = state.statement(sql);
  statement.setReturnArrays(true);
  sink.columns(sqliteColumns(statement));
  const rows = statement.iterate(...sqliteValues(params));
  try {
    for (const row of rows) {
      if (!sink.row(arrayRows([row])[0] ?? [])) break;
    }
  } catch (error) {
    // A statement that failed stays cached; left unreset, its next run reports the same error whatever it binds.
    rows.return?.();
    throw error;
  }
}

class SqlitePoolDriver implements DriverPool {
  public readonly name = 'sqlite' as const;
  public readonly server = 'sqlite' as const;
  private readonly state: SqliteState;
  private waiters: Array<{ wake: () => void }> = [];
  public constructor(db: DatabaseSync, cacheSize: number) { this.state = new SqliteState(db, cacheSize); }
  public async execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    // Reject cancellation before waiting for the connection, then check again
    // after the wait to cover an abort while this statement is queued.
    if (signal?.aborted) throw canceled(this.name);
    await this.idle(signal);
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
  private async idle(signal?: AbortSignal): Promise<void> {
    while (this.state.busy) {
      if (signal?.aborted) throw canceled(this.name);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const remove = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          signal?.removeEventListener('abort', abort);
        };
        const wake = (): void => {
          if (settled) return;
          settled = true;
          remove();
          resolve();
        };
        const abort = (): void => {
          if (settled) return;
          settled = true;
          remove();
          reject(canceled(this.name));
        };
        const waiter = { wake };
        this.waiters.push(waiter);
        signal?.addEventListener('abort', abort, { once: true });
        // Close the race between the initial check and listener registration.
        if (signal?.aborted) abort();
      });
    }
  }
  private release(): void {
    this.state.busy = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.wake();
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
  public scan(sql: string, params: readonly DriverValue[], sink: RowSink, done: StatementDone): Promise<void> {
    return observed(this.name, sql, done, 'statement', () => sqliteScan(this.state, sql, params, sink));
  }
  public inTransaction(): boolean { return this.state.db.isTransaction; }
  public release(): void {
    if (this.released) return;
    this.released = true;
    this.done();
  }
}

/**
 * A DSN of a SQL database: the driver, the connection time zone, the TLS CA of MySQL or PostgreSQL, the MySQL socket or the PostgreSQL socket
 * directory, and the SQLite pragmas, name and value. These are the only values of the query that reach the driver (CFG-20).
 */
export interface SqlDsn {
  driver: DriverName;
  zone: string;
  sslCa?: string;
  socket?: string;
  host?: string;
  pragmas?: ReadonlyArray<readonly [string, string]>;
}

/** A markdown:// DSN: the flowmark server address, the corpus and the token of a flowmark server (docs/spec/protocol.md §5). */
interface MarkdownParsedDsn { driver: 'markdown'; zone: string; markdown: MarkdownDsn; }

export type ParsedDsn = SqlDsn | MarkdownParsedDsn;

/** The parameters of a DSN query (CFG-20): each accepted name with its decoded values in written order. */
export type DsnParameters = ReadonlyMap<string, readonly string[]>;

/** The parameters a DSN accepts for each scheme, in the order of CFG-19 and PRT-63. Any other parameter is CONFIG. */
const DSN_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  mysql: ['timezone', 'socket', 'ssl-mode', 'ssl-ca'],
  postgres: ['timezone', 'host', 'sslmode', 'sslrootcert'],
  sqlite: ['timezone', '_pragma', '_txlock'],
  markdown: ['token', 'timezone', '_pragma'],
};

const HEX = /^[0-9A-Fa-f]{2}$/;

/**
 * Decodes one name or value of a DSN query as an HTML form is: `+` as a space and `%` with two hexadecimal digits as that
 * byte. Returns undefined for a `%` without two hexadecimal digits, a lone surrogate in the text, or bytes that are not UTF-8.
 */
function formDecode(text: string): string | undefined {
  if (!text.isWellFormed()) return undefined;
  const bytes: number[] = [];
  for (let at = 0; at < text.length;) {
    const ch = text[at] ?? '';
    if (ch === '+') { bytes.push(0x20); at += 1; continue; }
    if (ch === '%') {
      const hex = text.slice(at + 1, at + 3);
      if (!HEX.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      at += 3;
      continue;
    }
    const cp = text.codePointAt(at) ?? 0;
    const char = String.fromCodePoint(cp);
    bytes.push(...Buffer.from(char, 'utf8'));
    at += char.length;
  }
  const buffer = Buffer.from(bytes);
  return isUtf8(buffer) ? buffer.toString('utf8') : undefined;
}

/** The query of a DSN without a fragment as written: the text after the first `?`, or empty. */
function dsnQuery(dsn: string): string {
  const query = dsn.indexOf('?');
  return query < 0 ? '' : dsn.slice(query + 1);
}

/**
 * Reads the query of a DSN by the one rule of CFG-20, before a connection opens: pairs split at `&` and at the first `=`, each
 * checked in written order for a name that the scheme does not accept, a repeated name (only `_pragma` repeats), a value that
 * is not percent-encoded UTF-8, an empty value and a `socket` or `host` that holds `;` or NUL.
 */
function readDsnQuery(scheme: string, query: string): DsnParameters {
  const accepted = DSN_PARAMETERS[scheme];
  if (accepted === undefined) throw new OrmError(codes.INTERNAL, `the DSN scheme ${messageQuote(scheme)} has no parameter list`);
  const parameters = new Map<string, string[]>();
  if (query === '') return parameters;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const written = eq < 0 ? pair : pair.slice(0, eq);
    const decoded = formDecode(written);
    if (decoded === undefined || !accepted.includes(decoded)) {
      throw new OrmError(codes.CONFIG, `${scheme} DSN has the unknown parameter ${messageQuote(decoded ?? written)}; it accepts ${accepted.join(', ')}`);
    }
    const name = messageQuote(decoded);
    const values = parameters.get(decoded);
    if (values !== undefined && decoded !== '_pragma') throw new OrmError(codes.CONFIG, `${scheme} DSN repeats the parameter ${name}`);
    const value = eq < 0 ? '' : formDecode(pair.slice(eq + 1));
    if (value === undefined) throw new OrmError(codes.CONFIG, `${scheme} DSN parameter ${name} is not percent-encoded UTF-8`);
    if (value === '') throw new OrmError(codes.CONFIG, `${scheme} DSN parameter ${name} is empty`);
    if ((decoded === 'socket' || decoded === 'host' || decoded === 'sslrootcert') && /[;\0]/.test(value)) {
      throw new OrmError(codes.CONFIG, `${scheme} DSN parameter ${name} holds a character that a connection string cannot hold`);
    }
    if (values === undefined) parameters.set(decoded, [value]);
    else values.push(value);
  }
  return parameters;
}

/** The one value of a parameter that does not repeat, or undefined. */
export function dsnParameter(parameters: DsnParameters, name: string): string | undefined {
  return parameters.get(name)?.[0];
}

/**
 * The `_pragma` values of a SQLite or markdown DSN (CFG-12): `name(value)`, the name one or more of `a` to `z` and `_`, the
 * value one or more of ASCII letters, digits and `_`, and a busy_timeout a whole number from 0 to 2147483647, the largest
 * wait the C int of SQLite holds, since SQLite reads a larger number as 0.
 */
export function dsnPragmas(scheme: string, parameters: DsnParameters): ReadonlyArray<readonly [string, string]> {
  return (parameters.get('_pragma') ?? []).map(pragma => {
    const [, name, value] = /^([a-z_]+)\(([A-Za-z0-9_]+)\)$/.exec(pragma) ?? [];
    if (name === undefined || value === undefined || (name === 'busy_timeout' && !(/^[0-9]+$/.test(value) && Number(value) <= 2147483647))) {
      throw new OrmError(codes.CONFIG, `${scheme} DSN _pragma ${messageQuote(pragma)} is invalid`);
    }
    return [name, value] as const;
  });
}

/**
 * Checks the MySQL TLS parameters: a TCP connection that puts the absolute path of the CA file in `ssl-ca`
 * with `ssl-mode=VERIFY_IDENTITY`, or neither. Returns the CA path or undefined.
 */
function mysqlTls(url: URL, parameters: DsnParameters): string | undefined {
  const mode = dsnParameter(parameters, 'ssl-mode');
  const ca = dsnParameter(parameters, 'ssl-ca');
  if (mode === undefined && ca === undefined) return undefined;
  if (mode !== 'VERIFY_IDENTITY') throw new OrmError(codes.CONFIG, `mysql DSN ssl-mode ${messageQuote(mode ?? '')} is not supported; the TLS mode is ssl-mode=VERIFY_IDENTITY with ssl-ca`);
  if (ca === undefined) throw new OrmError(codes.CONFIG, 'mysql DSN ssl-mode=VERIFY_IDENTITY needs ssl-ca, the absolute path of the CA file');
  if (!ca.startsWith('/')) throw new OrmError(codes.CONFIG, `mysql DSN ssl-ca ${messageQuote(ca)} is not an absolute path`);
  if (parameters.has('socket')) throw new OrmError(codes.CONFIG, 'mysql DSN ssl-mode connects over TCP and does not accept socket');
  // The identity check compares the host name with the certificate. The driver compares a host that is an IP address with the name localhost.
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) throw new OrmError(codes.CONFIG, `mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address ${url.hostname}`);
  return ca;
}

/**
 * Checks the PostgreSQL TLS parameters in the order of CFG-46: `sslmode=verify-full` with the absolute path of the CA file in
 * `sslrootcert` over TCP (CFG-45), or no TLS without either or with `sslmode=disable` (CFG-47). Returns the CA path or undefined.
 */
function postgresTls(parameters: DsnParameters, host: string | undefined): string | undefined {
  const mode = dsnParameter(parameters, 'sslmode');
  const ca = dsnParameter(parameters, 'sslrootcert');
  if (mode !== undefined && mode !== 'disable' && mode !== 'verify-full') throw new OrmError(codes.CONFIG, `postgres DSN sslmode ${messageQuote(mode)} is not supported; it accepts disable, or verify-full with sslrootcert`);
  if (ca !== undefined && mode !== 'verify-full') throw new OrmError(codes.CONFIG, 'postgres DSN sslrootcert needs sslmode=verify-full');
  if (mode !== 'verify-full') return undefined;
  if (ca === undefined) throw new OrmError(codes.CONFIG, 'postgres DSN sslmode=verify-full needs sslrootcert, the absolute path of the CA file');
  if (!ca.startsWith('/')) throw new OrmError(codes.CONFIG, `postgres DSN sslrootcert ${messageQuote(ca)} is not an absolute path`);
  if (host?.startsWith('/')) throw new OrmError(codes.CONFIG, 'postgres DSN sslmode=verify-full connects over TCP and does not accept a socket directory as host');
  return ca;
}

/**
 * The pg TLS option for sslmode=verify-full, or false: the CA of `sslrootcert` alone, the rejection of certificates not signed by
 * that CA, and the host check of Node, which pg asks for by the host of the connection (CFG-45).
 */
function postgresSsl(parsed: SqlDsn): { ca: string; rejectUnauthorized: true } | false {
  if (parsed.sslCa === undefined) return false;
  try { return { ca: readFileSync(parsed.sslCa, 'utf8'), rejectUnauthorized: true }; } catch (error) {
    throw new OrmError(codes.CONFIG, `postgres DSN sslrootcert ${messageQuote(parsed.sslCa)} is not a readable file: ${errorText(error)}`, error);
  }
}

/**
 * The mysql2 TLS option for ssl-mode=VERIFY_IDENTITY, or undefined: the CA of `ssl-ca`, the rejection of
 * certificates not signed by that CA, and the host name check.
 */
function mysqlSsl(parsed: SqlDsn): { ca: string; rejectUnauthorized: true; verifyIdentity: true } | undefined {
  if (parsed.sslCa === undefined) return undefined;
  try { return { ca: readFileSync(parsed.sslCa, 'utf8'), rejectUnauthorized: true, verifyIdentity: true }; } catch (error) {
    throw new OrmError(codes.CONFIG, `mysql DSN ssl-ca ${messageQuote(parsed.sslCa)} is not a readable file: ${errorText(error)}`, error);
  }
}

/**
 * The host step of CFG-20 (CFG-10), before the database step: a host is named, holds no `%`, and is localhost with a MySQL
 * `socket`. A PostgreSQL DSN names its host in the URL or in its `host` parameter, both only when they are equal.
 */
function checkHost(scheme: 'mysql' | 'postgres', url: URL, parameters: DsnParameters): void {
  const missing = `${scheme} DSN must include host and database`;
  if (scheme === 'mysql') {
    if (url.hostname === '') throw new OrmError(codes.CONFIG, missing);
    checkHostEscape(scheme, url);
    if (parameters.has('socket') && url.hostname !== 'localhost') throw new OrmError(codes.CONFIG, 'mysql DSN socket needs the host localhost, which names the local server');
    return;
  }
  const host = dsnParameter(parameters, 'host');
  if (url.hostname === '' && host === undefined) throw new OrmError(codes.CONFIG, missing);
  checkHostEscape(scheme, url);
  if (url.hostname !== '' && host !== undefined && host !== url.hostname) {
    throw new OrmError(codes.CONFIG, `postgres DSN names two hosts, ${messageQuote(url.hostname)} in the URL and ${messageQuote(host)} in the host parameter`);
  }
}

/** A host that holds `%`, which no host name needs (CFG-20). */
export function checkHostEscape(scheme: string, url: URL): void {
  if (url.hostname.includes('%')) throw new OrmError(codes.CONFIG, `${scheme} DSN host ${messageQuote(url.hostname)} holds a percent escape, which no host name needs`);
}

/** The zone of every connection: datetime values are read and written in UTC. */
const UTC_ZONE = '+00:00';

/** The timezone parameter of a DSN, which accepts only UTC or +00:00 (docs/spec/dialects.md "Date and time"). */
export function checkTimezone(parameters: DsnParameters): void {
  const requested = dsnParameter(parameters, 'timezone');
  if (requested !== undefined && requested !== 'UTC' && requested !== '+00:00') throw new OrmError(codes.CONFIG, `dsn timezone ${messageQuote(requested)}: every connection reads and writes datetime values in UTC`);
}

/**
 * The path of a DSN as written: after the authority, before the query and the fragment. The URL parser removes the dot
 * segments of a path, so the path of a DSN is read from its text (CFG-11, PRT-63).
 */
function dsnPath(dsn: string): string {
  const rest = dsn.slice(dsn.indexOf('://') + 3).split('#')[0] ?? '';
  const authorityEnd = rest.search(/[/?]/);
  if (authorityEnd < 0 || rest[authorityEnd] === '?') return '';
  return rest.slice(authorityEnd).split('?')[0] ?? '';
}

/** The database of a MySQL or PostgreSQL DSN that checkDatabase accepted: the path after its first /, decoded (CFG-10). */
function dsnDatabase(dsn: string): string {
  return decodedPath(dsnPath(dsn).slice(1)) ?? '';
}

/**
 * A DSN path percent-decoded, `+` kept as itself, or undefined when a `%` lacks two hexadecimal digits or the bytes are not
 * UTF-8 (CFG-11, CFG-20). The path of every scheme is decoded by it.
 */
export function decodedPath(written: string): string | undefined {
  try {
    return decodeURIComponent(written);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return undefined;
  }
}

/**
 * The database step of CFG-20, after the host step: a MySQL or PostgreSQL DSN names a database, whose path is percent-encoded UTF-8 and
 * does not hold `;` or NUL after percent-decoding, which the PDO DSN of PHP cannot hold.
 */
function checkDatabase(scheme: string, dsn: string): void {
  // The database is the path after its first /, as written (CFG-10).
  const written = dsnPath(dsn).slice(1);
  if (written === '') throw new OrmError(codes.CONFIG, `${scheme} DSN must include host and database`);
  const database = decodedPath(written);
  if (database === undefined) throw new OrmError(codes.CONFIG, `${scheme} DSN database ${messageQuote(written)} is not percent-encoded UTF-8`);
  if (/[;\0]/.test(database)) throw new OrmError(codes.CONFIG, `${scheme} DSN database ${messageQuote(database)} holds a character that a connection string cannot hold`);
}

/**
 * Splits a DSN URI into the dialect, the connection time zone and the values of its query that reach the driver. The checks run
 * in the order of CFG-20: the URI, the fragment, the query, the host and the database name; the first error wins. Every connection reads and writes datetime values in UTC (docs/spec/dialects.md "Date and time"), so
 * the timezone parameter accepts only UTC or +00:00.
 */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch (error) {
    if (!(error instanceof TypeError && 'code' in error && error.code === 'ERR_INVALID_URL')) throw error;
    throw new OrmError(codes.CONFIG, 'dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://', error);
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (!Object.hasOwn(DSN_PARAMETERS, scheme)) throw new OrmError(codes.CONFIG, `unsupported DSN scheme ${scheme}; want mysql, postgres, sqlite, or markdown`);
  // No part of a DSN is dropped unread (CFG-20): a fragment is refused, not ignored.
  if (dsn.includes('#')) throw new OrmError(codes.CONFIG, `${scheme} DSN has a fragment, which no connection reads`);
  const parameters = readDsnQuery(scheme, dsnQuery(dsn));
  // A markdown DSN checks the rest in the order of PRT-63, its host among them.
  if (scheme === 'markdown') return { driver: 'markdown', zone: UTC_ZONE, markdown: parseMarkdownDsn(url, dsnPath(dsn), parameters) };
  if (scheme === 'mysql' || scheme === 'postgres') {
    checkHost(scheme, url, parameters);
    checkDatabase(scheme, dsn);
  } else {
    checkHostEscape(scheme, url);
    sqlitePath(dsn);
  }
  checkTimezone(parameters);
  const zone = UTC_ZONE;
  switch (scheme) {
    case 'mysql': {
      const sslCa = mysqlTls(url, parameters);
      const socket = dsnParameter(parameters, 'socket');
      return { driver: 'mysql', zone, ...(sslCa === undefined ? {} : { sslCa }), ...(socket === undefined ? {} : { socket }) };
    }
    case 'postgres': {
      const host = dsnParameter(parameters, 'host');
      const sslCa = postgresTls(parameters, host);
      return { driver: 'postgres', zone, ...(sslCa === undefined ? {} : { sslCa }), ...(host === undefined ? {} : { host }) };
    }
    case 'sqlite': {
      // The values in the CFG-19 order (CFG-20): _pragma before _txlock.
      const pragmas = dsnPragmas('sqlite', parameters);
      if (parameters.has('_txlock')) throw new OrmError(codes.CONFIG, 'sqlite DSN does not accept _txlock; write transactions begin with BEGIN IMMEDIATE');
      return { driver: 'sqlite', zone, pragmas };
    }
  }
  throw new OrmError(codes.INTERNAL, `the DSN scheme ${messageQuote(scheme)} has no reader`);
}

/**
 * Returns the percent-decoded path of a sqlite:// DSN, the database step of SQLite (CFG-11, CFG-20): a DSN without an
 * absolute path or with a host, then a path that is not percent-encoded UTF-8, then a decoded NUL, are CONFIG errors that
 * name the path as written.
 */
export function sqlitePath(dsn: string): string {
  const url = new URL(dsn);
  const written = dsnPath(dsn);
  if (url.hostname !== '' || !written.startsWith('/') || written === '/') throw new OrmError(codes.CONFIG, 'sqlite DSN must include an absolute database path');
  const path = decodedPath(written);
  if (path === undefined) throw new OrmError(codes.CONFIG, `sqlite DSN path ${messageQuote(written)} is not percent-encoded UTF-8`);
  // An opener that drops what follows a NUL opens a different file.
  if (path.includes('\0')) throw new OrmError(codes.CONFIG, `sqlite DSN path ${messageQuote(written)} holds a NUL byte, which a file name cannot hold`);
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
  query(sql: string, done: (error: unknown, rows?: unknown) => void): void;
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
 * (case mysql_session_settings of contracts/fixtures/dsn_connection, docs/spec/config.md "Runtime connection").
 */
const MYSQL_SQL_MODE = 'STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

/**
 * Opens the pool of a DSN. With exact, the pool keeps integers exact: MySQL reports a BIGINT outside the safe range as a string
 * instead of a rounded number, and PostgreSQL int8 as text, so the catalog connection reads every integer without rounding.
 */
export function openDriver(dsn: string, parsed: SqlDsn, bounds: PoolBounds, statementCacheSize: number, statementTimeoutMs = 0, exact = false): DriverPool {
  // The driver receives only the values that parseDsn read from the query (CFG-20), never the query.
  const url = new URL(dsn);
  switch (parsed.driver) {
    case 'mysql': {
      const socket = parsed.socket;
      // ssl-mode=VERIFY_IDENTITY: TLS that checks the server certificate against the CA and the host name, and
      // is the Node TLS default with rejectUnauthorized. The password travels only inside TLS, and the client
      // does not request the server's RSA public key.
      const ssl = mysqlSsl(parsed);
      const created = mysql.createPool({
        ...(socket ? { socketPath: socket } : { host: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) }),
        ...(ssl ? { ssl } : {}),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: dsnDatabase(dsn),
        connectionLimit: bounds.size,
        namedPlaceholders: false,
        dateStrings: true,
        decimalNumbers: false,
        jsonStrings: true,
        supportBigNumbers: exact,
        // The handshake names utf8mb4, so that no server or account default chooses the encoding of a text (INT-185); the
        // connection then sends MYSQL_SET_NAMES, as every runtime sends it (DIA-202).
        charset: 'UTF8MB4_GENERAL_CI',
        // The catalog reads a FLOAT as its exact text, so that the single-precision bits are rounded from the text and not from a double,
        // and a geometry as the bytes that the server sends (INT-185).
        ...(exact ? { typeCast: (field: { type?: string | number; string(): string | null; buffer(): Buffer | null }, next: () => unknown) => (field.type === 'FLOAT' ? field.string() : field.type === 'GEOMETRY' ? field.buffer() : next()) } : {}),
        maxPreparedStatements: statementCacheSize,
      });
      const setup: SessionSetup = { server: 'mysql', ready: new WeakMap() };
      const core = mysqlCorePool(created);
      core.on('connection', connection => {
        let setupEnded = (): void => {};
        setup.ready.set(connection, new Promise<void>(resolve => { setupEnded = resolve; }));
        connection.query(MYSQL_SET_NAMES, error => { if (error) setup.error = error; });
        connection.query(`SET time_zone = '+00:00', sql_mode = '${MYSQL_SQL_MODE}'`, error => { if (error) setup.error = error; });
        // The server is read by VERSION() (DIA-201). The statement timeout is the variable of that server, which the connection sets
        // before any statement of the caller (DIA-208): MySQL bounds a SELECT by max_execution_time in milliseconds and MariaDB every
        // statement by max_statement_time in seconds.
        connection.query('SELECT VERSION() AS version', (error: unknown, rows?: unknown) => {
          if (error) { setup.error = error; setupEnded(); return; }
          const version = Array.isArray(rows) ? property(rows[0], 'version') : undefined;
          setup.server = typeof version === 'string' && version.includes('-MariaDB') ? 'mariadb' : 'mysql';
          if (statementTimeoutMs <= 0) { setupEnded(); return; }
          connection.query(mysqlStatementTimeout(setup.server, statementTimeoutMs), timeoutError => { if (timeoutError) setup.error = timeoutError; setupEnded(); });
        });
      });
      boundMySqlPool(core, bounds);
      return new MySqlPoolDriver(created, setup, bounds.size);
    }
    case 'postgres': {
      // The connection without sslmode, or with sslmode=disable, sends no TLS (CFG-47); ssl: false keeps PGSSLMODE from choosing it.
      // sslmode=verify-full checks the certificate against the CA of sslrootcert and the host (CFG-45).
      const config: pg.PoolConfig = {
        host: parsed.host ?? url.hostname.replace(/^\[|\]$/g, ''),
        ...(url.port ? { port: Number(url.port) } : {}),
        ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
        ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
        database: dsnDatabase(dsn),
        ssl: postgresSsl(parsed),
        max: bounds.size,
      };
      // pg closes a connection maxLifetimeSeconds after it opened, idle or at its release.
      if (bounds.lifetimeMs > 0) config.maxLifetimeSeconds = bounds.lifetimeMs / 1000;
      // The catalog reads every value as the text that the server sends and converts it by its type itself (catalog.ts): int8 is not
      // rounded, float4 bits are rounded from the text and not from a double, an array or a range is the server's text, and a value that
      // fails to decode is a catalog refusal, not a failure of the statement (INT-172).
      if (exact) config.types = { getTypeParser: () => (value: string): string => value };
      // The connection fixes its encoding, so that no server or database default chooses the encoding of a text (INT-185).
      config.options = '-c TimeZone=UTC -c client_encoding=UTF8';
      if (statementTimeoutMs > 0) config.options += ` -c statement_timeout=${statementTimeoutMs}`;
      return new PostgresPoolDriver(new pg.Pool(config), statementCacheSize, bounds.size, bounds.idleSize, config);
    }
    case 'sqlite': {
      const pragmas = parsed.pragmas ?? [];
      // The connection waits for a lock up to busy_timeout from its first statement.
      const busyTimeout = pragmas.find(([name]) => name === 'busy_timeout');
      // The version of the SQLite library that node:sqlite links. The connection does not send a statement that asks for it.
      const version = process.versions.sqlite ?? '';
      checkSqliteVersion(version);
      const db = new DatabaseSync(sqlitePath(dsn), { timeout: busyTimeout ? Number(busyTimeout[1]) : SQLITE_BUSY_TIMEOUT_MS });
      db.exec('PRAGMA foreign_keys = ON');
      for (const [name, value] of pragmas) db.exec(`PRAGMA ${name} = ${value}`);
      return new SqlitePoolDriver(db, statementCacheSize);
    }
  }
}
