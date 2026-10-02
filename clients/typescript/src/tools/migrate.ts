// `orm-gen migrate`: brings a database to a target schema with a recorded,
// locked, and verified migration (docs/schema.md §4).
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wallMicros } from '../clock.js';
import { ddlErrorText, renderCreateDDL, splitSQL } from '../engine/ddl.js';
import { indentJson, type Manifest } from '../engine/manifest.js';
import { sameTriggers } from '../engine/triggers.js';
import { jsonString, object, optString, quoted } from '../schema/json.js';
import type { SchemaManifest } from '../schema/build.js';
import type { ToolDb, ToolValue } from './db.js';
import { columnStorage, loadedOf, renderDiff, sqliteTypeMatches } from './diff.js';
import { alignLiveChecks } from './checks.js';
import { liveManifest } from './introspect.js';

export interface MigrationRecord {
  migrationId: string;
  name: string;
  fromHash: string;
  toHash: string;
  checksum: string;
  status: string;
  operations: number;
}

export interface MigrationLog extends MigrationRecord {
  driver: string;
  errorDetail: string;
  startedAt: string;
  finishedAt: string;
}

export interface MigrateOptions {
  migrationId: string;
  name: string;
  logDir: string;
  dryRun: boolean;
}

/** A tool failure; the message is printed as it is. */
export class ToolError extends Error {}

export function checksumText(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function placeholder(driver: string, n: number): string {
  return driver === 'postgres' ? `$${n}` : '?';
}

export function message(error: unknown): string {
  return (error as Error).message;
}

/** The SQLite form of a ledger time: UTC text with six fraction digits. */
const SQLITE_TIME_GLOB = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]'";

/**
 * The SQLite definitions of the ledger time columns. SQLite keeps a column
 * definition only in the table statement, so an existing ledger is verified
 * against these texts.
 */
const SQLITE_TIME_COLUMNS: readonly (readonly [string, string])[] = [
  ['started_at', `started_at TEXT NOT NULL CHECK (started_at GLOB ${SQLITE_TIME_GLOB})`],
  ['finished_at', `finished_at TEXT NULL CHECK (finished_at GLOB ${SQLITE_TIME_GLOB})`],
];

/**
 * Creates the migration ledger when it is missing and verifies the time
 * columns of an existing ledger; other time columns fail with
 * MIGRATION_HISTORY_PRECISION and the ledger stays unchanged.
 */
export async function ensureMigrationTable(db: ToolDb): Promise<void> {
  let q: string;
  switch (db.driver) {
    case 'mysql':
      q = 'CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, from_schema_hash varchar(128) NOT NULL, to_schema_hash varchar(128) NOT NULL, plan_checksum varchar(128) NOT NULL, status varchar(32) NOT NULL, operations int NOT NULL, error_detail text NOT NULL, started_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), finished_at timestamp(6) NULL)';
      break;
    case 'postgres':
      q = 'CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz NULL)';
      break;
    default:
      q = `CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, ${SQLITE_TIME_COLUMNS.map(c => c[1]).join(', ')})`;
  }
  try { await db.exec(q); } catch (error) { throw new ToolError(`MIGRATION_HISTORY_CREATE: driver=${db.driver}: ${message(error)}`); }
  await verifyLedgerTimes(db);
}

async function verifyLedgerTimes(db: ToolDb): Promise<void> {
  const driver = db.driver;
  if (driver === 'sqlite') {
    let rows: unknown[][];
    try { rows = await db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='orm_schema_migrations'"); } catch (error) {
      throw new ToolError(`MIGRATION_HISTORY_READ: driver=sqlite definition: ${message(error)}`);
    }
    const statement = String(rows[0]?.[0] ?? '');
    for (const [column, definition] of SQLITE_TIME_COLUMNS) {
      if (!statement.includes(definition)) throw new ToolError(`MIGRATION_HISTORY_PRECISION: driver=sqlite column=${column} required=${quoted(definition)}`);
    }
    return;
  }
  const [q, required] = driver === 'postgres'
    ? ["SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = to_regclass('orm_schema_migrations') AND attname = $1 AND attnum > 0 AND NOT attisdropped", ['timestamp with time zone', 'timestamp(6) with time zone']]
    : ["SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orm_schema_migrations' AND COLUMN_NAME = ?", ['timestamp(6)']];
  for (const column of ['started_at', 'finished_at']) {
    let rows: unknown[][];
    try { rows = await db.query(q, [column]); } catch (error) {
      throw new ToolError(`MIGRATION_HISTORY_READ: driver=${driver} column=${column}: ${message(error)}`);
    }
    const definition = rows.length === 0 ? 'missing' : String(rows[0]![0]);
    if (!required.includes(definition)) {
      throw new ToolError(`MIGRATION_HISTORY_PRECISION: driver=${driver} column=${column} definition=${quoted(definition)} required=${quoted(required[0]!)}`);
    }
  }
}

/**
 * The clock a ledger write assigns and its bound values: the database clock
 * with microseconds on MySQL and PostgreSQL, and on SQLite, which has no clock
 * with microseconds, the tool clock in UTC.
 */
export function ledgerClock(driver: string): [string, ToolValue[]] {
  if (driver === 'mysql') return ['CURRENT_TIMESTAMP(6)', []];
  if (driver === 'postgres') return ['CURRENT_TIMESTAMP', []];
  const micros = wallMicros();
  const text = new Date(Math.floor(micros / 1000)).toISOString().slice(0, 19).replace('T', ' ');
  return ['?', [`${text}.${String(micros % 1_000_000).padStart(6, '0')}`]];
}

export async function migrationById(db: ToolDb, id: string): Promise<MigrationRecord | undefined> {
  const q = `SELECT migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations FROM orm_schema_migrations WHERE migration_id=${placeholder(db.driver, 1)}`;
  let rows: unknown[][];
  try { rows = await db.query(q, [id]); } catch (error) { throw new ToolError(`MIGRATION_HISTORY_READ: migration_id=${id}: ${message(error)}`); }
  const row = rows[0];
  if (!row) return undefined;
  return {
    migrationId: String(row[0]), name: String(row[1]), fromHash: String(row[2]), toHash: String(row[3]),
    checksum: String(row[4]), status: String(row[5]), operations: Number(row[6]),
  };
}

export async function insertMigration(db: ToolDb, r: MigrationRecord): Promise<void> {
  const args: ToolValue[] = [r.migrationId, r.name, r.fromHash, r.toHash, r.checksum, r.status, r.operations];
  const [clock, at] = ledgerClock(db.driver);
  const q = `INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at) VALUES (${args.map((_, i) => placeholder(db.driver, i + 1)).join(',')}, '', ${clock})`;
  try { await db.exec(q, [...args, ...at]); } catch (error) { throw new ToolError(`MIGRATION_HISTORY_WRITE: migration_id=${r.migrationId}: ${message(error)}`); }
}

export async function updateMigration(db: ToolDb, id: string, status: string, detail: string): Promise<void> {
  const d = db.driver;
  const [clock, at] = ledgerClock(d);
  await db.exec(`UPDATE orm_schema_migrations SET status=${placeholder(d, 1)}, error_detail=${placeholder(d, 2)}, finished_at=${clock} WHERE migration_id=${placeholder(d, 3)}`, [status, detail, ...at, id]);
}

export async function transitionMigration(db: ToolDb, id: string, from: string, to: string, detail: string): Promise<void> {
  const d = db.driver;
  const [clock, at] = ledgerClock(d);
  let q = `UPDATE orm_schema_migrations SET status=${placeholder(d, 1)}, error_detail=${placeholder(d, 2)}`;
  q += to === 'applying' ? `, started_at=${clock}, finished_at=NULL` : `, finished_at=${clock}`;
  q += ` WHERE migration_id=${placeholder(d, 3)} AND status=${placeholder(d, 4)}`;
  let rows: number;
  try { rows = await db.exec(q, [to, detail, ...at, id, from]); } catch (error) {
    throw new ToolError(`MIGRATION_HISTORY_WRITE: migration_id=${id} transition=${from}_to_${to}: ${message(error)}`);
  }
  if (rows !== 1) throw new ToolError(`MIGRATION_STATE_CHANGED: migration_id=${id} expected_status=${from} requested_status=${to} affected_rows=${rows}`);
}

export async function markMigrationFailed(db: ToolDb, id: string, detail: string): Promise<void> {
  const d = db.driver;
  const [clock, at] = ledgerClock(d);
  const q = `UPDATE orm_schema_migrations SET status=${placeholder(d, 1)}, error_detail=${placeholder(d, 2)}, finished_at=${clock} WHERE migration_id=${placeholder(d, 3)} AND status IN (${placeholder(d, 4)},${placeholder(d, 5)},${placeholder(d, 6)})`;
  let rows: number;
  try { rows = await db.exec(q, ['failed', detail, ...at, id, 'queued', 'retryable', 'applying']); } catch (error) {
    throw new ToolError(`MIGRATION_HISTORY_WRITE: migration_id=${id} mark_failed: ${message(error)}`);
  }
  if (rows !== 1) throw new ToolError(`MIGRATION_STATE_CHANGED: migration_id=${id} failure status was not written affected_rows=${rows}`);
}

interface RebuildMarker { table: string; target: string; temp: string; }

function sqliteRebuildMarkers(text: string): RebuildMarker[] {
  const markers: RebuildMarker[] = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    const position = line.indexOf('orm-sqlite-rebuild ');
    if (position < 0) continue;
    const values = new Map<string, string>();
    const payload = line.slice(position + 'orm-sqlite-rebuild '.length).replace(/^['"; ]+|['"; ]+$/g, '');
    for (const field of payload.split(/\s+/).filter(Boolean)) {
      const eq = field.indexOf('=');
      if (eq >= 0) values.set(field.slice(0, eq), field.slice(eq + 1).replace(/^['"; ]+|['"; ]+$/g, ''));
    }
    const table = values.get('table') ?? '';
    const target = values.get('target') ?? '';
    const temp = values.get('temp') ?? '';
    if (table !== '' && target !== '' && temp !== '') markers.push({ table, target, temp });
  }
  return markers;
}

function nullInt(value: unknown): string {
  return value === null || value === undefined ? '{0 false}' : `{${String(value)} true}`;
}

async function foreignKeyViolation(db: ToolDb, table: string, stage: string): Promise<void> {
  let rows: unknown[][];
  try { rows = await db.query(`PRAGMA foreign_key_check("${table.replaceAll('"', '""')}")`); } catch (error) {
    throw new ToolError(`SQLITE_REBUILD_${stage}: table=${table} foreign_key_check: ${message(error)}`);
  }
  const row = rows[0];
  if (!row) return;
  const kind = stage === 'PREFLIGHT' ? 'SQLITE_REBUILD_UNSAFE' : 'SQLITE_REBUILD_VERIFY';
  throw new ToolError(`${kind}: table=${String(row[0])} foreign_key_violation rowid=${nullInt(row[1])} parent=${String(row[2])} foreign_key_id=${Number(row[3])}`);
}

// The triggers a migration drops before it rebuilds a table; the rebuild
// creates them again.
function droppedTriggers(text: string): Set<string> {
  const dropped = new Set<string>();
  for (const statement of splitSQL(text)) {
    if (statement.startsWith('DROP TRIGGER IF EXISTS ')) dropped.add(statement.slice('DROP TRIGGER IF EXISTS '.length).replace(/^"+|"+$/g, ''));
  }
  return dropped;
}

async function preflightSQLiteRebuild(db: ToolDb, text: string): Promise<void> {
  const dropped = droppedTriggers(text);
  for (const marker of sqliteRebuildMarkers(text)) {
    let tempCount: number;
    try { tempCount = Number((await db.query('SELECT count(*) FROM sqlite_master WHERE name=?', [marker.temp]))[0]![0]); } catch (error) {
      throw new ToolError(`SQLITE_REBUILD_PREFLIGHT: table=${marker.table} temp=${marker.temp}: ${message(error)}`);
    }
    if (tempCount !== 0) throw new ToolError(`SQLITE_REBUILD_UNSAFE: table=${marker.table} temporary object ${marker.temp} already exists`);
    let dependencies: string[];
    try {
      const rows = await db.query("SELECT type, name FROM sqlite_master WHERE (type='trigger' AND tbl_name=?) OR (type='view' AND lower(coalesce(sql,'')) LIKE ?) ORDER BY type, name", [marker.table, `%${marker.table.toLowerCase()}%`]);
      dependencies = rows.filter(row => !(String(row[0]) === 'trigger' && dropped.has(String(row[1])))).map(row => `${String(row[0])}:${String(row[1])}`);
    } catch (error) {
      throw new ToolError(`SQLITE_REBUILD_PREFLIGHT: table=${marker.table} dependencies: ${message(error)}`);
    }
    if (dependencies.length > 0) {
      throw new ToolError(`SQLITE_REBUILD_UNSAFE: table=${marker.table} dependent_objects=${dependencies.join(',')}; provide reviewed auxiliary migration SQL`);
    }
    await foreignKeyViolation(db, marker.table, 'PREFLIGHT');
  }
}

async function verifySQLiteRebuild(db: ToolDb, text: string): Promise<void> {
  for (const marker of sqliteRebuildMarkers(text)) await foreignKeyViolation(db, marker.target, 'VERIFY');
}

const mysqlLockName = "CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60))";

/** Runs `run` in one transaction under the database migration lock. */
export async function withMigrationLock(db: ToolDb, run: () => Promise<void>): Promise<void> {
  let release = async (): Promise<void> => {};
  switch (db.driver) {
    case 'mysql': {
      let acquired: unknown;
      try { acquired = (await db.query(`SELECT GET_LOCK(${mysqlLockName}, 0)`))[0]![0]; } catch (error) {
        throw new ToolError(`MIGRATION_LOCK: mysql GET_LOCK: ${message(error)}`);
      }
      if (acquired === null || Number(acquired) !== 1) throw new ToolError('MIGRATION_LOCK_BUSY: mysql database migration lock was not acquired');
      release = async () => {
        const released = (await db.query(`SELECT RELEASE_LOCK(${mysqlLockName})`))[0]![0];
        if (released === null || Number(released) !== 1) throw new Error('mysql migration lock was not released');
      };
      try { await db.exec('START TRANSACTION'); } catch (error) {
        await release().catch(() => undefined);
        throw new ToolError(`transaction begin: ${message(error)}`);
      }
      break;
    }
    case 'postgres': {
      try { await db.exec('BEGIN'); } catch (error) { throw new ToolError(`transaction begin: ${message(error)}`); }
      let acquired: unknown;
      try { acquired = (await db.query("SELECT pg_try_advisory_xact_lock(hashtext(current_database()), hashtext('polyspec.orm.migration'))"))[0]![0]; } catch (error) {
        await db.exec('ROLLBACK').catch(() => undefined);
        throw new ToolError(`MIGRATION_LOCK: postgres advisory lock: ${message(error)}`);
      }
      if (acquired !== true) {
        await db.exec('ROLLBACK').catch(() => undefined);
        throw new ToolError('MIGRATION_LOCK_BUSY: postgres database migration lock was not acquired');
      }
      break;
    }
    case 'sqlite':
      try { await db.exec('BEGIN IMMEDIATE'); } catch (error) { throw new ToolError(`MIGRATION_LOCK_BUSY: sqlite BEGIN IMMEDIATE: ${message(error)}`); }
      break;
    default:
      throw new ToolError(`MIGRATION_CONFIG: unsupported driver ${quoted(db.driver)}`);
  }
  const failTx = async (base: string): Promise<never> => {
    let rollbackError = '<nil>';
    let releaseError = '<nil>';
    try { await db.exec('ROLLBACK'); } catch (error) { rollbackError = message(error); }
    try { await release(); } catch (error) { releaseError = message(error); }
    if (rollbackError !== '<nil>' || releaseError !== '<nil>') throw new ToolError(`${base}; rollback_error=${rollbackError}; lock_release_error=${releaseError}`);
    throw new ToolError(`${base}; rollback issued`);
  };
  try { await run(); } catch (error) { return failTx(message(error)); }
  try { await db.exec('COMMIT'); } catch (error) { return failTx(`transaction commit: ${message(error)}`); }
  try { await release(); } catch (error) { throw new ToolError(`MIGRATION_LOCK_RELEASE: ${message(error)}`); }
}

async function runStatements(db: ToolDb, text: string): Promise<void> {
  if (db.driver === 'sqlite') await preflightSQLiteRebuild(db, text);
  const statements = splitSQL(text);
  for (let i = 0; i < statements.length; i++) {
    try { await db.exec(statements[i]!); } catch (error) {
      throw new ToolError(`operation=${i + 1} statement=${quoted(statements[i]!)}: ${message(error)}`);
    }
  }
  if (db.driver === 'sqlite') await verifySQLiteRebuild(db, text);
}

/** Applies SQL under the migration lock. */
export async function executeMigration(db: ToolDb, text: string): Promise<void> {
  await withMigrationLock(db, () => runStatements(db, text));
}

export async function executeClaimedMigration(db: ToolDb, id: string, expectedStatus: string, text: string): Promise<void> {
  await withMigrationLock(db, async () => {
    await transitionMigration(db, id, expectedStatus, 'applying', '');
    await runStatements(db, text);
  });
}

/** Formats a time like RFC 3339 with the shortest fraction. */
function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.(\d*?)0*Z$/, (_, digits: string) => digits === '' ? 'Z' : `.${digits}Z`);
}

function safeMigrationId(id: string): string {
  let out = '';
  for (const ch of id) out += /^[a-zA-Z0-9._-]$/.test(ch) ? ch : '_';
  return out === '' ? 'migration' : out;
}

function logText(log: MigrationLog): string {
  return indentJson(object([
    ['migration_id', jsonString(log.migrationId)],
    ['name', jsonString(log.name)],
    ['driver', jsonString(log.driver)],
    ['from_schema_hash', jsonString(log.fromHash)],
    ['to_schema_hash', jsonString(log.toHash)],
    ['plan_checksum', jsonString(log.checksum)],
    ['status', jsonString(log.status)],
    ['operations', String(log.operations)],
    ['error_detail', optString(log.errorDetail)],
    ['started_at', jsonString(log.startedAt)],
    ['finished_at', optString(log.finishedAt)],
  ]));
}

export function migrationLog(r: MigrationRecord, driver: string, started: Date, finished: Date | undefined, errorDetail = ''): MigrationLog {
  return { ...r, driver, errorDetail, startedAt: rfc3339(started), finishedAt: finished ? rfc3339(finished) : '' };
}

export function writeMigrationLog(dir: string, log: MigrationLog): void {
  if (dir === '') throw new ToolError('MIGRATION_LOG_WRITE: log directory is empty');
  try { mkdirSync(dir, { recursive: true }); } catch (error) { throw new ToolError(`MIGRATION_LOG_WRITE: mkdir ${dir}: ${message(error)}`); }
  const tmp = join(dir, `.migration-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, logText(log) + '\n', { flag: 'wx' });
  } catch (error) {
    throw new ToolError(`MIGRATION_LOG_WRITE: create temporary file: ${message(error)}`);
  }
  try {
    chmodSync(tmp, 0o644);
    renameSync(tmp, join(dir, `${log.startedAt.replaceAll(':', '').replaceAll('-', '')}__${safeMigrationId(log.migrationId)}.json`));
  } catch (error) {
    throw new ToolError(`MIGRATION_LOG_WRITE: migration_id=${log.migrationId}: ${message(error)}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function verifyMigrationLog(dir: string, r: MigrationRecord, driver: string): void {
  const suffix = `__${safeMigrationId(r.migrationId)}.json`;
  let names: string[] = [];
  try { names = readdirSync(dir).filter(name => name.endsWith(suffix)).sort(); } catch { names = []; }
  for (const name of names) {
    const path = join(dir, name);
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch (error) { throw new ToolError(`MIGRATION_LOG_READ: migration_id=${r.migrationId} file=${path}: ${message(error)}`); }
    let l: Record<string, unknown>;
    try { l = JSON.parse(text) as Record<string, unknown>; } catch (error) {
      throw new ToolError(`MIGRATION_LOG_READ: migration_id=${r.migrationId} file=${path} invalid JSON: ${message(error)}`);
    }
    if (l.migration_id === r.migrationId && l.driver === driver && l.from_schema_hash === r.fromHash && l.to_schema_hash === r.toHash
      && l.plan_checksum === r.checksum && l.status === r.status && l.operations === r.operations) return;
  }
  throw new ToolError(`MIGRATION_LOG_CONFLICT: migration_id=${r.migrationId} database record has no matching file log`);
}

/**
 * Whether the live schema has the tables and columns the target expects.
 * Tables and columns are compared by name. Column order is not a schema
 * property: a column added by a migration is appended by the database
 * wherever the declaration places it.
 */
export function schemaMatches(want: SchemaManifest, live: SchemaManifest, driver: string): boolean {
  const wantEntities = want.entities ?? {};
  const liveEntities = live.entities ?? {};
  if (Object.keys(wantEntities).length !== Object.keys(liveEntities).length) return false;
  if (!sameTriggers(want as unknown as Manifest, live as unknown as Manifest)) return false;
  for (const [name, we] of Object.entries(wantEntities)) {
    const le = Object.hasOwn(liveEntities, name) ? liveEntities[name] : undefined;
    const wantColumns = we.columns ?? [];
    const liveColumns = le?.columns ?? [];
    if (!le || we.table !== le.table || (we.comment ?? '') !== (le.comment ?? '') || wantColumns.length !== liveColumns.length) return false;
    for (const wc of wantColumns) {
      const lc = liveColumns.find(c => c.name === wc.name);
      if (!lc) return false;
      const typeMatch = driver === 'sqlite' ? sqliteTypeMatches(wc.type, lc.type) : columnStorage(wc, driver)[0] === columnStorage(lc, driver)[0];
      if ((wc.comment ?? '') !== (lc.comment ?? '') || Boolean(wc.nullable) !== Boolean(lc.nullable) || !typeMatch) return false;
    }
  }
  return true;
}

export async function introspect(db: ToolDb, prefix: string): Promise<SchemaManifest> {
  try { return await liveManifest(db); } catch (error) { throw new ToolError(`${prefix}: ${message(error)}`); }
}

/** Plans and applies the migration to `want`; returns the report line. */
export async function migrate(db: ToolDb, want: SchemaManifest, options: MigrateOptions): Promise<string> {
  const driver = db.driver;
  const id = options.migrationId;
  await ensureMigrationTable(db);
  const live = await introspect(db, `MIGRATION_INTROSPECT: driver=${driver}`);
  try { await alignLiveChecks(db, live, want); } catch (error) { throw new ToolError(`MIGRATION_INTROSPECT: driver=${driver}: ${message(error)}`); }
  const previous = await migrationById(db, id);
  if (previous) {
    switch (previous.status) {
      case 'applied':
        if (previous.toHash !== want.schema_hash) {
          throw new ToolError(`MIGRATION_HISTORY_CONFLICT: migration_id=${id} recorded_to=${previous.toHash} requested_to=${want.schema_hash}`);
        }
        if (!schemaMatches(want, live, driver)) {
          throw new ToolError(`MIGRATION_DRIFT: migration_id=${id} status=applied expected_schema_hash=${want.schema_hash} actual_schema_hash=${live.schema_hash}`);
        }
        verifyMigrationLog(options.logDir, previous, driver);
        return `migration_id=${id} status=noop operations=0 schema_hash=${want.schema_hash}\n`;
      case 'retryable':
        break;
      case 'queued': case 'applying': case 'failed':
        throw new ToolError(`MIGRATION_RECOVERY_REQUIRED: migration_id=${id} status=${previous.status} run ormgen recover with --migration-id and the same target schema`);
      default:
        throw new ToolError(`MIGRATION_STATE_INVALID: migration_id=${id} status=${previous.status}`);
    }
  }
  let sqlText: string;
  try {
    sqlText = Object.keys(live.entities ?? {}).length === 0 ? renderCreateDDL(loadedOf(want), driver) : renderDiff(live, want, driver, false);
  } catch (error) {
    throw new ToolError(`MIGRATION_PLAN: from=${live.schema_hash} to=${want.schema_hash}: ${ddlErrorText(error)}`);
  }
  const operations = splitSQL(sqlText).length;
  const checksum = checksumText(sqlText);
  if (previous && (previous.fromHash !== live.schema_hash || previous.toHash !== want.schema_hash || previous.checksum !== checksum || previous.operations !== operations)) {
    throw new ToolError(`MIGRATION_HISTORY_CONFLICT: migration_id=${id} recorded_from=${previous.fromHash} requested_from=${live.schema_hash} recorded_to=${previous.toHash} requested_to=${want.schema_hash} recorded_plan_checksum=${previous.checksum} requested_plan_checksum=${checksum} recorded_operations=${previous.operations} requested_operations=${operations}`);
  }
  if (options.dryRun) {
    return `migration_id=${id} status=planned from_schema_hash=${live.schema_hash} to_schema_hash=${want.schema_hash} operations=${operations}\n${sqlText}`;
  }
  const record: MigrationRecord = { migrationId: id, name: options.name, fromHash: live.schema_hash, toHash: want.schema_hash, checksum, status: 'queued', operations };
  const startedAt = new Date();
  writeMigrationLog(options.logDir, migrationLog(record, driver, startedAt, undefined));
  let expectedStatus = 'queued';
  if (previous) expectedStatus = 'retryable';
  else {
    try { await insertMigration(db, record); } catch (error) {
      try { writeMigrationLog(options.logDir, migrationLog(record, driver, startedAt, new Date(), message(error))); } catch { /* the insert error is reported */ }
      throw error;
    }
  }
  try {
    await executeClaimedMigration(db, id, expectedStatus, sqlText);
  } catch (error) {
    const detail = `operation execution failed: ${message(error)}`;
    await markMigrationFailed(db, id, detail).catch(() => undefined);
    try { writeMigrationLog(options.logDir, migrationLog({ ...record, status: 'failed' }, driver, startedAt, new Date(), detail)); } catch { /* the execution error is reported */ }
    throw new ToolError(`MIGRATION_APPLY_FAILED: migration_id=${id} from=${live.schema_hash} to=${want.schema_hash}: ${message(error)}`);
  }
  let check: SchemaManifest;
  try { check = await liveManifest(db); } catch (error) {
    await updateMigration(db, id, 'failed', message(error)).catch(() => undefined);
    throw new ToolError(`MIGRATION_VERIFY_FAILED: migration_id=${id}: ${message(error)}`);
  }
  if (!schemaMatches(want, check, driver)) {
    const detail = `expected ${want.schema_hash} got ${check.schema_hash}`;
    await updateMigration(db, id, 'failed', detail).catch(() => undefined);
    throw new ToolError(`MIGRATION_VERIFY_FAILED: migration_id=${id} ${detail}`);
  }
  try { await updateMigration(db, id, 'applied', ''); } catch (error) {
    throw new ToolError(`MIGRATION_HISTORY_WRITE: migration_id=${id}: ${message(error)}`);
  }
  writeMigrationLog(options.logDir, migrationLog({ ...record, status: 'applied' }, driver, startedAt, new Date()));
  return `migration_id=${id} status=applied from_schema_hash=${live.schema_hash} to_schema_hash=${want.schema_hash} operations=${operations}\n`;
}
