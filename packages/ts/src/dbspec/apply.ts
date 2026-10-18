// Applies a plan chain to a database one step at a time, continues an interrupted plan or
// rolls it back, and finalizes an applied plan (docs/plans.md "Apply"). The reference is the Go engine
// (engine/dbspec/apply.go); the lock, session settings, history table, steps, validation and effects
// queries are the same as Go.
import { present } from '../present.js';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { inspect } from 'node:util';
import { isMySqlConnection, isPostgresConnection, isSqliteConnection, rowArrays, type DbspecMySqlConnection, type DbspecPostgresConnection, type DbspecSqliteConnection } from './connections.js';
import { dbspecManifest } from './index.js';
import { introspectCatalog } from './introspect.js';
import { CatalogRow } from './introspect_catalog.js';
import type { DbspecDocument } from './model.js';
import { chainPlans, type DbspecPlan } from './plan.js';
import { effectText, planSteps, type DbspecEffect, type DbspecPlanStep } from './plan_steps.js';
import { Renderer, type DbspecDialect } from './render.js';

/** A mysql2 promise connection or pool connection; apply runs its lock and statements on it. */
export type DbspecApplyMySqlConnection = DbspecMySqlConnection;
/** A pg client or pool client; apply runs its lock and transactions on it. */
export type DbspecApplyPostgresConnection = DbspecPostgresConnection;
/** A node:sqlite database. */
export type DbspecApplySqliteConnection = DbspecSqliteConnection;

/** What apply, recover, rollback and finalize report (docs/plans.md "Apply"). */
export type DbspecApplyEventKind = 'plan' | 'rollback' | 'finalize' | 'irreversible' | 'statement' | 'applied' | 'verified' | 'done';

/**
 * An occurrence of a command: `plan`, `rollback` or `finalize` when it starts
 * on a plan (with its number of steps), `irreversible` with the index and
 * statement of a step without rollback, `statement` before and `applied`
 * after each statement or rollback statement (with its step index and
 * text), `verified` and `done`. `step` is 0 and `statement` is '' for the
 * events of a whole plan.
 */
export interface DbspecApplyEvent {
  readonly kind: DbspecApplyEventKind;
  readonly plan: string;
  readonly step: number;
  readonly steps: number;
  readonly statement: string;
}

/** Receives each event; a thrown error or a rejected promise stops apply at that point with that error. */
export type DbspecApplyHandler = (event: DbspecApplyEvent) => void | Promise<void>;

/** The kind of a command failure. */
export type DbspecApplyErrorCode = 'locked' | 'session' | 'interrupted' | 'drift' | 'chain' | 'failed' | 'verify' | 'irreversible' | 'nulls';

/**
 * A failure of apply, recover, rollback or finalize. `plan` is '' when no
 * plan is concerned, `step` is the step index of `failed`, `interrupted`,
 * `irreversible`, `nulls` and a `session` error before a step, `detail` the explanation and `cause` the
 * database or verification error.
 */
export class DbspecApplyError extends Error {
  readonly code: DbspecApplyErrorCode;
  readonly plan: string;
  readonly step: number;
  readonly detail: string;

  constructor(code: DbspecApplyErrorCode, plan: string, step: number, detail: string, cause?: unknown) {
    let message: string = code;
    if (plan !== '') message += ` ${plan}`;
    if (code === 'failed' || code === 'interrupted' || code === 'irreversible' || code === 'nulls' || (code === 'session' && plan !== '')) message += ` at step ${step}`;
    if (detail !== '') message += `: ${detail}`;
    if (cause !== undefined) message += `: ${cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : inspect(cause)}`;
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DbspecApplyError';
    this.code = code;
    this.plan = plan;
    this.step = step;
    this.detail = detail;
  }
}

// The history table records the applied plans. A dbspec name has no $, so
// it does not overlap a user table, and introspection reads without the tables that start with dbspec$.
const HISTORY_TABLE = 'dbspec$plans';
// The apply lock name of the current database. MySQL lock names are up to 64 characters, so the database
// name is replaced by the first 51 characters of its SHA-256 hex to make 64 characters.
const MYSQL_LOCK = `CONCAT('${HISTORY_TABLE}$', LEFT(SHA2(DATABASE(), 256), 51))`;
// The advisory lock key of the current schema of the current database.
const POSTGRES_LOCK = `hashtext('${HISTORY_TABLE}'), hashtext(current_schema())`;
// The requirement that the session error reveals. The lock belongs to the server session, so the command must run from start to finish
// in one server session that is not shared with another client. A transaction pooler picks a server
// connection for each statement, so it cannot keep that requirement.
const SESSION_REQUIREMENT = 'apply, recover, rollback and finalize need one server session of their own for the whole run: a direct or session-pooled connection';
// Reads the id of the current server session and whether that session already holds this command's lock. Before the lock is taken,
// if it is already held, another client is using the same server session.
const SESSION_QUERIES: Readonly<Record<'mysql' | 'postgres', string>> = Object.freeze({
  mysql: `SELECT CONNECTION_ID(), COALESCE(IS_USED_LOCK(${MYSQL_LOCK}) = CONNECTION_ID(), 0)`,
  postgres: "SELECT pg_backend_pid(), EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objsubid = 2"
    + ` AND classid = (hashtext('${HISTORY_TABLE}')::bigint & 4294967295)::oid AND objid = (hashtext(current_schema())::bigint & 4294967295)::oid)`,
});
// The maximum time a statement waits for another session's lock (the lock wait in docs/plans.md "Apply").
const LOCK_WAIT_SECONDS = 5;

const APPLYING = 'applying';
const APPLIED = 'applied';
const FINALIZING = 'finalizing';
const DONE = 'done';
const ROLLING_BACK = 'rolling_back';

/**
 * A query that reads the kind of effect for each dialect. The arguments are the table and name of the effect, of which the query
 * uses one, and the query returns a count.
 */
export const EFFECT_QUERIES: Readonly<Record<DbspecDialect, Readonly<Record<string, string>>>> = Object.freeze({
  mysql: Object.freeze({
    table: 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    column: 'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    index: 'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    constraint: 'SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?',
    trigger: 'SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? AND TRIGGER_NAME = ?',
  }),
  postgres: Object.freeze({
    table: "SELECT COUNT(*) FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p') AND relname = $1",
    column:
      'SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped',
    index:
      'SELECT COUNT(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND i.relname = $2',
    constraint: 'SELECT COUNT(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND k.conname = $2',
    trigger:
      'SELECT COUNT(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND g.tgname = $2 AND NOT g.tgisinternal',
    function: 'SELECT COUNT(*) FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND proname = $1',
  }),
  sqlite: Object.freeze({
    table: "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    column: 'SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?',
    index: "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?",
    trigger: "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name = ?",
    sequence: 'SELECT COUNT(*) FROM sqlite_sequence WHERE name = ?',
  }),
});

// mysql2/promise exports the PromisePool class, but it is not in the type declarations.
const MYSQL_POOL = mysqlPoolClass();

function mysqlPoolClass(): Function {
  const value: unknown = Reflect.get(mysql, 'PromisePool');
  if (typeof value !== 'function') throw new Error('mysql2/promise does not export PromisePool');
  return value;
}

/** Runs statements and reads rows on one dialect connection. A row is an array of values. */
interface Session {
  exec(sql: string, args?: readonly (string | number)[]): Promise<void>;
  rows(sql: string, args?: readonly (string | number)[]): Promise<unknown[][]>;
}

function missingMethod(dialect: DbspecDialect, method: string): TypeError {
  return new TypeError(`a ${dialect} connection must have a ${method} method`);
}

function session(connection: unknown, dialect: DbspecDialect): Session {
  switch (dialect) {
    case 'mysql': {
      if (!isMySqlConnection(connection)) throw missingMethod(dialect, 'query');
      // The pool uses a different connection for each statement, so the lock and the records would not match.
      if (connection instanceof MYSQL_POOL) throw new TypeError('apply needs one mysql connection, not a pool');
      const c = connection;
      return {
        exec: async (sql, args = []) => {
          await c.query({ sql }, [...args]);
        },
        rows: async (sql, args = []) => rowArrays((await c.query({ sql, rowsAsArray: true }, [...args]))[0], 'mysql'),
      };
    }
    case 'postgres': {
      if (!isPostgresConnection(connection)) throw missingMethod(dialect, 'query');
      if (connection instanceof pg.Pool) throw new TypeError('apply needs one postgres client, not a pool');
      const c = connection;
      return {
        exec: async (sql, args = []) => {
          await c.query({ text: sql, values: [...args] });
        },
        rows: async (sql, args = []) => rowArrays((await c.query({ text: sql, values: [...args], rowMode: 'array' })).rows, 'postgres'),
      };
    }
    case 'sqlite': {
      if (!isSqliteConnection(connection)) throw missingMethod(dialect, 'prepare');
      const c = connection;
      return {
        exec: async (sql, args = []) => {
          if (args.length === 0) c.exec(sql);
          else c.prepare(sql).run(...args);
        },
        rows: async (sql, args = []) => {
          const statement = c.prepare(sql);
          statement.setReturnArrays(true);
          return rowArrays(statement.all(...args), 'sqlite');
        },
      };
    }
  }
  throw new TypeError(`unknown dbspec dialect ${String(dialect)}`);
}

/** The value of an integer column or COUNT. A non-integer value is an error. */
function integer(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  throw new Error(`${what} is not an integer: ${String(value)}`);
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not text: ${String(value)}`);
  return value;
}

/** The hash of an empty database is written to the history as empty. */
function hashOrEmpty(hash: string | null): string {
  return hash === null || hash === '' ? 'empty' : hash;
}

interface HistoryRow {
  from: string;
  to: string;
  state: string;
  step: number;
}

/** The AggregateError that this module makes from the collected cleanup errors. The outer cleanup unfolds it into one list. */
const cleanupAggregates = new WeakSet<AggregateError>();

/**
 * After running f, runs the ends in order, all of them, regardless of the earlier failure. If there is one error, it throws that
 * error; if there are two or more, it throws the AggregateError that holds, in order, the first error and the cleanup errors after it
 * throws.
 */
async function finish(f: () => Promise<void>, ...ends: (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = [];
  try {
    await f();
  } catch (error) {
    if (error instanceof AggregateError && cleanupAggregates.has(error)) {
      const errors: readonly unknown[] = error.errors;
      failures.push(...errors);
    }
    else failures.push(error);
  }
  for (const end of ends) {
    try {
      await end();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const aggregate = new AggregateError(failures, messageOf(failures[0]));
    cleanupAggregates.add(aggregate);
    throw aggregate;
  }
}

/** The index of the first finalize step. */
function finalizeStart(steps: readonly DbspecPlanStep[]): number {
  const i = steps.findIndex(s => s.finalize);
  return i < 0 ? steps.length : i;
}

/** The state of one command. */
class Applier {
  readonly s: Session;
  readonly r: Renderer;
  history = new Map<string, HistoryRow>();
  // The id of the server session that holds the lock (MySQL CONNECTION_ID, PostgreSQL pg_backend_pid).
  serverSession: number = 0;

  constructor(
    readonly connection: unknown,
    readonly dialect: DbspecDialect,
    readonly chain: readonly DbspecPlan[],
    readonly now: () => number,
    readonly events: DbspecApplyHandler | null,
  ) {
    this.s = session(connection, dialect);
    this.r = new Renderer(dialect);
  }

  q(name: string): string {
    return this.r.q(name);
  }

  async queryRow(sql: string, args: readonly (string | number)[] = []): Promise<unknown[]> {
    const rows = await this.s.rows(sql, args);
    if (rows.length === 0) throw new Error(`${sql} returned no row`);
    return present(rows[0], 'rows[0]');
  }

  async queryValue(sql: string, args: readonly (string | number)[] = []): Promise<unknown> {
    return (await this.queryRow(sql, args))[0];
  }

  /** Takes the dialect's lock and changes the session settings, runs f, and then restores the settings and releases the lock. */
  async session(f: () => Promise<void>): Promise<void> {
    switch (this.dialect) {
      case 'mysql': {
        await this.openSession(SESSION_QUERIES.mysql);
        // A NULL from GET_LOCK is an error raised while waiting for the lock.
        const [got, current] = await this.queryRow(`SELECT GET_LOCK(${MYSQL_LOCK}, 0), CONNECTION_ID()`);
        if (got === null) throw new Error('GET_LOCK returned NULL; want 1 or 0');
        const acquired = integer(got, 'GET_LOCK');
        if (acquired === 0) throw new DbspecApplyError('locked', '', 0, `another session holds the ${HISTORY_TABLE} lock of this database`);
        if (acquired !== 1) throw new Error(`GET_LOCK returned ${acquired}; want 1 or 0`);
        let previous: [number, number] | null = null;
        await finish(
          async () => {
            this.sameSession(null, 0, current);
            const row = await this.queryRow('SELECT @@SESSION.lock_wait_timeout, @@SESSION.innodb_lock_wait_timeout');
            const values: [number, number] = [integer(row[0], 'lock_wait_timeout'), integer(row[1], 'innodb_lock_wait_timeout')];
            await this.s.exec(`SET SESSION lock_wait_timeout = ${LOCK_WAIT_SECONDS}, innodb_lock_wait_timeout = ${LOCK_WAIT_SECONDS}`);
            previous = values;
            await f();
          },
          async () => {
            if (previous !== null) await this.s.exec(`SET SESSION lock_wait_timeout = ${previous[0]}, innodb_lock_wait_timeout = ${previous[1]}`);
          },
          () => this.s.exec(`DO RELEASE_LOCK(${MYSQL_LOCK})`),
        );
        return;
      }
      case 'postgres': {
        // If current_schema() is NULL, the result is also NULL and an error.
        await this.openSession(SESSION_QUERIES.postgres);
        const [got, current] = await this.queryRow(`SELECT pg_try_advisory_lock(${POSTGRES_LOCK}), pg_backend_pid()`);
        if (got !== true) {
          if (got !== false) throw new Error(`pg_try_advisory_lock returned ${String(got)}`);
          throw new DbspecApplyError('locked', '', 0, `another session holds the ${HISTORY_TABLE} advisory lock of this schema`);
        }
        let previous: string | null = null;
        await finish(
          async () => {
            this.sameSession(null, 0, current);
            const value = text(await this.queryValue("SELECT current_setting('lock_timeout')"), 'lock_timeout');
            await this.queryValue(`SELECT set_config('lock_timeout', '${LOCK_WAIT_SECONDS}s', false)`);
            previous = value;
            await f();
          },
          async () => {
            if (previous !== null) await this.queryValue("SELECT set_config('lock_timeout', $1, false)", [previous]);
          },
          async () => {
            const released = await this.queryValue(`SELECT pg_advisory_unlock(${POSTGRES_LOCK})`);
            if (released !== true) {
              if (released !== false) throw new Error(`pg_advisory_unlock returned ${String(released)}`);
              throw new Error(`the advisory lock of ${HISTORY_TABLE} was not held at unlock`);
            }
          },
        );
        return;
      }
    }
    await this.sqliteSession(f);
  }

  /** Locks the file in SQLite's exclusive locking mode, turns off foreign keys, and makes a rename carry the foreign keys of other tables along. */
  async sqliteSession(f: () => Promise<void>): Promise<void> {
    const foreignKeys = integer(await this.queryValue('PRAGMA foreign_keys'), 'PRAGMA foreign_keys');
    const legacy = integer(await this.queryValue('PRAGMA legacy_alter_table'), 'PRAGMA legacy_alter_table');
    const busy = integer(await this.queryValue('PRAGMA busy_timeout'), 'PRAGMA busy_timeout');
    const mode = text(await this.queryValue('PRAGMA locking_mode'), 'PRAGMA locking_mode');
    await this.s.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_SECONDS * 1000}`);
    await finish(
      async () => {
        await this.s.exec('PRAGMA locking_mode = EXCLUSIVE');
        try {
          await this.s.exec('BEGIN EXCLUSIVE');
        } catch (error) {
          throw new DbspecApplyError('locked', '', 0, 'another connection holds the SQLite database', error);
        }
        await this.s.exec('COMMIT');
        await this.s.exec('PRAGMA foreign_keys = OFF');
        await this.s.exec('PRAGMA legacy_alter_table = OFF');
        await f();
      },
      () => this.s.exec(`PRAGMA foreign_keys = ${foreignKeys}`),
      () => this.s.exec(`PRAGMA legacy_alter_table = ${legacy}`),
      () => this.s.exec(`PRAGMA locking_mode = ${mode}`),
      // After restoring the locking mode, one read is needed to release the exclusive lock.
      () => this.queryValue('SELECT COUNT(*) FROM sqlite_master'),
      () => this.s.exec(`PRAGMA busy_timeout = ${busy}`),
    );
  }

  /** Creates the history table if it does not exist. */
  async createHistory(): Promise<void> {
    const q = (n: string) => this.q(n);
    let integerType = 'integer';
    let textType = 'varchar(71)';
    let tail = '';
    if (this.dialect === 'mysql') {
      integerType = 'INT';
      textType = 'varchar(71) CHARACTER SET ascii COLLATE ascii_bin';
      tail = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
    }
    await this.s.exec(
      `CREATE TABLE IF NOT EXISTS ${q(HISTORY_TABLE)} (` +
        `${q('name')} ${textType} NOT NULL, ${q('from_hash')} ${textType} NOT NULL, ${q('to_hash')} ${textType} NOT NULL, ` +
        `${q('state')} ${textType} NOT NULL, ${q('step')} ${integerType} NOT NULL, ${q('steps')} ${integerType} NOT NULL, ` +
        `${q('applied_at')} ${textType} NOT NULL, PRIMARY KEY (${q('name')}))${tail}`,
    );
  }

  async readHistory(): Promise<void> {
    await this.createHistory();
    const q = (n: string) => this.q(n);
    this.history = new Map();
    const rows = await this.s.rows(`SELECT ${q('name')}, ${q('from_hash')}, ${q('to_hash')}, ${q('state')}, ${q('step')} FROM ${q(HISTORY_TABLE)}`);
    for (const row of rows) {
      this.history.set(text(row[0], 'history name'), {
        from: text(row[1], 'history from_hash'),
        to: text(row[2], 'history to_hash'),
        state: text(row[3], 'history state'),
        step: integer(row[4], 'history step'),
      });
    }
  }

  /** Reads the history and returns the number of recorded plans. The records must be at the front of the chain, and the row before the last must be applied or done. */
  async position(): Promise<number> {
    await this.readHistory();
    let position = 0;
    for (const [i, p] of this.chain.entries()) {
      const row = this.history.get(p.name);
      if (row === undefined) continue;
      if (row.to !== p.to || row.from !== hashOrEmpty(p.from)) {
        throw new DbspecApplyError('chain', p.name, 0, "the recorded plan has other hashes than the chain's plan");
      }
      if (i !== position) throw new DbspecApplyError('chain', p.name, 0, 'a plan before it in the chain is not recorded');
      if (![APPLYING, APPLIED, FINALIZING, DONE, ROLLING_BACK].includes(row.state)) {
        throw new DbspecApplyError('chain', p.name, 0, `the recorded state ${row.state} is not a history state`);
      }
      position = i + 1;
    }
    if (this.history.size !== position) throw new DbspecApplyError('chain', '', 0, 'the history records a plan that is not in the chain');
    for (const p of this.chain.slice(0, Math.max(position - 1, 0))) {
      const state = present(this.history.get(p.name), 'this.history.get(p.name)').state;
      if (state !== APPLIED && state !== DONE) throw new DbspecApplyError('chain', p.name, 0, `a plan before the last is ${state}`);
    }
    return position;
  }

  /** When no plan is interrupted and the catalog is the same as the recorded schema, returns the number of recorded plans. */
  async settled(): Promise<number> {
    const position = await this.position();
    let want = '';
    if (position > 0) {
      const p = present(this.chain[position - 1], 'this.chain[position - 1]');
      const row = present(this.history.get(p.name), 'this.history.get(p.name)');
      if (row.state !== APPLIED && row.state !== DONE) {
        throw new DbspecApplyError('interrupted', p.name, row.step, `the plan is ${row.state}; run recover or rollback`);
      }
      want = p.to;
    }
    try {
      await this.verify(want);
    } catch (error) {
      throw new DbspecApplyError('drift', '', 0, messageOf(error));
    }
    return position;
  }

  /** Checks that the introspection of the database is the want schemaHash (an empty string means an empty database) and that there are no unsupported objects. */
  async verify(want: string): Promise<void> {
    const { document, unsupported } = await introspectCatalog(async sql => (await this.s.rows(sql)).map(values => new CatalogRow(sql, values)), this.dialect, 'schema');
    if (unsupported.length > 0) {
      const u = present(unsupported[0], 'unsupported[0]');
      throw new Error(`the database has ${unsupported.length} objects that dbspec cannot express, first ${u.kind} ${u.table} ${u.name}: ${u.reason}`);
    }
    let got = '';
    if (document.tables.length > 0) {
      const { manifest, diagnostics } = dbspecManifest([document]);
      if (manifest === null) throw new Error(`the introspected schema is invalid: ${diagnostics.map(d => `${d.line}:${d.column} ${d.rule} ${d.message}`).join('; ')}`);
      got = manifest.schemaHash;
    }
    if (got !== want) throw new Error(`the database is at ${hashOrEmpty(got)}, not ${hashOrEmpty(want)}`);
  }

  /** chain에서 plan의 앞 plan target을 source로 step을 쓴다. */
  steps(p: DbspecPlan): readonly DbspecPlanStep[] {
    const i = this.chain.indexOf(p);
    const source: DbspecDocument | null = i > 0 ? present(this.chain[i - 1], 'this.chain[i - 1]').schema : null;
    const { steps, diagnostics } = planSteps(source, p, this.dialect);
    if (steps === null) throw new DbspecApplyError('chain', p.name, 0, present(diagnostics[0], 'diagnostics[0]').message);
    return steps;
  }

  /** 중단된 row의 step을 catalog의 효과로 정한다. forward이면 앞으로, 아니면 뒤로 이어 갈 위치다. */
  async resolve(p: DbspecPlan, row: HistoryRow, steps: readonly DbspecPlanStep[], forward: boolean): Promise<number> {
    const k = row.step;
    if (k < 0 || k > steps.length) throw new DbspecApplyError('chain', p.name, 0, `the recorded step ${k} is outside the plan's ${steps.length} steps`);
    const rolling = row.state === ROLLING_BACK;
    const uncertain = rolling ? k - 1 : k;
    if (uncertain < 0 || uncertain >= steps.length) return k;
    const e = present(steps[uncertain], 'steps[uncertain]').effect;
    const held = e.kind !== 'repeat' && (await this.effect(p, uncertain, e));
    // 앞으로 갈 때 repeat step은 다시 실행하고, 뒤로 갈 때는 그 rollback을 다시 실행한다.
    const took = held || (!forward && e.kind === 'repeat');
    if (rolling) return took ? k : k - 1;
    return took ? k + 1 : k;
  }

  /** plan의 row를 state와 step으로 쓴다. row가 없으면 만든다. */
  async record(p: DbspecPlan, state: string, step: number): Promise<void> {
    const q = (n: string) => this.q(n);
    if (!this.history.has(p.name)) {
      await this.s.exec(
        `INSERT INTO ${q(HISTORY_TABLE)} (${q('name')}, ${q('from_hash')}, ${q('to_hash')}, ${q('state')}, ${q('step')}, ${q('steps')}, ${q('applied_at')}) VALUES (${this.placeholders(7)})`,
        [p.name, hashOrEmpty(p.from), p.to, state, step, this.steps(p).length, appliedAt(this.now())],
      );
      this.history.set(p.name, { from: hashOrEmpty(p.from), to: p.to, state, step });
      return;
    }
    await this.s.exec(`UPDATE ${q(HISTORY_TABLE)} SET ${q('state')} = ${this.placeholder(1)}, ${q('step')} = ${this.placeholder(2)} WHERE ${q('name')} = ${this.placeholder(3)}`, [
      state,
      step,
      p.name,
    ]);
  }

  async setStep(p: DbspecPlan, step: number): Promise<void> {
    const q = (n: string) => this.q(n);
    await this.s.exec(`UPDATE ${q(HISTORY_TABLE)} SET ${q('step')} = ${this.placeholder(1)} WHERE ${q('name')} = ${this.placeholder(2)}`, [step, p.name]);
  }

  /** plan 하나를 finalize step 앞까지 적용하고 검증한다. */
  async applyPlan(p: DbspecPlan): Promise<void> {
    const steps = this.steps(p);
    await this.emit('plan', p.name, 0, steps.length, '');
    for (const [i, s] of steps.slice(0, finalizeStart(steps)).entries()) {
      if (s.rollback === '') await this.emit('irreversible', p.name, i, steps.length, s.statement);
    }
    await this.record(p, APPLYING, 0);
    await this.forward(p, steps, 0);
  }

  /** step start부터 finalize step 앞까지 실행하고 검증한 뒤 row를 applied로 바꾼다. */
  async forward(p: DbspecPlan, steps: readonly DbspecPlanStep[], start: number): Promise<void> {
    const end = finalizeStart(steps);
    for (let i = start; i < end; i++) {
      const step = present(steps[i], 'steps[i]');
      let statement = step.statement;
      if (step.restore !== '' && (await this.effect(p, i, step.restoreIf))) statement = step.restore;
      await this.run(p, steps, i, statement);
      await this.setStep(p, i + 1);
    }
    await this.foreignKeyCheck(p);
    try {
      await this.verify(p.to);
    } catch (error) {
      throw new DbspecApplyError('verify', p.name, 0, '', error);
    }
    await this.emit('verified', p.name, 0, steps.length, '');
    await this.record(p, APPLIED, end);
    await this.emit('done', p.name, 0, steps.length, '');
  }

  /** finalize step을 start부터 실행하고 row를 done으로 바꾼다. */
  async finalizeFrom(p: DbspecPlan, steps: readonly DbspecPlanStep[], start: number): Promise<void> {
    for (let i = start; i < steps.length; i++) {
      await this.run(p, steps, i, present(steps[i], 'steps[i]').statement);
      await this.setStep(p, i + 1);
    }
    await this.record(p, DONE, steps.length);
    await this.emit('done', p.name, 0, steps.length, '');
  }

  /**
   * lock을 잡기 전에 server session의 id를 기억한다. 그 session이 lock을 이미 잡고 있으면 다른
   * client가 같은 server session을 쓰는 것이므로 session error다.
   */
  async openSession(query: string): Promise<void> {
    const [id, held] = await this.queryRow(query);
    this.serverSession = integer(id, 'server session id');
    if (held === true || held === 1 || held === '1' || held === 1n) {
      throw new DbspecApplyError('session', '', 0, `this server session already holds the ${HISTORY_TABLE} lock, so another client shares it; ${SESSION_REQUIREMENT}`);
    }
  }

  /** current가 lock을 잡은 server session인지 확인한다. 다르면 plan p의 step i 앞에서(p가 null이면 lock에서) session error다. */
  sameSession(p: DbspecPlan | null, i: number, current: unknown): void {
    const id = integer(current, 'server session id');
    if (id === this.serverSession) return;
    throw new DbspecApplyError('session', p?.name ?? '', p === null ? 0 : i, `the connection moved from server session ${this.serverSession} to ${id}; ${SESSION_REQUIREMENT}`);
  }

  /** step i의 statement 하나를 event와 함께 실행한다. statement 앞에서 server session을 확인한다(SQLite는 file 하나의 connection이다). */
  async run(p: DbspecPlan, steps: readonly DbspecPlanStep[], i: number, statement: string): Promise<void> {
    await this.emit('statement', p.name, i, steps.length, statement);
    if (this.dialect !== 'sqlite') {
      const query = this.dialect === 'mysql' ? 'SELECT CONNECTION_ID()' : 'SELECT pg_backend_pid()';
      let current: unknown;
      try {
        current = await this.queryValue(query);
      } catch (error) {
        throw new DbspecApplyError('failed', p.name, i, query, error);
      }
      this.sameSession(p, i, current);
    }
    try {
      await this.s.exec(statement);
    } catch (error) {
      throw new DbspecApplyError('failed', p.name, i, statement, error);
    }
    await this.emit('applied', p.name, i, steps.length, statement);
  }

  /** SQLite에서 foreign key를 어기는 row가 없는지 확인한다. */
  async foreignKeyCheck(p: DbspecPlan): Promise<void> {
    if (this.dialect !== 'sqlite') return;
    const broken = integer(await this.queryValue('SELECT COUNT(*) FROM pragma_foreign_key_check'), 'foreign_key_check count');
    if (broken > 0) throw new DbspecApplyError('verify', p.name, 0, `${broken} rows break a foreign key`);
  }

  /** 적용한 plan의 rollback이 non-null로 되돌릴 column의 NULL row를 default로 채우거나, default가 없으면 nulls error로 멈춘다. */
  async nullChecks(p: DbspecPlan, steps: readonly DbspecPlanStep[]): Promise<void> {
    const q = (n: string) => this.q(n);
    for (const [i, s] of steps.entries()) {
      for (const c of s.nullChecks) {
        const n = integer(await this.queryValue(`SELECT COUNT(*) FROM ${q(c.table)} WHERE ${q(c.column)} IS NULL`), 'NULL row count');
        if (n === 0) continue;
        if (c.default === null) {
          throw new DbspecApplyError('nulls', p.name, i, `column ${c.table}.${c.column} has ${n} NULL rows and no default to restore NOT NULL`);
        }
        await this.s.exec(`UPDATE ${q(c.table)} SET ${q(c.column)} = ${c.default} WHERE ${q(c.column)} IS NULL`);
      }
    }
  }

  irreversible(p: DbspecPlan, steps: readonly DbspecPlanStep[], i: number): DbspecApplyError {
    return new DbspecApplyError('irreversible', p.name, i, present(steps[i], 'steps[i]').finalize ? 'a finalize step has no rollback' : present(steps[i], 'steps[i]').irreversible);
  }

  async emit(kind: DbspecApplyEventKind, plan: string, step: number, steps: number, statement: string): Promise<void> {
    if (this.events === null) return;
    await this.events(Object.freeze({ kind, plan, step, steps, statement }));
  }

  placeholder(n: number): string {
    return this.dialect === 'postgres' ? `$${n}` : '?';
  }

  placeholders(n: number): string {
    return Array.from({ length: n }, (_, i) => this.placeholder(i + 1)).join(', ');
  }

  /** 효과가 지금 database에 있는지 알려 준다. 읽지 못하면 step의 failed error다. */
  async effect(p: DbspecPlan, step: number, e: DbspecEffect | null): Promise<boolean> {
    if (e === null) throw new Error(`step ${step} has no effect to read`);
    try {
      return await this.effectHolds(e);
    } catch (error) {
      throw new DbspecApplyError('failed', p.name, step, '', error);
    }
  }

  async effectHolds(e: DbspecEffect): Promise<boolean> {
    let query: string;
    let args: string[] = [];
    if (e.kind === 'rows') {
      query = `SELECT COUNT(*) FROM (SELECT 1 FROM ${this.q(e.table)} LIMIT 1) x`;
    } else {
      const found = EFFECT_QUERIES[this.dialect][e.kind];
      if (found === undefined) throw new Error(`the effect ${effectText(e)} has no query on ${this.dialect}`);
      query = found;
      args = e.kind === 'table' || e.kind === 'sequence' ? [e.table] : e.kind === 'function' ? [e.name] : [e.table, e.name];
    }
    return integer(await this.queryValue(query, args), 'effect count') > 0 === e.present;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * applied_at은 tool clock의 UTC 시각을 소수 여섯 자리로 자른 YYYY-MM-DDTHH:MM:SS.ffffffZ다.
 * micros는 epoch 이후 microsecond(wallMicros와 같은 단위)다.
 */
function appliedAt(micros: number): string {
  if (!Number.isSafeInteger(micros)) throw new TypeError('now must return the microseconds since the epoch as a safe integer');
  const fraction = ((micros % 1_000_000) + 1_000_000) % 1_000_000;
  const date = new Date((micros - fraction) / 1000);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must return a time that Date can hold');
  return `${date.toISOString().slice(0, 19)}.${String(fraction).padStart(6, '0')}Z`;
}

function newApplier(connection: unknown, dialect: DbspecDialect, plans: readonly DbspecPlan[], now: () => number, events: DbspecApplyHandler | null | undefined): Applier {
  if (dialect !== 'mysql' && dialect !== 'postgres' && dialect !== 'sqlite') throw new TypeError(`unknown dbspec dialect ${String(dialect)}`);
  if (typeof now !== 'function') throw new TypeError('now must be a function that returns the microseconds since the epoch');
  if (events !== undefined && events !== null && typeof events !== 'function') throw new TypeError('events must be a function or null');
  const { plans: chain, diagnostics } = chainPlans(plans);
  if (chain === null) throw new DbspecApplyError('chain', '', 0, present(diagnostics[0], 'diagnostics[0]').message);
  return new Applier(connection, dialect, chain, now, events ?? null);
}

/**
 * Reads whether an effect holds on the connection now; the cleanup test
 * reads an effect query through it.
 *
 * @internal
 */
export async function dbspecEffectHolds(connection: unknown, dialect: DbspecDialect, effect: DbspecEffect): Promise<boolean> {
  return new Applier(connection, dialect, [], () => 0, null).effectHolds(effect);
}

type Connection = DbspecApplyMySqlConnection | DbspecApplyPostgresConnection | DbspecApplySqliteConnection;

/**
 * Applies, step by step and in chain order, the plans that the database has
 * not applied, up to their finalize steps, on one connection under the
 * dialect's lock (docs/plans.md "Apply"). A database that has applied the
 * whole chain is left unchanged. `now` gives the microseconds since the
 * epoch recorded in `applied_at` (as wallMicros returns them); `events`
 * receives each event. A failure rejects unchanged with a DbspecApplyError,
 * the handler's error or the driver's error; an advisory unlock that
 * released nothing and a query without a row are errors. When restoring the
 * session settings or SQLite foreign keys, or releasing the lock, fails
 * after it, the command rejects with an AggregateError whose `errors` are the
 * failure and then the cleanup errors in order.
 */
export function applyPlans(connection: DbspecApplyMySqlConnection, dialect: 'mysql', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export function applyPlans(connection: DbspecApplyPostgresConnection, dialect: 'postgres', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export function applyPlans(connection: DbspecApplySqliteConnection, dialect: 'sqlite', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export async function applyPlans(connection: Connection, dialect: DbspecDialect, plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void> {
  const a = newApplier(connection, dialect, plans, now, events);
  await a.session(async () => {
    const position = await a.settled();
    for (const p of a.chain.slice(position)) await a.applyPlan(p);
  });
}

/**
 * Continues the interrupted plan forward from the catalog effect of the step
 * after its recorded one, up to applied, or to done for a finalizing plan
 * (docs/plans.md "Apply"). Without an interrupted plan nothing changes.
 * Failures are reported as for applyPlans.
 */
export function recoverPlans(connection: DbspecApplyMySqlConnection, dialect: 'mysql', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export function recoverPlans(connection: DbspecApplyPostgresConnection, dialect: 'postgres', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export function recoverPlans(connection: DbspecApplySqliteConnection, dialect: 'sqlite', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export async function recoverPlans(connection: Connection, dialect: DbspecDialect, plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void> {
  const a = newApplier(connection, dialect, plans, now, events);
  await a.session(async () => {
    const position = await a.position();
    if (position === 0) return;
    const p = present(a.chain[position - 1], 'a.chain[position - 1]');
    const row = present(a.history.get(p.name), 'a.history.get(p.name)');
    if (row.state === APPLIED || row.state === DONE) return;
    const steps = a.steps(p);
    const k = await a.resolve(p, row, steps, true);
    if (row.state === FINALIZING) {
      await a.emit('finalize', p.name, 0, steps.length, '');
      await a.finalizeFrom(p, steps, k);
      return;
    }
    await a.emit('plan', p.name, 0, steps.length, '');
    await a.record(p, APPLYING, k);
    await a.forward(p, steps, k);
  });
}

/**
 * Undoes the last plan of the history with its rollback statements down to
 * its first step and deletes its row (docs/plans.md "Apply"). An applied
 * plan is checked for drift and NULL rows first; a step without rollback
 * stops it with an irreversible DbspecApplyError. Without a row nothing
 * changes. Failures are reported as for applyPlans.
 */
export function rollbackPlans(connection: DbspecApplyMySqlConnection, dialect: 'mysql', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export function rollbackPlans(connection: DbspecApplyPostgresConnection, dialect: 'postgres', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export function rollbackPlans(connection: DbspecApplySqliteConnection, dialect: 'sqlite', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export async function rollbackPlans(connection: Connection, dialect: DbspecDialect, plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void> {
  const a = newApplier(connection, dialect, plans, now, events);
  await a.session(async () => {
    const position = await a.position();
    if (position === 0) return;
    const p = present(a.chain[position - 1], 'a.chain[position - 1]');
    const row = present(a.history.get(p.name), 'a.history.get(p.name)');
    const steps = a.steps(p);
    let k = row.step;
    const applied = row.state === APPLIED || row.state === DONE;
    if (applied) {
      if (k < 0 || k > steps.length) throw new DbspecApplyError('chain', p.name, 0, `the recorded step ${k} is outside the plan's ${steps.length} steps`);
      try {
        await a.verify(p.to);
      } catch (error) {
        throw new DbspecApplyError('drift', p.name, 0, messageOf(error));
      }
    } else {
      k = await a.resolve(p, row, steps, false);
    }
    if (k > 0 && present(steps[k - 1], 'steps[k - 1]').rollback === '') throw a.irreversible(p, steps, k - 1);
    if (applied) await a.nullChecks(p, steps.slice(0, k));
    await a.emit('rollback', p.name, 0, steps.length, '');
    await a.record(p, ROLLING_BACK, k);
    for (let i = k - 1; i >= 0; i--) {
      const step = present(steps[i], 'steps[i]');
      if (step.rollback === '') throw a.irreversible(p, steps, i);
      let statement = step.rollback;
      if (step.rollbackRestore !== '' && (await a.effect(p, i, step.restoreIf))) statement = step.rollbackRestore;
      await a.run(p, steps, i, statement);
      await a.setStep(p, i);
    }
    await a.foreignKeyCheck(p);
    try {
      await a.verify(p.from ?? '');
    } catch (error) {
      throw new DbspecApplyError('verify', p.name, 0, '', error);
    }
    await a.emit('verified', p.name, 0, steps.length, '');
    await a.s.exec(`DELETE FROM ${a.q(HISTORY_TABLE)} WHERE ${a.q('name')} = ${a.placeholder(1)}`, [p.name]);
    await a.emit('done', p.name, 0, steps.length, '');
  });
}

/**
 * Runs the finalize steps of every applied plan in chain order, dropping the
 * hidden tables and columns, and records the plans done (docs/plans.md
 * "Apply"). Failures are reported as for applyPlans.
 */
export function finalizePlans(connection: DbspecApplyMySqlConnection, dialect: 'mysql', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export function finalizePlans(connection: DbspecApplyPostgresConnection, dialect: 'postgres', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export function finalizePlans(connection: DbspecApplySqliteConnection, dialect: 'sqlite', plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void>;
export async function finalizePlans(connection: Connection, dialect: DbspecDialect, plans: readonly DbspecPlan[], now: () => number, events?: DbspecApplyHandler | null): Promise<void> {
  const a = newApplier(connection, dialect, plans, now, events);
  await a.session(async () => {
    const position = await a.settled();
    for (const p of a.chain.slice(0, position)) {
      if (present(a.history.get(p.name), 'a.history.get(p.name)').state !== APPLIED) continue;
      const steps = a.steps(p);
      await a.emit('finalize', p.name, 0, steps.length, '');
      const start = finalizeStart(steps);
      await a.record(p, FINALIZING, start);
      await a.finalizeFrom(p, steps, start);
    }
  });
}
