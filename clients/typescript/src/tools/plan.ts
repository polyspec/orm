// Reviewed migration plans: `orm-gen plan` writes one, and `apply`, `recover`,
// `rollback`, and `verify` act on a database with it (docs/schema.md §4).
import { splitSQL } from '../engine/ddl.js';
import { indentJson } from '../engine/manifest.js';
import { encodeManifest, loadSchemaManifest, type SchemaManifest } from '../schema/build.js';
import { jsonString, list, object, quoted } from '../schema/json.js';
import type { ToolDb } from './db.js';
import { renderDiff } from './diff.js';
import { liveManifest } from './introspect.js';
import {
  checksumText, ensureMigrationTable, executeClaimedMigration, insertMigration, introspect, markMigrationFailed, message,
  migrationById, migrationLog, placeholder, schemaMatches, ToolError, transitionMigration, updateMigration,
  verifyMigrationLog, withMigrationLock, writeMigrationLog, type MigrationLog, type MigrationRecord,
} from './migrate.js';

export interface PlanOperation { sql: string; destructive: boolean; }

export interface MigrationPlanFile {
  version: number;
  migrationId: string;
  name: string;
  driver: string;
  fromHash: string;
  fromSchema: SchemaManifest | null;
  toHash: string;
  toSchema: SchemaManifest | null;
  checksum: string;
  operations: PlanOperation[];
  rollbackChecksum: string;
  rollbackOperations: PlanOperation[];
  rollbackDataLossRisk: boolean;
}

export function planOperations(sqlText: string): PlanOperation[] {
  return splitSQL(sqlText).map(statement => {
    const upper = statement.toUpperCase();
    const destructive = upper.includes('DROP TABLE') || upper.includes('DROP COLUMN') || upper.includes('MODIFY COLUMN') || upper.includes('ALTER COLUMN');
    return { sql: statement + ';', destructive };
  });
}

export function planSQL(operations: readonly PlanOperation[]): string {
  let out = '';
  for (const operation of operations) {
    out += operation.sql;
    if (!operation.sql.endsWith('\n')) out += '\n';
  }
  return out;
}

function hasDestructive(operations: readonly PlanOperation[]): boolean {
  return operations.some(operation => operation.destructive);
}

function encodeOperation(operation: PlanOperation): string {
  return object([['sql', jsonString(operation.sql)], ['destructive', String(operation.destructive)]]);
}

function encodeSchema(m: SchemaManifest | null): string {
  return m === null ? 'null' : encodeManifest(m);
}

/** The plan file text written by `orm-gen plan`. */
export function buildMigrationPlan(from: SchemaManifest, to: SchemaManifest, dialect: string, id: string, name: string): string {
  let sqlText: string;
  try { sqlText = renderDiff(from, to, dialect, true); } catch (error) { throw new ToolError(`MIGRATION_PLAN: ${message(error)}`); }
  let rollbackText: string;
  try { rollbackText = renderDiff(to, from, dialect, true); } catch (error) { throw new ToolError(`MIGRATION_ROLLBACK_PLAN: ${message(error)}`); }
  const operations = planOperations(sqlText);
  const rollbackOperations = planOperations(rollbackText);
  return indentJson(object([
    ['version', '1'],
    ['migration_id', jsonString(id)],
    ['name', jsonString(name)],
    ['driver', jsonString(dialect)],
    ['from_schema_hash', jsonString(from.schema_hash)],
    ['from_schema', encodeSchema(from)],
    ['to_schema_hash', jsonString(to.schema_hash)],
    ['to_schema', encodeSchema(to)],
    ['plan_checksum', jsonString(checksumText(planSQL(operations)))],
    ['operations', list(operations, encodeOperation)],
    ['rollback_checksum', jsonString(checksumText(planSQL(rollbackOperations)))],
    ['rollback_operations', list(rollbackOperations, encodeOperation)],
    ['rollback_data_loss_risk', String(hasDestructive(operations) || hasDestructive(rollbackOperations))],
  ])) + '\n';
}

const planName = /^[0-9]{8}-[a-z0-9][a-z0-9._-]*$/;

function validDate(yyyymmdd: string): boolean {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

/** The migration id a plan file name carries; it must match a requested id. */
export function migrationPlanId(out: string, requested: string): string {
  const base = out.split('/').filter(Boolean).pop() ?? '.';
  const dot = base.lastIndexOf('.');
  if (dot < 0 || base.slice(dot) !== '.json') throw new ToolError(`MIGRATION_FILE_NAME: plan file must use YYYYMMDD-name.json: ${base}`);
  const fileId = base.slice(0, -'.json'.length);
  if (!planName.test(fileId)) throw new ToolError(`MIGRATION_FILE_NAME: plan file must use YYYYMMDD-name.json: ${base}`);
  if (!validDate(fileId.slice(0, 8))) throw new ToolError(`MIGRATION_FILE_NAME: invalid YYYYMMDD date in ${base}`);
  if (requested !== '' && requested !== fileId) throw new ToolError(`MIGRATION_FILE_NAME: migration_id=${requested} must match plan filename id=${fileId}`);
  return fileId;
}

function field<T>(o: Record<string, unknown>, key: string, check: (v: unknown) => boolean, zero: T): T {
  const v = o[key];
  if (v === undefined || v === null) return zero;
  if (!check(v)) throw new Error(`json: cannot unmarshal ${key}`);
  return v as T;
}

function decodeOperations(value: unknown): PlanOperation[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('json: cannot unmarshal operations');
  return value.map(item => {
    const o = (item ?? {}) as Record<string, unknown>;
    return { sql: field(o, 'sql', v => typeof v === 'string', ''), destructive: field(o, 'destructive', v => typeof v === 'boolean', false) };
  });
}

function decodeSchema(value: unknown): SchemaManifest | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('json: cannot unmarshal schema');
  return value as SchemaManifest;
}

/** Reads a plan file; missing fields take their zero values. */
export function parsePlan(text: string): MigrationPlanFile {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('json: cannot unmarshal plan');
    const o = parsed as Record<string, unknown>;
    const isString = (v: unknown) => typeof v === 'string';
    return {
      version: field(o, 'version', v => Number.isInteger(v), 0),
      migrationId: field(o, 'migration_id', isString, ''),
      name: field(o, 'name', isString, ''),
      driver: field(o, 'driver', isString, ''),
      fromHash: field(o, 'from_schema_hash', isString, ''),
      fromSchema: decodeSchema(o.from_schema),
      toHash: field(o, 'to_schema_hash', isString, ''),
      toSchema: decodeSchema(o.to_schema),
      checksum: field(o, 'plan_checksum', isString, ''),
      operations: decodeOperations(o.operations),
      rollbackChecksum: field(o, 'rollback_checksum', isString, ''),
      rollbackOperations: decodeOperations(o.rollback_operations),
      rollbackDataLossRisk: field(o, 'rollback_data_loss_risk', v => typeof v === 'boolean', false),
    };
  } catch (error) {
    throw new ToolError(`MIGRATION_SOURCE: invalid plan JSON: ${message(error)}`);
  }
}

export function validatePlanOperations(label: string, operations: readonly PlanOperation[], checksum: string): void {
  if (checksumText(planSQL(operations)) !== checksum) throw new ToolError(`${label}: plan checksum mismatch`);
  operations.forEach((operation, i) => {
    const classified = planOperations(operation.sql);
    if (classified.length !== 1) throw new ToolError(`${label}: operation=${i + 1} must contain exactly one SQL statement`);
    if (operation.destructive !== classified[0]!.destructive) throw new ToolError(`${label}: operation=${i + 1} destructive flag mismatch`);
  });
}

export function validateRollbackPlan(plan: MigrationPlanFile): void {
  if (plan.version !== 1 || plan.migrationId === '' || plan.driver === '' || plan.fromSchema === null || plan.toSchema === null) {
    throw new ToolError('MIGRATION_ROLLBACK_PLAN: version, migration_id, driver, from_schema, and to_schema are required');
  }
  if ((plan.fromSchema.schema_hash ?? '') !== plan.fromHash || (plan.toSchema.schema_hash ?? '') !== plan.toHash) {
    throw new ToolError('MIGRATION_ROLLBACK_PLAN: embedded schema hash mismatch');
  }
  for (const [label, manifest] of [['from_schema', plan.fromSchema], ['to_schema', plan.toSchema]] as const) {
    try { loadSchemaManifest(JSON.stringify(manifest)); } catch (error) {
      throw new ToolError(`MIGRATION_ROLLBACK_PLAN: invalid ${label}: ${message(error)}`);
    }
  }
  validatePlanOperations('MIGRATION_PLAN', plan.operations, plan.checksum);
  validatePlanOperations('MIGRATION_ROLLBACK_PLAN', plan.rollbackOperations, plan.rollbackChecksum);
  const wantRisk = hasDestructive(plan.operations) || hasDestructive(plan.rollbackOperations);
  if (plan.rollbackDataLossRisk !== wantRisk) {
    throw new ToolError(`MIGRATION_ROLLBACK_PLAN: rollback_data_loss_risk mismatch expected=${wantRisk} actual=${plan.rollbackDataLossRisk}`);
  }
}

function verifyPlanRecord(plan: MigrationPlanFile, record: MigrationRecord): void {
  if (record.fromHash !== plan.fromHash || record.toHash !== plan.toHash || record.checksum !== plan.checksum || record.operations !== plan.operations.length) {
    throw new ToolError(`MIGRATION_HISTORY_CONFLICT: migration_id=${plan.migrationId} recorded_from=${record.fromHash} requested_from=${plan.fromHash} recorded_to=${record.toHash} requested_to=${plan.toHash} recorded_plan_checksum=${record.checksum} requested_plan_checksum=${plan.checksum} recorded_operations=${record.operations} requested_operations=${plan.operations.length}`);
  }
}

/** Checks the live schema against the target; returns the report line. */
export async function verifySchema(db: ToolDb, want: SchemaManifest): Promise<string> {
  const live = await introspect(db, `MIGRATION_INTROSPECT: driver=${db.driver}`);
  if (!schemaMatches(want, live, db.driver)) {
    throw new ToolError(`MIGRATION_VERIFY_FAILED: expected_schema_hash=${want.schema_hash} actual_schema_hash=${live.schema_hash}`);
  }
  return `status=verified schema_hash=${want.schema_hash}\n`;
}

/** Applies a reviewed plan; returns the report line. */
export async function applyPlan(db: ToolDb, plan: MigrationPlanFile, want: SchemaManifest, logDir: string): Promise<string> {
  const driver = db.driver;
  const id = plan.migrationId;
  await ensureMigrationTable(db);
  const live = await introspect(db, 'MIGRATION_INTROSPECT');
  const previous = await migrationById(db, id);
  if (previous) {
    verifyPlanRecord(plan, previous);
    switch (previous.status) {
      case 'applied':
        if (!schemaMatches(want, live, driver)) {
          throw new ToolError(`MIGRATION_DRIFT: migration_id=${id} status=applied expected_schema_hash=${want.schema_hash} actual_schema_hash=${live.schema_hash}`);
        }
        verifyMigrationLog(logDir, previous, driver);
        return `migration_id=${id} status=noop operations=0 schema_hash=${plan.toHash}\n`;
      case 'retryable': case 'rolled_back':
        // The source check below must pass before this row can return to applying.
        break;
      case 'queued': case 'applying': case 'failed':
        throw new ToolError(`MIGRATION_RECOVERY_REQUIRED: migration_id=${id} status=${previous.status} run ormgen recover with the same plan and target schema`);
      default:
        throw new ToolError(`MIGRATION_STATE_INVALID: migration_id=${id} status=${previous.status}`);
    }
  }
  if (plan.fromSchema !== null) {
    if (!schemaMatches(plan.fromSchema, live, driver)) {
      throw new ToolError(`MIGRATION_PRECONDITION: source schema does not match live database expected_hash=${plan.fromHash} actual_hash=${live.schema_hash}`);
    }
  } else if (live.schema_hash !== plan.fromHash) {
    throw new ToolError(`MIGRATION_PRECONDITION: expected_from_schema_hash=${plan.fromHash} actual_schema_hash=${live.schema_hash}`);
  }
  const operations = plan.operations.length;
  const checksum = checksumText(planSQL(plan.operations));
  const record: MigrationRecord = { migrationId: id, name: plan.name, fromHash: plan.fromHash, toHash: plan.toHash, checksum, status: 'queued', operations };
  const startedAt = new Date();
  writeMigrationLog(logDir, migrationLog(record, driver, startedAt, undefined));
  let expectedStatus = 'queued';
  if (previous) expectedStatus = previous.status;
  else await insertMigration(db, record);
  try {
    await executeClaimedMigration(db, id, expectedStatus, planSQL(plan.operations));
  } catch (error) {
    const detail = `operation execution failed: ${message(error)}`;
    await markMigrationFailed(db, id, detail).catch(() => undefined);
    try { writeMigrationLog(logDir, migrationLog({ ...record, status: 'failed' }, driver, startedAt, new Date(), detail)); } catch { /* the execution error is reported */ }
    throw new ToolError(`MIGRATION_APPLY_FAILED: migration_id=${id}: ${message(error)}`);
  }
  let detail = '';
  try {
    const check = await liveManifest(db);
    if (!schemaMatches(want, check, driver)) detail = `expected=${want.schema_hash} actual=${check.schema_hash}`;
  } catch (error) {
    detail = message(error);
  }
  if (detail !== '') {
    await updateMigration(db, id, 'failed', detail).catch(() => undefined);
    try { writeMigrationLog(logDir, migrationLog(record, driver, startedAt, new Date(), detail)); } catch { /* the verification error is reported */ }
    throw new ToolError(`MIGRATION_VERIFY_FAILED: migration_id=${id} ${detail}`);
  }
  try { await updateMigration(db, id, 'applied', ''); } catch (error) { throw new ToolError(`MIGRATION_HISTORY_WRITE: ${message(error)}`); }
  writeMigrationLog(logDir, migrationLog({ ...record, status: 'applied' }, driver, startedAt, new Date()));
  return `migration_id=${id} status=applied operations=${operations} schema_hash=${plan.toHash}\n`;
}

interface RecoveryTarget {
  atTarget: boolean;
  atSource: boolean;
  sourceHash: string;
  targetHash: string;
  retryDetail: string;
}

/**
 * Moves an interrupted migration to applied or retryable under the migration
 * lock. `check` validates the history record; `locate` places the live schema.
 */
async function recoverUnderLock(
  db: ToolDb, logDir: string, id: string,
  check: (record: MigrationRecord) => void,
  locate: (record: MigrationRecord, live: SchemaManifest) => RecoveryTarget,
): Promise<string> {
  const driver = db.driver;
  await ensureMigrationTable(db);
  let result = '';
  let recovered: MigrationLog | undefined;
  await withMigrationLock(db, async () => {
    const record = await migrationById(db, id);
    if (!record) throw new ToolError(`MIGRATION_HISTORY_MISSING: migration_id=${id} cannot recover a migration without a database history record`);
    check(record);
    let live: SchemaManifest;
    try { live = await liveManifest(db); } catch (error) { throw new ToolError(`MIGRATION_INTROSPECT: migration_id=${id}: ${message(error)}`); }
    const t = locate(record, live);
    const now = new Date();
    if (t.atTarget) {
      if (record.status === 'applied') {
        verifyMigrationLog(logDir, record, driver);
        result = 'noop';
        return;
      }
      if (!['queued', 'applying', 'failed', 'retryable'].includes(record.status)) {
        throw new ToolError(`MIGRATION_STATE_INVALID: migration_id=${id} status=${record.status}`);
      }
      await transitionMigration(db, id, record.status, 'applied', '');
      recovered = migrationLog({ ...record, status: 'applied' }, driver, now, now);
      result = 'applied';
      return;
    }
    if (t.atSource) {
      if (record.status === 'applied') {
        throw new ToolError(`MIGRATION_DRIFT: migration_id=${id} status=applied expected_schema_hash=${t.targetHash} actual_schema_hash=${live.schema_hash}`);
      }
      if (record.status === 'retryable') {
        verifyMigrationLog(logDir, record, driver);
        result = 'noop';
        return;
      }
      if (!['queued', 'applying', 'failed'].includes(record.status)) {
        throw new ToolError(`MIGRATION_STATE_INVALID: migration_id=${id} status=${record.status}`);
      }
      await transitionMigration(db, id, record.status, 'retryable', t.retryDetail);
      recovered = migrationLog({ ...record, status: 'retryable' }, driver, now, now, t.retryDetail);
      result = 'retryable';
      return;
    }
    throw new ToolError(`MIGRATION_RECOVERY_UNSAFE: migration_id=${id} status=${record.status} expected_source_hash=${t.sourceHash} expected_target_hash=${t.targetHash} actual_schema_hash=${live.schema_hash}; database and file logs were not modified`);
  });
  if (recovered) writeMigrationLog(logDir, recovered);
  return result;
}

/** Recovers the migration of a plan; returns the report line. */
export async function recoverPlan(db: ToolDb, plan: MigrationPlanFile, want: SchemaManifest, logDir: string): Promise<string> {
  const status = await recoverUnderLock(db, logDir, plan.migrationId, record => verifyPlanRecord(plan, record), (_, live) => ({
    atTarget: schemaMatches(want, live, db.driver),
    atSource: plan.fromSchema !== null ? schemaMatches(plan.fromSchema, live, db.driver) : live.schema_hash === plan.fromHash,
    sourceHash: plan.fromHash,
    targetHash: plan.toHash,
    retryDetail: 'live database matches the source schema; exact plan retry is permitted',
  }));
  return `migration_id=${plan.migrationId} status=${status} schema_hash=${want.schema_hash}\n`;
}

/** Recovers a migration recorded by `migrate`; returns the report line. */
export async function recoverMigrationById(db: ToolDb, id: string, want: SchemaManifest, logDir: string): Promise<string> {
  const status = await recoverUnderLock(db, logDir, id, record => {
    if (record.toHash !== want.schema_hash) {
      throw new ToolError(`MIGRATION_HISTORY_CONFLICT: migration_id=${id} recorded_to=${record.toHash} requested_to=${want.schema_hash}`);
    }
  }, (record, live) => ({
    atTarget: schemaMatches(want, live, db.driver),
    atSource: live.schema_hash === record.fromHash,
    sourceHash: record.fromHash,
    targetHash: record.toHash,
    retryDetail: 'live database matches the recorded source schema; deterministic migration retry is permitted',
  }));
  return `migration_id=${id} status=${status} schema_hash=${want.schema_hash}\n`;
}

async function markRollbackFailed(db: ToolDb, id: string, detail: string): Promise<void> {
  const d = db.driver;
  const q = `UPDATE orm_schema_migrations SET status=${placeholder(d, 1)}, error_detail=${placeholder(d, 2)}, finished_at=CURRENT_TIMESTAMP WHERE migration_id=${placeholder(d, 3)} AND status IN (${placeholder(d, 4)},${placeholder(d, 5)})`;
  let rows: number;
  try { rows = await db.exec(q, ['rollback_failed', detail, id, 'applied', 'rolling_back']); } catch (error) {
    throw new ToolError(`MIGRATION_HISTORY_WRITE: migration_id=${id} mark_rollback_failed: ${message(error)}`);
  }
  if (rows !== 1) throw new ToolError(`MIGRATION_STATE_CHANGED: migration_id=${id} rollback failure status was not written affected_rows=${rows}`);
}

/** Reverts an applied plan; returns the report line. */
export async function rollbackPlan(db: ToolDb, plan: MigrationPlanFile, logDir: string): Promise<string> {
  const driver = plan.driver;
  const id = plan.migrationId;
  const fromSchema = plan.fromSchema!;
  const toSchema = plan.toSchema!;
  const line = (status: string) => `migration_id=${id} status=${status} schema_hash=${plan.fromHash} operations=${plan.rollbackOperations.length}\n`;
  await ensureMigrationTable(db);
  const record = await migrationById(db, id);
  if (!record) throw new ToolError(`MIGRATION_HISTORY_MISSING: migration_id=${id}`);
  verifyPlanRecord(plan, record);
  let live = await introspect(db, `MIGRATION_INTROSPECT: migration_id=${id}`);
  const rollbackRecord: MigrationRecord = { migrationId: id, name: plan.name, fromHash: plan.toHash, toHash: plan.fromHash, checksum: plan.rollbackChecksum, status: 'rolled_back', operations: plan.rollbackOperations.length };
  if (record.status === 'rolled_back') {
    if (!schemaMatches(fromSchema, live, driver)) {
      throw new ToolError(`MIGRATION_ROLLBACK_DRIFT: migration_id=${id} expected_source_hash=${plan.fromHash} actual_schema_hash=${live.schema_hash}`);
    }
    verifyMigrationLog(logDir, rollbackRecord, driver);
    return line('noop');
  }
  if (record.status !== 'applied') throw new ToolError(`MIGRATION_ROLLBACK_STATE: migration_id=${id} status=${record.status} expected=applied`);
  if (!schemaMatches(toSchema, live, driver)) {
    throw new ToolError(`MIGRATION_ROLLBACK_PRECONDITION: migration_id=${id} expected_target_hash=${plan.toHash} actual_schema_hash=${live.schema_hash}`);
  }
  const started = new Date();
  rollbackRecord.status = 'rolling_back';
  writeMigrationLog(logDir, migrationLog(rollbackRecord, driver, started, undefined));
  let claimed = false;
  try {
    await withMigrationLock(db, async () => {
      await transitionMigration(db, id, 'applied', 'rolling_back', '');
      claimed = true;
      for (const [i, operation] of plan.rollbackOperations.entries()) {
        for (const statement of splitSQL(operation.sql)) {
          try { await db.exec(statement); } catch (error) {
            throw new ToolError(`rollback_operation=${i + 1} statement=${quoted(statement)}: ${message(error)}`);
          }
        }
      }
    });
  } catch (error) {
    let detail = message(error);
    if (claimed) {
      try { await markRollbackFailed(db, id, detail); } catch (markError) { detail += `; history_error=${message(markError)}`; }
      rollbackRecord.status = 'rollback_failed';
      try { writeMigrationLog(logDir, migrationLog(rollbackRecord, driver, started, new Date(), detail)); } catch { /* the rollback error is reported */ }
    }
    throw new ToolError(`MIGRATION_ROLLBACK_FAILED: migration_id=${id}: ${message(error)}`);
  }
  let detail = '';
  try {
    live = await liveManifest(db);
    if (!schemaMatches(fromSchema, live, driver)) detail = `expected=${plan.fromHash} actual=${live.schema_hash}`;
  } catch (error) {
    detail = message(error);
  }
  if (detail !== '') {
    await transitionMigration(db, id, 'rolling_back', 'rollback_failed', detail).catch(() => undefined);
    throw new ToolError(`MIGRATION_ROLLBACK_VERIFY_FAILED: migration_id=${id} ${detail}`);
  }
  try { await transitionMigration(db, id, 'rolling_back', 'rolled_back', ''); } catch (error) {
    throw new ToolError(`MIGRATION_HISTORY_WRITE: migration_id=${id} rollback: ${message(error)}`);
  }
  rollbackRecord.status = 'rolled_back';
  writeMigrationLog(logDir, migrationLog(rollbackRecord, driver, started, new Date()));
  return line('rolled_back');
}
