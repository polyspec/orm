import { hostDecode, hostEncode } from './codec.js';
import { CORE, isModel } from './core.js';
import { activeFor, registerSet, schemaModel, type Db, type Runner, type Schema, type TxFrame } from './database.js';
import type { DriverName, DriverSession, DriverValue, PoolStats } from './driver.js';
import type { StatementKind } from './events.js';
import { AesKeyring } from './aes.js';
import { addTablesAndColumnsSteps, dbspecManifest, emitDbspec, externalDifferences, installedDifferences, parseDbspec, renderDbspecStatements, type DbspecDocument } from './dbspec/index.js';
import { introspectCatalog, type DbspecIntrospection } from './dbspec/introspect.js';
import { CatalogRow } from './dbspec/introspect_catalog.js';
import type { RuntimeModel } from './engine/model.js';
import { OrmError, joinedErrors, rollbackFailed } from './runtime_error.js';

export interface AesRotationStatus {
  current: number;
  total: number;
  pending: number;
  versions: ReadonlyMap<number, number>;
}

export interface TablePrivileges { insert: boolean; select: boolean; update: boolean; delete: boolean; truncate: boolean; }

function validKey(key: string): boolean { return /^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$/.test(key); }

function config(message: string): OrmError { return new OrmError('CONFIG', message); }

function quote(driver: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw config(`invalid identifier ${name}`);
  return driver === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

function versionOf(value: unknown): number {
  const version = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new OrmError('CODEC_DECODE', `aes version ${String(value)} is out of range`);
  return version;
}

/**
 * SQLite 연결의 foreign key를 끄고 BEGIN IMMEDIATE transaction으로 fn을 실행한 뒤 foreign key 검사가
 * row를 돌려주지 않을 때만 commit하고 foreign key를 다시 켠다(docs/plans.md "Apply"의 SQLite 다시
 * 만들기). transaction은 연결의 다음 번호를 받고, foreign key를 바꾸는 statement는 transaction 밖이다.
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
      if (broken !== 0) throw new OrmError('INTERNAL', `the rebuilt tables break ${broken} foreign keys`);
    } catch (error) {
      try { await inside('rollback', [], 'ROLLBACK'); } catch (rollback) { throw rollbackFailed(error, rollback); }
      throw error;
    }
    await inside('commit', [], 'COMMIT');
  } catch (error) {
    // foreign key를 다시 켜지 못하면 두 오류를 함께 돌려준다.
    try { await outside('utility', [], 'PRAGMA foreign_keys = ON'); } catch (restore) { throw joinedErrors([error, restore]); }
    throw error;
  }
  await outside('utility', [], 'PRAGMA foreign_keys = ON');
  return result;
}

/** 외부 문서의 쓰는 table이 database와 다른 set의 CONFIG다. */
function externalError(differences: readonly string[]): OrmError {
  return config(`the tables that the set uses from external documents differ from the database: ${differences.join('; ')}`);
}

/** set의 외부 문서 text를 문서 이름마다 돌려준다. schema text의 use 줄을 parse할 때 쓴다. */
function externalTexts(model: RuntimeModel): Record<string, string> {
  return Object.fromEntries(model.documents.filter(d => d.external === true).map(d => [d.name, emitDbspec(d)]));
}

/** 연결의 database를 introspect한다. run은 연결의 statement를 보낸다. catalog query는 table을 가리키지 않는 schema statement다. */
async function introspect(run: Runner, driver: DriverName): Promise<DbspecIntrospection> {
  return introspectCatalog(async sql => (await run('schema', [], sql)).rows.map(values => new CatalogRow(sql, values as unknown[])), driver, 'schema');
}

/**
 * 연결의 database를 introspect하고, set이 외부 문서에서 쓰는 table이 외부 문서와 다르면 CONFIG다(docs/dbspec.md
 * "External documents").
 */
async function introspectSet(run: Runner, driver: DriverName, model: RuntimeModel): Promise<DbspecIntrospection> {
  const live = await introspect(run, driver);
  const differences = externalDifferences(live.document, model.documents);
  if (differences.length > 0) throw externalError(differences);
  return live;
}

/** database가 set과 다르면 그 차이를 모두 담은 CONFIG다. */
function verifySet(differences: readonly string[]): void {
  if (differences.length > 0) throw config(`the database differs from the document set: ${differences.join('; ')}`);
}

/** set의 schema text 문서다. database와 비교하는 대상이다. */
function schemaTarget(model: RuntimeModel): DbspecDocument {
  const manifest = dbspecManifest(model.documents);
  // schema text의 use 줄은 외부 문서를 가리키므로 외부 문서를 집합으로 삼아 parse한다.
  const parsed = manifest.manifest === null ? null : parseDbspec(manifest.manifest.schemaText, externalTexts(model));
  const failed = manifest.manifest === null ? manifest.diagnostics : parsed!.diagnostics;
  if (failed.length > 0) {
    const d = failed[0]!;
    throw new OrmError('SCHEMA_INVALID', `document set: ${d.rule} at ${d.line}:${d.column}: ${d.message}`);
  }
  return parsed!.document!;
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
    return this.db.transaction(() => fn(activeFor(this.db)!), { retry: 0 });
  }

  /**
   * Reads the rows of a statement through the active transaction of the connection, or through the pool;
   * kind and tables are those of its statement event.
   *
   * @internal
   */
  public async read(kind: StatementKind, tables: readonly string[], sql: string, params: readonly DriverValue[] = []): Promise<unknown[][]> {
    const frame = activeFor(this.db);
    if (frame) return (await frame.run(kind, tables, sql, params)).rows;
    return (await this.db.pool.execute(sql, params, undefined, this.db.statementDone(kind, tables, null, params))).rows;
  }

  /** Takes a named lock that is released when the transaction ends. */
  public async lock(key: string): Promise<void> {
    const frame = this.active('lock');
    if (!validKey(key)) throw config(`lock key ${key} is invalid`);
    switch (this.db.driver) {
      case 'mysql': {
        const got = (await frame.run('utility', [], 'SELECT GET_LOCK(?, 50)', [key])).rows[0]?.[0];
        if (Number(got) !== 1) throw new OrmError('DEADLOCK', `lock ${key} was not acquired`);
        frame.locks.push(key);
        return;
      }
      case 'postgres':
        await frame.run('utility', [], 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
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
    const frame = this.active('setLocal');
    if (!validKey(key)) throw config(`local key ${key} is invalid`);
    switch (this.db.driver) {
      case 'postgres':
        await frame.run('utility', [], 'SELECT set_config($1, $2, true)', [key, value]);
        break;
      case 'mysql':
        await frame.run('utility', [], `SET @\`orm.${key}\` = ?`, [value]);
        break;
    }
    frame.locals.set(key, value);
  }

  /** Returns a value set with setLocal; NO_ROWS when it is missing. */
  public async local(key: string): Promise<string> {
    const frame = this.active('local');
    const value = frame.locals.get(key);
    if (value === undefined) throw new OrmError('NO_ROWS', `local value ${key} is not set`);
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
    const value = (await this.u.read('schema', [], sql, params))[0]?.[0];
    return value === true || Number(value) === 1;
  }

  /**
   * generated schema의 set을 이 연결에 등록한다. database를 읽거나 쓰지 않는다: manifest text가 선언한
   * hash로 hash되는지 확인하고(아니면 CONFIG) set을 등록할 뿐이다. 같은 set을 다시 등록하면 아무것도
   * 바꾸지 않는다. database가 set과 같은지는 install과 addTablesAndColumns가 설치와 upgrade 때
   * 확인하며, 요청마다 연 연결에도 register가 statement 없이 set을 등록한다(docs/schema.md "Schema
   * registration").
   */
  public register(schema: Schema): void {
    registerSet(this.u.db, schemaModel(schema));
  }

  /**
   * generated schema의 document set을 연결의 database에 설치하고, database가 set과 같은지 확인한 뒤 그
   * set을 이 연결에 등록한다. manifest text가 선언한 hash로 hash되지 않으면 어떤 statement보다 먼저
   * CONFIG다. 연결의 database를 introspect해, 외부 문서에서 쓰는 table이 외부 문서와 다르면 CONFIG다.
   * set이 소유한 table이 하나도 없으면 render한 statement(docs/dialects.md "Rendered statements")로 모두
   * 만들고, 모두 있으면 아무것도 만들지 않으며, 일부만 있으면 CONFIG다. 그다음 database를 다시 읽어 set이
   * 소유한 table을 set과 비교하고, 차이가 있으면 그 차이를 모두 담은 CONFIG다(docs/schema.md "Schema
   * installation"). PostgreSQL과 SQLite는 진행 중인 transaction이나 새 transaction에서 적용하므로 실패한
   * install은 아무것도 남기지 않는다. MySQL은 schema statement를 암묵적으로 commit하므로 transaction
   * 밖에서 적용하고 안에서는 CONFIG다.
   */
  public async install(schema: Schema): Promise<void> {
    const model = schemaModel(schema);
    const rendered = renderDbspecStatements(model.documents, this.u.db.driver);
    if (rendered.statements === null) {
      const d = rendered.diagnostics[0]!;
      throw new OrmError('SCHEMA_INVALID', `document set: ${d.rule} at ${d.line}:${d.column}: ${d.message}`);
    }
    const statements = rendered.statements;
    const target = schemaTarget(model);
    const driver = this.u.db.driver;
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
    else await this.u.run(frame => apply((kind, tables, sql, params) => frame.run(kind, tables, sql, params)));
    registerSet(this.u.db, model);
  }

  /**
   * 설치한 document set을 generated schema의 새 version으로 더해서만 올린다(docs/schema.md "Adding
   * tables and columns"). 연결의 database를 introspect해 database에 있는 set의 table을 set과 비교하고,
   * database에 없는 set의 table을 index, foreign key, check, trigger와 함께 만들며, 있는 table에 빠진
   * column 가운데 null이거나 default가 있는 column을 더한다. addTablesAndColumnsSteps의 plan step을
   * 실행하므로 바뀐 table의 audit trigger도 새 column을 기록하도록 바뀐다. 다른 set의 table은 그대로
   * 두며 set을 등록하지 않는다. 다른 차이는 어떤 statement보다 먼저 SCHEMA_DIFFERS다. manifest text가
   * 선언한 hash로 hash되지 않으면 먼저 CONFIG다. PostgreSQL은 진행 중인 transaction이나 새
   * transaction에서 적용한다. MySQL은 schema statement를 암묵적으로 commit하고, SQLite는 foreign key를
   * 끈 채 table을 다시 만들어 column을 더하는데 foreign key 설정은 transaction 안에서 바뀌지 않으므로,
   * 둘 다 transaction 밖에서 적용하고 안에서는 CONFIG다. 만든 table은 "table", 더한 column은
   * "table.column"으로 table 이름, column 순서로 돌려준다.
   */
  public async addTablesAndColumns(schema: Schema): Promise<string[]> {
    const model = schemaModel(schema);
    const target = schemaTarget(model);
    const driver = this.u.db.driver;
    const apply = async (run: Runner): Promise<string[]> => {
      let live = await introspectSet(run, driver, model);
      const { added, steps, differences } = addTablesAndColumnsSteps(live.document, live.unsupported, target, driver);
      if (differences.length > 0) throw new OrmError('SCHEMA_DIFFERS', `the existing tables of the document set differ beyond missing tables, missing columns that are null or have a default and missing indexes: ${differences.join('; ')}`);
      // step의 statement는 그 효과가 가리키는 table을 만들거나 바꾼다.
      for (const step of steps) await run('schema', step.effect.table === '' ? [] : [step.effect.table], step.statement);
      // step을 실행한 database가 set과 같은지 다시 읽어 확인한다.
      if (steps.length > 0) live = await introspect(run, driver);
      verifySet(installedDifferences(live.document, live.unsupported, target));
      return [...added];
    };
    const db = this.u.db;
    if (driver === 'postgres') return this.u.run(frame => apply((kind, tables, sql, params) => frame.run(kind, tables, sql, params)));
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
    if (this.u.db.driver !== 'postgres') throw new OrmError('CAPABILITY_UNSUPPORTED', 'table privileges are supported only by postgres');
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
      await frame.run('utility', [table], `GRANT USAGE ON SCHEMA ${qualified.slice(0, qualified.indexOf('.'))} TO ${r}`);
      await frame.run('utility', [table], `GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualified} TO ${r}`);
    });
  }

  public async revokeTable(table: string, privilege: string, role: string): Promise<void> {
    const qualified = this.table(table);
    const r = this.role(role);
    const upper = privilege.trim().toUpperCase();
    if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(upper)) throw config(`unsupported table privilege ${privilege}`);
    await this.u.run(async frame => { await frame.run('utility', [table], `REVOKE ${upper} ON ${qualified} FROM ${r}`); });
  }

  public async inspectTable(table: string): Promise<TablePrivileges> {
    const qualified = this.table(table);
    const row = (await this.u.read('utility', [table], `SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'), has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')`, [qualified]))[0]!;
    return { insert: row[0] === true, select: row[1] === true, update: row[2] === true, delete: row[3] === true, truncate: row[4] === true };
  }
}

interface AesSpec { table: string; keys: readonly string[]; version: string; columns: Array<{ name: string; styles: string[] }>; }

/** AES key version status and rotation. */
export class AesUtils {
  public constructor(private readonly u: Utils) {}

  private spec(model: unknown): AesSpec {
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
      decode: (value: unknown, styles: readonly string[], key: string) => hostDecode(value as string | Uint8Array | null, styles, key),
      encode: (value: unknown, styles: readonly string[], key: string) => hostEncode(value, styles, key),
    };
    return this.u.run(async frame => {
      let rotated = 0;
      for (;;) {
        const rows = (await frame.run('utility', [spec.table], select, [keyring.currentVersion])).rows;
        if (rows.length === 0) return rotated;
        for (const values of rows) {
          const before: Record<string, unknown> = {};
          spec.keys.forEach((k, i) => { before[k] = values[i]; });
          const version = versionOf(values[spec.keys.length]);
          before[spec.version] = version;
          spec.columns.forEach((c, i) => { before[c.name] = values[spec.keys.length + 1 + i]; });
          const after = keyring.rotateRow(before, spec.version, spec.columns, keyring.currentVersion, codec);
          const params = [...spec.columns.map(c => after[c.name]), keyring.currentVersion, ...spec.keys.map(k => before[k]), version] as DriverValue[];
          const result = await frame.run('utility', [spec.table], updateSql, params);
          if (result.affected !== 1) throw new OrmError('DEADLOCK', `aes rotation of ${spec.table} changed ${result.affected} rows`);
          rotated++;
        }
      }
    });
  }
}
