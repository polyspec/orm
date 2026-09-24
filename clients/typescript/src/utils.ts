import { hostDecode, hostEncode } from './codec.js';
import { CORE, isModel } from './core.js';
import { activeFor, type Db, type TxFrame } from './database.js';
import type { DriverValue, PoolStats } from './driver.js';
import { AesKeyring } from './aes.js';
import { Engine } from './engine/index.js';
import { OrmError } from './runtime_error.js';

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

/** Runs fn in the active transaction of db, or in a new one. */
async function inTx<T>(db: Db, fn: (frame: TxFrame) => Promise<T>): Promise<T> {
  const frame = activeFor(db);
  if (frame) return fn(frame);
  return db.transaction(() => fn(activeFor(db)!), { retry: 0 });
}

async function read(db: Db, sql: string, params: readonly DriverValue[]): Promise<unknown[][]> {
  const frame = activeFor(db);
  return frame ? (await frame.tx.control(sql, params)).rows : (await db.pool.execute(sql, params)).rows;
}

/** Operations outside the query syntax. */
export class Utils {
  public constructor(private readonly db: Db) {}

  public stats(): PoolStats { return this.db.stats(); }

  private active(name: string): TxFrame {
    const frame = activeFor(this.db);
    if (!frame) throw config(`${name} requires an active transaction of the connection`);
    return frame;
  }

  /** Runs fn in the active transaction of the connection, or in a new one. */
  /** Takes a named lock that is released when the transaction ends. */
  public async lock(key: string): Promise<void> {
    const frame = this.active('lock');
    if (!validKey(key)) throw config(`lock key ${key} is invalid`);
    switch (this.db.driver) {
      case 'mysql': {
        const got = (await frame.tx.control('SELECT GET_LOCK(?, 50)', [key])).rows[0]?.[0];
        if (Number(got) !== 1) throw new OrmError('DEADLOCK', `lock ${key} was not acquired`);
        frame.locks.push(key);
        return;
      }
      case 'postgres':
        await frame.tx.control('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        return;
      default:
        await frame.tx.rowLock('update');
    }
  }

  /** Sets a transaction-local value. */
  public async setLocal(key: string, value: string): Promise<void> {
    const frame = this.active('setLocal');
    if (!validKey(key)) throw config(`local key ${key} is invalid`);
    switch (this.db.driver) {
      case 'postgres':
        await frame.tx.control('SELECT set_config($1, $2, true)', [key, value]);
        break;
      case 'mysql':
        await frame.tx.control(`SET @\`orm.${key}\` = ?`, [value]);
        break;
      default:
        await frame.tx.control('CREATE TABLE IF NOT EXISTS "orm__context" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)');
        await frame.tx.control('INSERT INTO "orm__context" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"', [key, value]);
        frame.contextRow = true;
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

  public schema(): SchemaUtils { return new SchemaUtils(this.db); }
  public privileges(): PrivilegeUtils { return new PrivilegeUtils(this.db); }
  public aes(): AesUtils { return new AesUtils(this.db); }
}

/** Schema installation and inspection. */
export class SchemaUtils {
  public constructor(private readonly db: Db) {}

  private async check(sql: string, params: readonly DriverValue[] = []): Promise<boolean> {
    const value = (await read(this.db, sql, params))[0]?.[0];
    return value === true || Number(value) === 1;
  }

  /**
   * Installs a schema manifest and adds it to the connection. PostgreSQL and
   * SQLite apply it in the active transaction or in a new one; MySQL commits
   * schema statements implicitly, so it applies them outside a transaction
   * and rejects a call inside one with CONFIG.
   */
  public async install(manifestJson: string): Promise<void> {
    let engine: Engine;
    try { engine = Engine.load(manifestJson, this.db.driver); } catch (error) {
      throw config(`invalid schema manifest: ${(error as Error).message}`);
    }
    const statements = engine.installStatements();
    if (statements.length === 0) throw config('schema manifest produced no statements');
    if (this.db.pool.unprepared) {
      // MySQL commits schema statements implicitly, so they run outside a transaction.
      if (activeFor(this.db)) throw config('MySQL commits schema statements implicitly; install outside a transaction');
      await this.db.pool.unprepared(statements);
    } else {
      await inTx(this.db, async frame => {
        for (const statement of statements) await frame.tx.control(statement);
      });
    }
    this.db.registerEngine(engine);
  }

  public async exists(name: string): Promise<boolean> {
    if (!validKey(name)) throw config(`schema name ${name} is invalid`);
    switch (this.db.driver) {
      case 'postgres': return this.check('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)', [name]);
      case 'mysql': return this.check('SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)', [name]);
      default: return this.check("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE ? ESCAPE '\\')", [`${name.replaceAll('_', '\\_')}\\_\\_%`]);
    }
  }

  public async installed(name: string, table: string): Promise<boolean> {
    if (!validKey(name) || !validKey(table)) throw config('schema and table names are required');
    switch (this.db.driver) {
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
    switch (this.db.driver) {
      case 'postgres': return this.check("SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND (n.nspname <> 'public' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))))");
      case 'mysql': return this.check('SELECT NOT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())');
      default: return this.check("SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'orm\\_\\_%' ESCAPE '\\')");
    }
  }
}

/** Table privileges (PostgreSQL only). */
export class PrivilegeUtils {
  public constructor(private readonly db: Db) {}

  private table(table: string): string {
    if (this.db.driver !== 'postgres') throw new OrmError('CAPABILITY_UNSUPPORTED', 'table privileges are supported only by postgres');
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
    await inTx(this.db, async frame => {
      await frame.tx.control(`GRANT USAGE ON SCHEMA ${qualified.slice(0, qualified.indexOf('.'))} TO ${r}`);
      await frame.tx.control(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualified} TO ${r}`);
    });
  }

  public async revokeTable(table: string, privilege: string, role: string): Promise<void> {
    const qualified = this.table(table);
    const r = this.role(role);
    const upper = privilege.trim().toUpperCase();
    if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(upper)) throw config(`unsupported table privilege ${privilege}`);
    await inTx(this.db, async frame => { await frame.tx.control(`REVOKE ${upper} ON ${qualified} FROM ${r}`); });
  }

  public async inspectTable(table: string): Promise<TablePrivileges> {
    const qualified = this.table(table);
    const row = (await read(this.db, `SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'),
 has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')`, [qualified]))[0]!;
    return { insert: row[0] === true, select: row[1] === true, update: row[2] === true, delete: row[3] === true, truncate: row[4] === true };
  }
}

interface AesSpec { table: string; keys: readonly string[]; version: string; columns: Array<{ name: string; styles: string[] }>; }

/** AES key version status and rotation. */
export class AesUtils {
  public constructor(private readonly db: Db) {}

  private spec(model: unknown): AesSpec {
    if (!isModel(model)) throw config('aes requires a model');
    const schema = model[CORE].ent.schema;
    const columns = Object.entries(schema.columns)
      .filter(([, col]) => (col.styles ?? []).includes('aes'))
      .map(([name, col]) => ({ name, styles: (col.styles ?? []).filter(s => s === 'aes' || s === 'hex') }));
    if (!schema.aesVersion || columns.length === 0) throw config(`entity ${schema.name} has no AES columns with a key version`);
    return { table: schema.table, keys: schema.pk, version: schema.aesVersion, columns };
  }

  public async status(model: unknown, keyring: AesKeyring): Promise<AesRotationStatus> {
    const spec = this.spec(model);
    const q = (name: string) => quote(this.db.driver, name);
    const rows = await read(this.db, `SELECT ${q(spec.version)}, COUNT(*) FROM ${q(spec.table)} GROUP BY ${q(spec.version)} ORDER BY ${q(spec.version)}`, []);
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
    const driver = this.db.driver;
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
    return inTx(this.db, async frame => {
      let rotated = 0;
      for (;;) {
        const rows = (await frame.tx.control(select, [keyring.currentVersion])).rows;
        if (rows.length === 0) return rotated;
        for (const values of rows) {
          const before: Record<string, unknown> = {};
          spec.keys.forEach((k, i) => { before[k] = values[i]; });
          const version = versionOf(values[spec.keys.length]);
          before[spec.version] = version;
          spec.columns.forEach((c, i) => { before[c.name] = values[spec.keys.length + 1 + i]; });
          const after = keyring.rotateRow(before, spec.version, spec.columns, keyring.currentVersion, codec);
          const params = [...spec.columns.map(c => after[c.name]), keyring.currentVersion, ...spec.keys.map(k => before[k]), version] as DriverValue[];
          const result = await frame.tx.control(updateSql, params);
          if (result.affected !== 1) throw new OrmError('DEADLOCK', `aes rotation of ${spec.table} changed ${result.affected} rows`);
          rotated++;
        }
      }
    });
  }
}
