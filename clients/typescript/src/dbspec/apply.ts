// plan chain을 database 하나에 적용하고 중단된 MySQL plan을 복구한다
// (docs/plans.md "Apply"). 기준은 Go 엔진(engine/dbspec/apply.go)이며 lock,
// history table, statement, 검증과 MySQL recovery의 효과 표가 Go와 같다.
import type { DatabaseSync } from 'node:sqlite';
import mysql, { type Connection as MySqlConnection } from 'mysql2/promise';
import pg from 'pg';
import { dbspecManifest } from './index.js';
import { introspectDbspec } from './introspect.js';
import type { DbspecDocument } from './model.js';
import { chainPlans, type DbspecPlan } from './plan.js';
import { planStatements } from './plan_statements.js';
import { Renderer, type DbspecDialect } from './render.js';

/** A mysql2 promise connection or pool connection; apply runs its lock and statements on it. */
export type DbspecApplyMySqlConnection = MySqlConnection;
/** A pg client or pool client; apply runs its lock and transactions on it. */
export type DbspecApplyPostgresConnection = pg.ClientBase;
/** A node:sqlite database. */
export type DbspecApplySqliteConnection = DatabaseSync;

/** What apply reports (docs/plans.md "Apply"). */
export type DbspecApplyEventKind = 'plan' | 'statement' | 'applied' | 'verified' | 'done';

/**
 * An occurrence of apply: `plan` when a plan starts, `statement` before and
 * `applied` after each statement (with its index and text), `verified` and
 * `done`. `step` is 0 and `statement` is '' for the events of a whole plan.
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

/** The kind of an apply or recover failure. */
export type DbspecApplyErrorCode = 'locked' | 'interrupted' | 'drift' | 'chain' | 'failed' | 'verify';

/**
 * A failure of apply or recover. `plan` is '' when no plan is concerned,
 * `step` is the statement index of `failed` and `interrupted`, `detail` the
 * explanation and `cause` the database or verification error.
 */
export class DbspecApplyError extends Error {
  readonly code: DbspecApplyErrorCode;
  readonly plan: string;
  readonly step: number;
  readonly detail: string;

  constructor(code: DbspecApplyErrorCode, plan: string, step: number, detail: string, cause?: unknown) {
    let message: string = code;
    if (plan !== '') message += ` ${plan}`;
    if (code === 'failed' || code === 'interrupted') message += ` at step ${step}`;
    if (detail !== '') message += `: ${detail}`;
    if (cause !== undefined) message += `: ${cause instanceof Error ? cause.message : String(cause)}`;
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DbspecApplyError';
    this.code = code;
    this.plan = plan;
    this.step = step;
    this.detail = detail;
  }
}

// history table은 적용한 plan을 기록한다. dbspec 이름에는 $가 없으므로
// 사용자 table과 겹치지 않고, introspection은 이 table을 빼고 읽는다.
const HISTORY_TABLE = 'dbspec$plans';

// mysql2/promise는 PromisePool class를 내보내지만 type 선언에는 없다.
const MYSQL_POOL = (mysql as unknown as { PromisePool: abstract new (...args: never[]) => unknown }).PromisePool;
if (typeof MYSQL_POOL !== 'function') throw new Error('mysql2/promise does not export PromisePool');

/** dialect connection 하나의 statement 실행과 row 읽기다. row는 값 배열이다. */
interface Session {
  exec(sql: string, args?: readonly (string | number)[]): Promise<void>;
  rows(sql: string, args?: readonly (string | number)[]): Promise<unknown[][]>;
}

function requireMethod(connection: unknown, method: string, dialect: DbspecDialect): void {
  if (connection === null || typeof connection !== 'object' || typeof (connection as Record<string, unknown>)[method] !== 'function') {
    throw new TypeError(`a ${dialect} connection must have a ${method} method`);
  }
}

function session(connection: unknown, dialect: DbspecDialect): Session {
  switch (dialect) {
    case 'mysql': {
      requireMethod(connection, 'query', dialect);
      // pool은 statement마다 다른 connection을 쓰므로 lock과 기록이 맞지 않는다.
      if (connection instanceof MYSQL_POOL) throw new TypeError('apply needs one mysql connection, not a pool');
      const c = connection as MySqlConnection;
      return {
        exec: async (sql, args = []) => {
          await c.query(sql, [...args]);
        },
        rows: async (sql, args = []) => (await c.query({ sql, rowsAsArray: true }, [...args]))[0] as unknown[][],
      };
    }
    case 'postgres': {
      requireMethod(connection, 'query', dialect);
      if (connection instanceof pg.Pool) throw new TypeError('apply needs one postgres client, not a pool');
      const c = connection as pg.ClientBase;
      return {
        exec: async (sql, args = []) => {
          await c.query(sql, [...args]);
        },
        rows: async (sql, args = []) => (await c.query({ text: sql, values: [...args], rowMode: 'array' })).rows as unknown[][],
      };
    }
    case 'sqlite': {
      requireMethod(connection, 'prepare', dialect);
      const c = connection as DatabaseSync;
      return {
        exec: async (sql, args = []) => {
          if (args.length === 0) c.exec(sql);
          else c.prepare(sql).run(...args);
        },
        rows: async (sql, args = []) => {
          const statement = c.prepare(sql);
          statement.setReturnArrays(true);
          return statement.all(...args) as unknown as unknown[][];
        },
      };
    }
  }
  throw new TypeError(`unknown dbspec dialect ${String(dialect)}`);
}

/** integer column이나 COUNT의 값이다. 정수가 아닌 값은 error다. */
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

/** 빈 database의 hash는 history에 empty로 쓴다. */
function hashOrEmpty(hash: string | null): string {
  return hash === null || hash === '' ? 'empty' : hash;
}

interface HistoryRow {
  from: string;
  to: string;
  state: string;
  step: number;
}

/** apply 한 번의 상태다. */
class Applier {
  readonly s: Session;
  readonly r: Renderer;
  history = new Map<string, HistoryRow>();

  constructor(
    readonly connection: unknown,
    readonly dialect: DbspecDialect,
    readonly chain: readonly DbspecPlan[],
    readonly now: () => Date,
    readonly events: DbspecApplyHandler | null,
  ) {
    this.s = session(connection, dialect);
    this.r = new Renderer(dialect);
  }

  q(name: string): string {
    return this.r.q(name);
  }

  async queryValue(sql: string): Promise<unknown> {
    const rows = await this.s.rows(sql);
    if (rows.length === 0) throw new Error(`${sql} returned no row`);
    return rows[0]![0];
  }

  /** dialect의 lock을 잡고 f를 실행한다. SQLite는 apply 전체를 한 transaction으로 실행하며 그 transaction이 lock이다. */
  async locked(f: () => Promise<void>): Promise<void> {
    switch (this.dialect) {
      case 'mysql': {
        const got = await this.queryValue(`SELECT GET_LOCK('${HISTORY_TABLE}', 0)`);
        if (got === null || integer(got, 'GET_LOCK') !== 1) {
          throw new DbspecApplyError('locked', '', 0, `another session holds GET_LOCK('${HISTORY_TABLE}')`);
        }
        await this.release(f, () => this.s.exec(`DO RELEASE_LOCK('${HISTORY_TABLE}')`));
        return;
      }
      case 'postgres': {
        const got = await this.queryValue(`SELECT pg_try_advisory_lock(hashtext('${HISTORY_TABLE}'))`);
        if (got !== true) {
          if (got !== false) throw new Error(`pg_try_advisory_lock returned ${String(got)}`);
          throw new DbspecApplyError('locked', '', 0, `another session holds the advisory lock of ${HISTORY_TABLE}`);
        }
        await this.release(f, async () => {
          const released = await this.queryValue(`SELECT pg_advisory_unlock(hashtext('${HISTORY_TABLE}'))`);
          if (released !== true) {
            if (released !== false) throw new Error(`pg_advisory_unlock returned ${String(released)}`);
            throw new Error(`the advisory lock of ${HISTORY_TABLE} was not held at unlock`);
          }
        });
        return;
      }
    }
    await this.s.exec('PRAGMA foreign_keys = OFF');
    try {
      await this.s.exec('BEGIN IMMEDIATE');
    } catch (error) {
      const locked = new DbspecApplyError('locked', '', 0, 'another connection holds the SQLite write lock', error);
      // release는 locked를 던진다. foreign key 복구가 실패하면 함께 던진다.
      await this.release(async () => {}, () => this.s.exec('PRAGMA foreign_keys = ON'), locked);
      return;
    }
    let failure: unknown = null;
    try {
      await f();
    } catch (error) {
      failure = error;
    }
    await this.release(
      () => this.s.exec(failure === null ? 'COMMIT' : 'ROLLBACK'),
      () => this.s.exec('PRAGMA foreign_keys = ON'),
      failure,
    );
  }

  /**
   * before(앞서 난 error, 없으면 null) 뒤에 f와 unlock을 차례로 실행한다. unlock은
   * f가 실패해도 실행한다. error가 하나면 그 error를, 둘 이상이면 처음 error를
   * message로 한 AggregateError를 던진다.
   */
  async release(f: () => Promise<void>, unlock: () => Promise<void>, before: unknown = null): Promise<void> {
    const failures: unknown[] = before === null ? [] : [before];
    for (const step of [f, unlock]) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, messageOf(failures[0]));
  }

  /** history table을 없을 때 만든다. */
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

  /**
   * chain에서 다음에 적용할 plan의 위치를 돌려준다. 기록이 chain과 맞지 않거나,
   * 중단된 plan이 있거나, catalog가 기록한 schema와 다르면 error다.
   */
  async state(): Promise<number> {
    await this.readHistory();
    let position = 0;
    for (const [i, p] of this.chain.entries()) {
      const row = this.history.get(p.name);
      if (row === undefined) continue;
      if (row.state === 'running') throw new DbspecApplyError('interrupted', p.name, row.step, 'run recover');
      if (row.to !== p.to || row.from !== hashOrEmpty(p.from)) {
        throw new DbspecApplyError('chain', p.name, 0, "the recorded plan has other hashes than the chain's plan");
      }
      if (i !== position) throw new DbspecApplyError('chain', p.name, 0, 'a plan before it in the chain is not recorded');
      position = i + 1;
    }
    if (this.history.size !== position) throw new DbspecApplyError('chain', '', 0, 'the history records a plan that is not in the chain');
    const want = position > 0 ? this.chain[position - 1]!.to : '';
    try {
      await this.verify(want);
    } catch (error) {
      throw new DbspecApplyError('drift', '', 0, messageOf(error));
    }
    return position;
  }

  /** database의 introspection이 want schemaHash(빈 문자열이면 빈 database)이고 미지원 객체가 없는지 확인한다. */
  async verify(want: string): Promise<void> {
    const { document, unsupported } = await introspectDbspec(this.connection as never, this.dialect as never, 'schema');
    if (unsupported.length > 0) {
      const u = unsupported[0]!;
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

  /** chain에서 plan의 앞 plan target을 source로 statement를 쓴다. */
  statements(p: DbspecPlan): readonly string[] {
    const i = this.chain.indexOf(p);
    const source: DbspecDocument | null = i > 0 ? this.chain[i - 1]!.schema : null;
    const { statements, diagnostics } = planStatements(source, p, this.dialect);
    if (statements === null) throw new DbspecApplyError('chain', p.name, 0, diagnostics[0]!.message);
    return statements;
  }

  /** plan 하나를 start 번째 statement부터 적용하고 검증한다. resume이면 기록된 running row를 이어 쓴다. */
  async applyPlan(p: DbspecPlan, start: number, resume: boolean): Promise<void> {
    const statements = this.statements(p);
    await this.emit('plan', p.name, 0, statements.length, '');
    if (this.dialect === 'postgres') {
      await this.s.exec('BEGIN');
      let failure: unknown = null;
      try {
        await this.runPlan(p, statements, start, resume);
      } catch (error) {
        failure = error;
      }
      await this.release(() => this.s.exec(failure === null ? 'COMMIT' : 'ROLLBACK'), async () => {}, failure);
    } else {
      await this.runPlan(p, statements, start, resume);
    }
    await this.emit('done', p.name, 0, statements.length, '');
  }

  async runPlan(p: DbspecPlan, statements: readonly string[], start: number, resume: boolean): Promise<void> {
    const q = (n: string) => this.q(n);
    if (!resume) {
      await this.s.exec(
        `INSERT INTO ${q(HISTORY_TABLE)} (${q('name')}, ${q('from_hash')}, ${q('to_hash')}, ${q('state')}, ${q('step')}, ${q('steps')}, ${q('applied_at')}) VALUES (${this.placeholders(7)})`,
        [p.name, hashOrEmpty(p.from), p.to, 'running', 0, statements.length, appliedAt(this.now())],
      );
    }
    const step = (n: number) =>
      this.s.exec(`UPDATE ${q(HISTORY_TABLE)} SET ${q('step')} = ${this.placeholder(1)} WHERE ${q('name')} = ${this.placeholder(2)}`, [n, p.name]);
    if (resume) await step(start);
    for (let i = start; i < statements.length; i++) {
      const statement = statements[i]!;
      await this.emit('statement', p.name, i, statements.length, statement);
      try {
        await this.s.exec(statement);
      } catch (error) {
        throw new DbspecApplyError('failed', p.name, i, statement, error);
      }
      await this.emit('applied', p.name, i, statements.length, statement);
      await step(i + 1);
    }
    if (this.dialect === 'sqlite') {
      const broken = integer(await this.queryValue('SELECT COUNT(*) FROM pragma_foreign_key_check'), 'foreign_key_check count');
      if (broken > 0) throw new DbspecApplyError('verify', p.name, 0, `${broken} rows break a foreign key`);
    }
    try {
      await this.verify(p.to);
    } catch (error) {
      throw new DbspecApplyError('verify', p.name, 0, '', error);
    }
    await this.emit('verified', p.name, 0, statements.length, '');
    await this.s.exec(`UPDATE ${q(HISTORY_TABLE)} SET ${q('state')} = 'done' WHERE ${q('name')} = ${this.placeholder(1)}`, [p.name]);
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

  /** statement의 효과가 catalog에 있는지 알려 준다. */
  async mysqlEffect(statement: string): Promise<boolean> {
    for (const e of MYSQL_EFFECTS) {
      const m = e.pattern.exec(statement);
      if (m === null) continue;
      let query: string;
      let args: string[];
      switch (e.kind) {
        case 'repeat':
          return false;
        case 'trigger':
          query = 'SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?';
          args = [m[1]!];
          break;
        case 'table':
          query = 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?';
          args = [m[1]!];
          break;
        case 'column':
          query = 'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?';
          args = [m[1]!, m[2]!];
          break;
        case 'constraint':
          query = 'SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?';
          args = [m[1]!, m[2]!];
          break;
        case 'index':
          query = 'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?';
          args = [m[1]!, m[2]!];
          break;
        case 'index_on':
          query = 'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?';
          args = [m[2]!, m[1]!];
          break;
      }
      const rows = await this.s.rows(query, args);
      if (rows.length !== 1) throw new Error(`${query} returned ${rows.length} rows`);
      return integer(rows[0]![0], 'effect count') > 0 === e.present;
    }
    throw new Error(`statement ${JSON.stringify(statement)} has no known effect`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** applied_at은 UTC의 YYYY-MM-DDTHH:MM:SSZ다. */
function appliedAt(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('now must return a valid Date');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

type EffectKind = 'trigger' | 'constraint' | 'index' | 'index_on' | 'table' | 'column' | 'repeat';

// MYSQL_EFFECTS는 plan writer가 쓰는 MySQL statement 형식과 그 효과다
// (docs/plans.md "Apply", recovery). 효과가 없는 MODIFY COLUMN은 다시 실행한다.
const MYSQL_EFFECTS: readonly { pattern: RegExp; kind: EffectKind; present: boolean }[] = [
  { pattern: /^DROP TRIGGER `([^`]+)`$/, kind: 'trigger', present: false },
  { pattern: /^ALTER TABLE `([^`]+)` DROP FOREIGN KEY `([^`]+)`$/, kind: 'constraint', present: false },
  { pattern: /^ALTER TABLE `([^`]+)` DROP CHECK `([^`]+)`$/, kind: 'constraint', present: false },
  { pattern: /^ALTER TABLE `([^`]+)` DROP INDEX `([^`]+)`$/, kind: 'index', present: false },
  { pattern: /^DROP INDEX `([^`]+)` ON `([^`]+)`$/, kind: 'index_on', present: false },
  { pattern: /^ALTER TABLE `[^`]+` RENAME TO `([^`]+)`$/, kind: 'table', present: true },
  { pattern: /^ALTER TABLE `([^`]+)` RENAME COLUMN `[^`]+` TO `([^`]+)`$/, kind: 'column', present: true },
  { pattern: /^ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`$/, kind: 'column', present: false },
  { pattern: /^DROP TABLE `([^`]+)`$/, kind: 'table', present: false },
  { pattern: /^CREATE TABLE `([^`]+)` /, kind: 'table', present: true },
  { pattern: /^CREATE INDEX `([^`]+)` ON `([^`]+)` /, kind: 'index_on', present: true },
  { pattern: /^ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)` /, kind: 'column', present: true },
  { pattern: /^ALTER TABLE `[^`]+` MODIFY COLUMN /, kind: 'repeat', present: false },
  { pattern: /^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` UNIQUE /, kind: 'index', present: true },
  { pattern: /^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` (CHECK|FOREIGN KEY) /, kind: 'constraint', present: true },
  { pattern: /^CREATE TRIGGER `([^`]+)` /, kind: 'trigger', present: true },
];

function newApplier(connection: unknown, dialect: DbspecDialect, plans: readonly DbspecPlan[], now: () => Date, events: DbspecApplyHandler | null | undefined): Applier {
  if (dialect !== 'mysql' && dialect !== 'postgres' && dialect !== 'sqlite') throw new TypeError(`unknown dbspec dialect ${String(dialect)}`);
  if (typeof now !== 'function') throw new TypeError('now must be a function that returns the current Date');
  if (events !== undefined && events !== null && typeof events !== 'function') throw new TypeError('events must be a function or null');
  const { plans: chain, diagnostics } = chainPlans(plans);
  if (chain === null) throw new DbspecApplyError('chain', '', 0, diagnostics[0]!.message);
  return new Applier(connection, dialect, chain, now, events ?? null);
}

/**
 * Applies, in chain order, the plans that the database has not applied, on
 * one connection under the dialect's lock (docs/plans.md "Apply"). A
 * database that has applied the whole chain is left unchanged. `now` gives
 * the time recorded in `applied_at`; `events` receives each event. A
 * failure rejects unchanged with a DbspecApplyError, the handler's error or
 * the driver's error; an advisory unlock that released nothing and a catalog
 * query without a row are errors. When releasing the lock, ending the
 * transaction or restoring SQLite foreign keys fails after it, apply rejects
 * with an AggregateError whose `errors` are the failure and then the cleanup
 * errors in order.
 */
export function applyPlans(connection: DbspecApplyMySqlConnection, dialect: 'mysql', plans: readonly DbspecPlan[], now: () => Date, events?: DbspecApplyHandler | null): Promise<void>;
export function applyPlans(connection: DbspecApplyPostgresConnection, dialect: 'postgres', plans: readonly DbspecPlan[], now: () => Date, events?: DbspecApplyHandler | null): Promise<void>;
export function applyPlans(connection: DbspecApplySqliteConnection, dialect: 'sqlite', plans: readonly DbspecPlan[], now: () => Date, events?: DbspecApplyHandler | null): Promise<void>;
export async function applyPlans(
  connection: DbspecApplyMySqlConnection | DbspecApplyPostgresConnection | DbspecApplySqliteConnection,
  dialect: DbspecDialect,
  plans: readonly DbspecPlan[],
  now: () => Date,
  events?: DbspecApplyHandler | null,
): Promise<void> {
  const a = newApplier(connection, dialect, plans, now, events);
  await a.locked(async () => {
    const position = await a.state();
    for (const p of a.chain.slice(position)) await a.applyPlan(p, 0, false);
  });
}

/**
 * Finishes an interrupted MySQL plan from the catalog effect of its
 * interrupted statement, then verifies it and marks it done (docs/plans.md
 * "Apply", recovery). Without a running plan nothing changes. Failures
 * are reported as for applyPlans.
 */
export function recoverPlans(connection: DbspecApplyMySqlConnection, dialect: 'mysql', plans: readonly DbspecPlan[], now: () => Date, events?: DbspecApplyHandler | null): Promise<void>;
export function recoverPlans(connection: DbspecApplyPostgresConnection, dialect: 'postgres', plans: readonly DbspecPlan[], now: () => Date, events?: DbspecApplyHandler | null): Promise<void>;
export function recoverPlans(connection: DbspecApplySqliteConnection, dialect: 'sqlite', plans: readonly DbspecPlan[], now: () => Date, events?: DbspecApplyHandler | null): Promise<void>;
export async function recoverPlans(
  connection: DbspecApplyMySqlConnection | DbspecApplyPostgresConnection | DbspecApplySqliteConnection,
  dialect: DbspecDialect,
  plans: readonly DbspecPlan[],
  now: () => Date,
  events?: DbspecApplyHandler | null,
): Promise<void> {
  const a = newApplier(connection, dialect, plans, now, events);
  await a.locked(async () => {
    await a.readHistory();
    for (const p of a.chain) {
      const row = a.history.get(p.name);
      if (row === undefined || row.state !== 'running') continue;
      if (dialect !== 'mysql') {
        throw new DbspecApplyError('interrupted', p.name, row.step, 'only MySQL leaves a running plan; the row is not from apply');
      }
      const statements = a.statements(p);
      let start = row.step;
      if (start < statements.length) {
        let done: boolean;
        try {
          done = await a.mysqlEffect(statements[start]!);
        } catch (error) {
          throw new DbspecApplyError('failed', p.name, start, '', error);
        }
        if (done) start++;
      }
      await a.applyPlan(p, start, true);
      return;
    }
  });
}
