import { hostDecode, hostEncode } from './codec.js';
import { CORE, isModel } from './core.js';
import { activeFor, registerSet, schemaModel, type Db, type Runner, type Schema, type TxFrame } from './database.js';
import { driverValue, type DriverName, type DriverSession, type DriverValue, type PoolStats } from './driver.js';
import type { StatementKind } from './events.js';
import { AesKeyring, storedVersion } from './aes.js';
import { addTablesAndColumnsSteps, dbspecManifest, emitDbspec, externalDifferences, installedDifferences, parseDbspec, renderDbspecStatements, type DbspecDocument } from './dbspec/index.js';
import { introspectCatalog, type DbspecIntrospection } from './dbspec/introspect.js';
import { CatalogRow } from './dbspec/introspect_catalog.js';
import type { RuntimeModel } from './engine/model.js';
import { present } from './present.js';
import { OrmError, joinedErrors, rollbackFailed } from './runtime_error.js';
import * as codes from './codes.js';

export interface AesRotationStatus {
  current: number;
  total: number;
  pending: number;
  versions: ReadonlyMap<number, number>;
}

export interface TablePrivileges { insert: boolean; select: boolean; update: boolean; delete: boolean; truncate: boolean; }

function validKey(key: string): boolean { return /^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$/.test(key); }

function config(message: string): OrmError { return new OrmError(codes.CONFIG, message); }

function quote(driver: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw config(`invalid identifier ${name}`);
  return driver === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

function versionOf(value: unknown): number { return storedVersion(value); }

/**
 * Turns off foreign keys on a SQLite connection, runs fn in a BEGIN IMMEDIATE transaction, and then, only if the foreign key check
 * returns no rows, commits and turns foreign keys back on (docs/spec/plans.md "Apply", SQLite rebuild).
 * The transaction takes the connection's next number, and the statements that change foreign keys are outside the transaction.
 */
async function withoutForeignKeys<T>(db: Db, session: DriverSession, fn: (run: Runner) => Promise<T>): Promise<T> {
  const outside = db.runner(session, null);
  await outside('utility', [], 'PRAGMA foreign_keys = OFF');
  let result: T;
  try {
    const inside = db.runner(session, db.nextTransaction());
    await inside('begin', [], 'BEGIN IMMEDIATE');
    try {
      result = await fn(inside);
      const broken = Number((await inside('schema', [], 'SELECT COUNT(*) FROM pragma_foreign_key_check')).rows[0]?.[0]);
      if (broken !== 0) throw new OrmError(codes.INTERNAL, `the rebuilt tables break ${broken} foreign keys`);
    } catch (error) {
      try { await inside('rollback', [], codes.ROLLBACK); } catch (rollback) { throw rollbackFailed(error, rollback); }
      throw error;
    }
    await inside('commit', [], 'COMMIT');
  } catch (error) {
    // If foreign keys cannot be turned back on, both errors are returned together.
    try { await outside('utility', [], 'PRAGMA foreign_keys = ON'); } catch (restore) { throw joinedErrors([error, restore]); }
    throw error;
  }
  await outside('utility', [], 'PRAGMA foreign_keys = ON');
  return result;
}

/** The CONFIG for a set whose table that an external document writes differs from the database. */
function externalError(differences: readonly string[]): OrmError {
  return config(`the tables that the set uses from external documents differ from the database: ${differences.join('; ')}`);
}

/** The external document text of the set, returned for each document name. Used when parsing the use lines of schema text. */
function externalTexts(model: RuntimeModel): Record<string, string> {
  return Object.fromEntries(model.documents.filter(d => d.external === true).map(d => [d.name, emitDbspec(d)]));
}

/** Introspects the connection's database. run sends the connection's statements. A catalog query is a schema statement that does not point to a table. */
async function introspect(run: Runner, driver: DriverName): Promise<DbspecIntrospection> {
  return introspectCatalog(async sql => (await run('schema', [], sql)).rows.map(values => new CatalogRow(sql, values)), driver, 'schema');
}

/**
 * Introspects the connection's database, and if a table that the set writes through an external document differs from that document, it is CONFIG (docs/spec/dbspec.md
 * "External documents").
 */
async function introspectSet(run: Runner, driver: DriverName, model: RuntimeModel): Promise<DbspecIntrospection> {
  const live = await introspect(run, driver);
  const differences = externalDifferences(live.document, model.documents);
  if (differences.length > 0) throw externalError(differences);
  return live;
}

/** If the database differs from the set, a CONFIG holding all the differences. */
function verifySet(differences: readonly string[]): void {
  if (differences.length > 0) throw config(`the database differs from the document set: ${differences.join('; ')}`);
}

/** The schema text document of the set, which is what the database is compared against. */
function schemaTarget(model: RuntimeModel): DbspecDocument {
  const manifest = dbspecManifest(model.documents);
  // The use lines of schema text point to external documents, so the external documents are parsed as the set.
  const parsed = manifest.manifest === null ? null : parseDbspec(manifest.manifest.schemaText, externalTexts(model));
  const failed = parsed === null ? manifest.diagnostics : parsed.diagnostics;
  const [d] = failed;
  if (d !== undefined) throw new OrmError(codes.SCHEMA_INVALID, `document set: ${d.rule} at ${d.line}:${d.column}: ${d.message}`);
  return present(parsed?.document, 'the document of a schema text without diagnostics');
}

/** Operations outside the query syntax. */
export class Utils {
  /**
   * The connection of the utilities; SchemaUtils, PrivilegeUtils and AesUtils reach it through their Utils.
   *
   * @internal
   */
  public readonly db: Db;

  public constructor(db: Db) { this.db = db; }

  public stats(): PoolStats { return this.db.stats(); }

  /**
   * The active transaction of the connection; CONFIG names the operation that requires it.
   *
   * @internal
   */
  public active(name: string): TxFrame {
    const frame = activeFor(this.db);
    if (!frame) throw config(`${name} requires an active transaction of the connection`);
    return frame;
  }

  /**
   * Runs fn in the active transaction of the connection, or in a new one without retry.
   *
   * @internal
   */
  public async run<T>(fn: (frame: TxFrame) => Promise<T>): Promise<T> {
    const frame = activeFor(this.db);
    if (frame) return fn(frame);
    return this.db.transaction(() => fn(present(activeFor(this.db), 'the frame of the transaction that run opened')), { retry: 0 });
  }

  /**
   * Reads the rows of a statement through the active transaction of the connection, or through the pool;
   * kind and tables are those of its statement event.
   *
   * @internal
   */
  public async read(kind: StatementKind, tables: readonly string[], sql: string, params: readonly DriverValue[] = []): Promise<unknown[][]> {
    const frame = activeFor(this.db);
    if (frame) return (await frame.statement(kind, tables, sql, params)).rows;
    const done = this.db.statementDone(kind, tables, null, params);
    this.db.checkStatementFault(sql, done);
    return (await this.db.pool.execute(sql, params, undefined, done)).rows;
  }

  /** Takes a named lock that is released when the transaction ends. */
  public async lock(key: string): Promise<void> {
    this.db.unsupportedOnMarkdown('lock');
    const frame = this.active('lock');
    if (!validKey(key)) throw config(`lock key ${key} is invalid`);
    switch (this.db.driver) {
      case 'mysql': {
        const got = (await frame.statement('utility', [], 'SELECT GET_LOCK(?, 50)', [key])).rows[0]?.[0];
        if (Number(got) !== 1) throw new OrmError(codes.DEADLOCK, `lock ${key} was not acquired`);
        frame.locks.push(key);
        return;
      }
      case 'postgres':
        await frame.statement('utility', [], 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        return;
      default:
        await this.db.rowLock(frame, 'update');
    }
  }

  /**
   * Sets a transaction-local value: a PostgreSQL transaction setting, a MySQL
   * user variable that the transaction end clears, and on SQLite, which has no
   * session setting, a value of the transaction that only local() reads.
   */
  public async setLocal(key: string, value: string): Promise<void> {
    this.db.unsupportedOnMarkdown('setLocal');
    const frame = this.active('setLocal');
    if (!validKey(key)) throw config(`local key ${key} is invalid`);
    switch (this.db.driver) {
      case 'postgres':
        await frame.statement('utility', [], 'SELECT set_config($1, $2, true)', [key, value]);
        break;
      case 'mysql':
        await frame.statement('utility', [], `SET @\`orm.${key}\` = ?`, [value]);
        break;
    }
    frame.locals.set(key, value);
  }

  /** Returns a value set with setLocal; NO_ROWS when it is missing. */
  public async local(key: string): Promise<string> {
    this.db.unsupportedOnMarkdown('local');
    const frame = this.active('local');
    const value = frame.locals.get(key);
    if (value === undefined) throw new OrmError(codes.NO_ROWS, `local value ${key} is not set`);
    return value;
  }

  public schema(): SchemaUtils { return new SchemaUtils(this); }
  public privileges(): PrivilegeUtils { return new PrivilegeUtils(this); }
  public aes(): AesUtils { return new AesUtils(this); }
}

/** Schema installation and inspection. */
export class SchemaUtils {
  public constructor(private readonly u: Utils) {}

  private async check(sql: string, params: readonly DriverValue[] = []): Promise<boolean> {
    this.u.db.unsupportedOnMarkdown('schema inspection');
    const value = (await this.u.read('schema', [], sql, params))[0]?.[0];
    return value === true || Number(value) === 1;
  }

  /**
   * Registers the generated schema's set on this connection. It reads and writes no database: the manifest text declares a
   * hash, and it checks that the text hashes to it (otherwise CONFIG), then only registers the set. Registering the same set again changes nothing.
   * Whether the database equals the set is checked by install and addTablesAndColumns at install and upgrade time,
   * and register also registers the set, without a statement, on connections opened per request (docs/spec/schema.md "Schema
   * registration").
   */
  public register(schema: Schema): void {
    registerSet(this.u.db, schemaModel(schema));
  }

  /**
   * Installs the generated schema's document set on the connection's database, then checks that the database equals the set and
   * registers the set on this connection. If the text does not hash to the declared hash, it is CONFIG before any statement.
   * CONFIG. The connection's database is introspected, and if a table that an external document writes differs from that document, it is CONFIG.
   * If the set owns no table at all, it creates all of them with the rendered statements (docs/spec/dialects.md "Rendered statements"),
   * if all of them exist it creates nothing, and if only some exist it is CONFIG. Then the database is read again and the set's
   * owned tables are compared with the set, and if there is any difference, it is CONFIG holding all the differences (docs/spec/schema.md "Schema
   * installation"). PostgreSQL and SQLite apply in an ongoing or a new transaction, so a failed
   * install leaves nothing behind. MySQL implicitly commits schema statements, so it applies them outside a transaction
   * and is CONFIG inside one.
   */
  public async install(schema: Schema): Promise<void> {
    this.u.db.unsupportedOnMarkdown('schema install (flowmark install creates a corpus)');
    const model = schemaModel(schema);
    const driver = this.u.db.pool.name;
    const rendered = renderDbspecStatements(model.documents, driver);
    if (rendered.statements === null) {
      const d = present(rendered.diagnostics[0], 'a diagnostic of a document set that renders no statements');
      throw new OrmError(codes.SCHEMA_INVALID, `document set: ${d.rule} at ${d.line}:${d.column}: ${d.message}`);
    }
    const statements = rendered.statements;
    const target = schemaTarget(model);
    // MySQL commits schema statements implicitly, so they run outside a transaction.
    if (driver === 'mysql' && activeFor(this.u.db)) throw config('MySQL commits schema statements implicitly; install outside a transaction');
    const apply = async (run: Runner): Promise<void> => {
      let live = await introspectSet(run, driver, model);
      const found = new Set([...live.document.tables.map(t => t.name), ...live.unsupported.map(u => u.table)]);
      const present = target.tables.filter(t => found.has(t.name)).map(t => t.name);
      if (present.length > 0 && present.length < target.tables.length) throw config(`install found only some tables of the document set: ${present.join(', ')}`);
      if (present.length === 0) {
        for (const statement of statements) await run('schema', [statement.table], statement.sql);
        live = await introspect(run, driver);
      }
      verifySet(installedDifferences(live.document, live.unsupported, target));
    };
    const db = this.u.db;
    if (driver === 'mysql') await db.withSession(session => apply(db.runner(session, null)));
    else await this.u.run(frame => apply((kind, tables, sql, params) => frame.statement(kind, tables, sql, params)));
    registerSet(this.u.db, model);
  }

  /**
   * Only raises the installed document set by adding it as a new version of the generated schema (docs/spec/schema.md "Adding
   * tables and columns"). It introspects the connection's database and compares the set's tables in the database with the set,
   * creates the set's tables that are not in the database with their indexes, foreign keys, checks and triggers, and adds to existing tables the missing
   * columns that are null or have a default, by running the plan steps of addTablesAndColumnsSteps, so the audit triggers of changed tables record the new columns.
   * Tables of other sets are left as they are, and no set is registered for them. Other differences are SCHEMA_DIFFERS before any statement.
   * If the manifest text does not hash to the declared hash, it is CONFIG first. PostgreSQL applies in an ongoing or new transaction,
   * while MySQL implicitly commits schema statements and SQLite rebuilds tables to add columns with foreign key settings turned off.
   * Since those foreign key settings do not change inside a transaction, both apply outside a transaction and are CONFIG inside one.
   * A created table is listed as "table", and an added column as
   * "table.column", returned in
   * table name and column order.
   */
  public async addTablesAndColumns(schema: Schema): Promise<string[]> {
    this.u.db.unsupportedOnMarkdown('addTablesAndColumns (schema evolution follows the flowmark migration rules)');
    const model = schemaModel(schema);
    const target = schemaTarget(model);
    const driver = this.u.db.pool.name;
    const apply = async (run: Runner): Promise<string[]> => {
      let live = await introspectSet(run, driver, model);
      const { added, steps, differences } = addTablesAndColumnsSteps(live.document, live.unsupported, target, driver);
      if (differences.length > 0) throw new OrmError(codes.SCHEMA_DIFFERS, `the existing tables of the document set differ beyond missing tables, missing columns that are null or have a default and missing indexes: ${differences.join('; ')}`);
      // The statements of a step create or change the tables that its effect points to.
      for (const step of steps) await run('schema', step.effect.table === '' ? [] : [step.effect.table], step.statement);
      // Reads the database again after running the step to check that it equals the set.
      if (steps.length > 0) live = await introspect(run, driver);
      verifySet(installedDifferences(live.document, live.unsupported, target));
      return [...added];
    };
    const db = this.u.db;
    if (driver === 'postgres') return this.u.run(frame => apply((kind, tables, sql, params) => frame.statement(kind, tables, sql, params)));
    if (activeFor(this.u.db)) throw config(`${driver} adds tables and columns outside a transaction: MySQL commits schema statements implicitly and SQLite turns foreign keys off to rebuild a table`);
    if (driver === 'mysql') return db.withSession(session => apply(db.runner(session, null)));
    return db.withSession(session => withoutForeignKeys(db, session, apply));
  }

  public async exists(name: string): Promise<boolean> {
    if (!validKey(name)) throw config(`schema name ${name} is invalid`);
    switch (this.u.db.driver) {
      case 'postgres': return this.check('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)', [name]);
      case 'mysql': return this.check('SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)', [name]);
      default: return this.check("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE ? ESCAPE '\\')", [`${name.replaceAll('_', '\\_')}\\_\\_%`]);
    }
  }

  public async installed(name: string, table: string): Promise<boolean> {
    if (!validKey(name) || !validKey(table)) throw config('schema and table names are required');
    switch (this.u.db.driver) {
      case 'postgres': return this.check('SELECT to_regclass($1) IS NOT NULL', [`${name}.${table}`]);
      case 'mysql': return this.check('SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)', [name, table]);
      default: return this.check("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?)", [`${name}__${table}`]);
    }
  }

  /**
   * Reports whether the database holds no user content. On PostgreSQL a schema
   * other than public, information_schema and the pg_ schemas is content even
   * without objects, and so is a table, partitioned table, view, materialized
   * view or foreign table in public. On MySQL a table or view of the connected
   * database is content, and on SQLite a table or view other than the sqlite_
   * and orm__ tables is content.
   */
  public async empty(): Promise<boolean> {
    switch (this.u.db.driver) {
      case 'postgres': return this.check("SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND (n.nspname <> 'public' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))))");
      case 'mysql': return this.check('SELECT NOT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())');
      default: return this.check("SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'orm\\_\\_%' ESCAPE '\\')");
    }
  }
}

/** Table privileges (PostgreSQL only). */
export class PrivilegeUtils {
  public constructor(private readonly u: Utils) {}

  private table(table: string): string {
    if (this.u.db.driver !== 'postgres') throw new OrmError(codes.CAPABILITY_UNSUPPORTED, 'table privileges are supported only by postgres');
    const parts = table.split('.');
    if (parts.length !== 2 || !parts.every(validKey)) throw config('a qualified table name is required');
    return parts.map(part => quote('postgres', part)).join('.');
  }

  private role(name: string): string {
    if (!validKey(name)) throw config(`role ${name} is invalid`);
    return quote('postgres', name);
  }

  public async grantTable(table: string, role: string): Promise<void> {
    const qualified = this.table(table);
    const r = this.role(role);
    await this.u.run(async frame => {
      await frame.statement('utility', [table], `GRANT USAGE ON SCHEMA ${qualified.slice(0, qualified.indexOf('.'))} TO ${r}`);
      await frame.statement('utility', [table], `GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualified} TO ${r}`);
    });
  }

  public async revokeTable(table: string, privilege: string, role: string): Promise<void> {
    const qualified = this.table(table);
    const r = this.role(role);
    const upper = privilege.trim().toUpperCase();
    if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(upper)) throw config(`unsupported table privilege ${privilege}`);
    await this.u.run(async frame => { await frame.statement('utility', [table], `REVOKE ${upper} ON ${qualified} FROM ${r}`); });
  }

  public async inspectTable(table: string): Promise<TablePrivileges> {
    const qualified = this.table(table);
    const row = (await this.u.read('utility', [table], `SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'), has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')`, [qualified]))[0];
    if (row === undefined) throw new OrmError(codes.INTERNAL, `the privileges of ${table} returned no row`);
    return { insert: row[0] === true, select: row[1] === true, update: row[2] === true, delete: row[3] === true, truncate: row[4] === true };
  }
}

interface AesSpec { table: string; keys: readonly string[]; version: string; columns: Array<{ name: string; styles: string[] }>; }

/** AES key version status and rotation. */
export class AesUtils {
  public constructor(private readonly u: Utils) {}

  private spec(model: unknown): AesSpec {
    this.u.db.unsupportedOnMarkdown('aes rotation');
    if (!isModel(model)) throw config('aes requires a model');
    const schema = model[CORE].ent.entity;
    const columns = schema.fields
      .filter(col => col.stages.includes('aes'))
      .map(col => ({ name: col.name, styles: col.stages.filter(s => s === 'aes' || s === 'hex') }));
    if (schema.aesVersion === '' || columns.length === 0) throw config(`entity ${schema.name} has no AES columns with a key version`);
    return { table: schema.table, keys: schema.primaryKey, version: schema.aesVersion, columns };
  }

  public async status(model: unknown, keyring: AesKeyring): Promise<AesRotationStatus> {
    const spec = this.spec(model);
    const q = (name: string) => quote(this.u.db.driver, name);
    const rows = await this.u.read('utility', [spec.table], `SELECT ${q(spec.version)}, COUNT(*) FROM ${q(spec.table)} GROUP BY ${q(spec.version)} ORDER BY ${q(spec.version)}`, []);
    const versions = new Map<number, number>();
    let total = 0;
    let pending = 0;
    for (const row of rows) {
      const version = versionOf(row[0]);
      const count = Number(row[1]);
      versions.set(version, count);
      total += count;
      if (version !== keyring.currentVersion) pending += count;
    }
    return { current: keyring.currentVersion, total, pending, versions };
  }

  /** Re-encrypts every AES column of rows not at the current version in one transaction. */
  public async rotate(model: unknown, keyring: AesKeyring): Promise<number> {
    const spec = this.spec(model);
    const driver = this.u.db.driver;
    const q = (name: string) => quote(driver, name);
    const ph = (n: number) => driver === 'postgres' ? `$${n}` : '?';
    const columns = [...spec.keys.map(q), q(spec.version), ...spec.columns.map(c => q(c.name))];
    const select = `SELECT ${columns.join(', ')} FROM ${q(spec.table)} WHERE ${q(spec.version)} <> ${ph(1)} ORDER BY ${spec.keys.map(q).join(', ')} LIMIT 1000`;
    const sets = [...spec.columns.map((c, i) => `${q(c.name)} = ${ph(i + 1)}`), `${q(spec.version)} = ${ph(spec.columns.length + 1)}`];
    const where = [...spec.keys.map((k, i) => `${q(k)} = ${ph(spec.columns.length + 2 + i)}`), `${q(spec.version)} = ${ph(spec.columns.length + 2 + spec.keys.length)}`];
    const updateSql = `UPDATE ${q(spec.table)} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`;
    const codec = {
      decode: (value: unknown, styles: readonly string[], key: string) => {
        if (value !== null && typeof value !== 'string' && !(value instanceof Uint8Array)) {
          throw new OrmError(codes.CODEC_DECODE, `aes rotation read a ${typeof value} value of ${key}`);
        }
        return hostDecode(value, styles, key);
      },
      encode: (value: unknown, styles: readonly string[], key: string) => hostEncode(value, styles, key),
    };
    return this.u.run(async frame => {
      let rotated = 0;
      for (;;) {
        const rows = (await frame.statement('utility', [spec.table], select, [keyring.currentVersion])).rows;
        if (rows.length === 0) return rotated;
        for (const values of rows) {
          const before: Record<string, unknown> = {};
          spec.keys.forEach((k, i) => { before[k] = values[i]; });
          const version = versionOf(values[spec.keys.length]);
          before[spec.version] = version;
          spec.columns.forEach((c, i) => { before[c.name] = values[spec.keys.length + 1 + i]; });
          const after = keyring.rotateRow(before, spec.version, spec.columns, keyring.currentVersion, codec);
          const params: DriverValue[] = [
            ...spec.columns.map(c => driverValue(after[c.name], `the rotated column ${c.name}`)),
            keyring.currentVersion,
            ...spec.keys.map(k => driverValue(before[k], `the key column ${k}`)),
            version,
          ];
          const result = await frame.statement('utility', [spec.table], updateSql, params);
          if (result.affected !== 1) throw new OrmError(codes.DEADLOCK, `aes rotation of ${spec.table} changed ${result.affected} rows`);
          rotated++;
        }
      }
    });
  }
}
