#!/usr/bin/env node
// The state program of the services of the interface cases (docs/spec/service-state.md SVC-3 to SVC-6, binding GN-13j):
// service-state.mts <setup|check|change> <scope>, with the JSON of the step on standard input. It talks to the server
// with its client program and waits for each statement without a time limit.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

class StateError extends Error {}

interface Step {
  service?: unknown;
  table?: unknown;
  columns?: unknown;
  rows?: unknown;
  hold?: unknown;
  release?: unknown;
  absent?: unknown;
}

type Server = 'mysql' | 'postgres';

// The session zone of the MySQL setup: the zone that the connection of orm sets (packages/rust/src/db.rs:604-605,
// timezone "+00:00"). The test servers run in Asia/Seoul, and MySQL stores a TIMESTAMP in UTC from the session zone, so a
// value that the setup wrote in the server zone read back nine hours off through orm (T644). The service case
// a_condition_joined_by_or_updates_no_soft_deleted_row_mysql of contracts/interface/service.json and its revision and
// delete twins write a TIMESTAMP here and read it through orm, so they fail when the two zones differ.
const MYSQL_SESSION_TIME_ZONE = '+00:00';

// The address variables of the services (SVC-1).
const ADDRESSES: Record<string, Server> = { ORM_TEST_MYSQL_DSN: 'mysql', ORM_TEST_POSTGRES_DSN: 'postgres' };

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new StateError(`${what} is no nonempty text`);
  return value;
}

// The client command of a DSN, with the statements given on standard input.
function client(server: Server, dsn: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const url = new URL(dsn);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (server === 'postgres') {
    const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), '-d', database];
    return { command: 'psql', args, env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: url.searchParams.get('sslmode') ?? 'prefer' } };
  }
  const args = ['--batch', '--skip-column-names', '-h', url.hostname, '-P', url.port || '3306', '-u', decodeURIComponent(url.username), database];
  if (url.searchParams.get('ssl-mode') === 'disabled' || url.searchParams.get('tls') === 'false') args.unshift('--ssl-mode=DISABLED');
  return { command: 'mysql', args, env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) } };
}

function run(server: Server, dsn: string, sql: string, what: string): string {
  const { command, args, env } = client(server, dsn);
  const ran = spawnSync(command, args, { input: sql, env, encoding: 'utf8' });
  if (ran.error) throw new StateError(`${what}: ${command} did not start: ${ran.error.message}; install the client program of ${server}`);
  if (ran.status !== 0) throw new StateError(`${what}: ${command} exited with ${ran.status} for ${JSON.stringify(sql)}: ${ran.stderr.trim()}`);
  return ran.stdout;
}

// The XA identifier of a scope: 64 hex digits, within the 64 bytes of an XA gtrid.
const xid = (scope: string) => createHash('sha256').update(scope).digest('hex');

// Whether a prepared transaction of the scope is held: an XA transaction on MySQL, a prepared transaction on PostgreSQL.
function held(server: Server, dsn: string, scope: string, what: string): boolean {
  const id = xid(scope);
  if (server === 'mysql') return run('mysql', dsn, 'XA RECOVER;', what).split('\n').some(line => line.split('\t')[3] === id);
  return run('postgres', dsn, `SELECT count(*) FROM pg_prepared_xacts WHERE gid = '${id}';`, what).trim() !== '0';
}

function rollbackHeld(server: Server, dsn: string, scope: string, what: string) {
  if (!held(server, dsn, scope, what)) return;
  const id = xid(scope);
  run(server, dsn, server === 'mysql' ? `XA ROLLBACK '${id}';` : `ROLLBACK PREPARED '${id}';`, what);
}

function quoteValue(value: unknown, what: string): string {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (value === null) return 'NULL';
  throw new StateError(`${what}: a cell is an integer, a text or null`);
}

function setup(server: Server, dsn: string, scope: string, step: Step) {
  const what = `setup of ${scope}`;
  const table = text(step.table, `${what}: table`);
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new StateError(`${what}: table ${table} is no plain name`);
  const columns = text(step.columns, `${what}: columns`);
  const rows = step.rows ?? [];
  if (!Array.isArray(rows)) throw new StateError(`${what}: rows is no list`);
  const values = rows.map(row => {
    if (!Array.isArray(row)) throw new StateError(`${what}: a row is no list`);
    return `(${row.map(cell => quoteValue(cell, what)).join(', ')})`;
  });
  let sql = `${server === 'mysql' ? `SET time_zone = '${MYSQL_SESSION_TIME_ZONE}';\n` : ''}CREATE TABLE IF NOT EXISTS ${table} (${columns});\n`;
  if (values.length > 0) {
    sql += server === 'mysql' ? `INSERT IGNORE INTO ${table} VALUES ${values.join(', ')};\n` : `INSERT INTO ${table} VALUES ${values.join(', ')} ON CONFLICT DO NOTHING;\n`;
  }
  // A transaction that an earlier run of the scope left holds rows that the insert would wait for, so it is rolled back first.
  if (step.hold !== undefined) rollbackHeld(server, dsn, scope, what);
  run(server, dsn, sql, what);
  if (step.hold === undefined) return;
  const hold = step.hold;
  if (typeof hold !== 'object' || hold === null || Array.isArray(hold)) throw new StateError(`${what}: hold is an object`);
  const { where: holdWhere, mode: holdMode, column: holdColumn }: { where?: unknown; mode?: unknown; column?: unknown } = hold;
  if (holdMode !== 'update') throw new StateError(`${what}: hold.mode is update`);
  const where = text(holdWhere, `${what}: hold.where`);
  const column = text(holdColumn, `${what}: hold.column`);
  const id = xid(scope);
  const update = `UPDATE ${table} SET ${column} = ${quoteValue(id.slice(0, 16), what)} WHERE ${where};`;
  run(server, dsn, server === 'mysql'
    ? `XA START '${id}';\n${update}\nXA END '${id}';\nXA PREPARE '${id}';\n`
    : `BEGIN;\n${update}\nPREPARE TRANSACTION '${id}';\n`, what);
}

function check(server: Server, dsn: string, scope: string, step: Step) {
  const what = `check of ${scope}`;
  if (step.release === true) {
    rollbackHeld(server, dsn, scope, what);
    if (held(server, dsn, scope, what)) throw new StateError(`${what}: the prepared transaction of the scope is still held`);
    return;
  }
  if (step.absent !== undefined) {
    const table = text(step.absent, `${what}: absent`);
    const sql = server === 'mysql'
      ? `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}';`
      : `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '${table}';`;
    const count = run(server, dsn, sql, what).trim();
    if (count !== '0') throw new StateError(`${what}: the table ${table} exists`);
    return;
  }
  throw new StateError(`${what}: the step states neither release nor absent`);
}

function main(argv: string[]): number {
  const [stepName, scope] = argv;
  try {
    if (stepName === undefined || scope === undefined || argv.length !== 2) throw new StateError('usage: service-state.mts <setup|check|change> <scope>, with the JSON of the step on standard input');
    const parsed: unknown = JSON.parse(readFileSync(0, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new StateError(`${stepName} of ${scope}: the step is a JSON object`);
    const step: Step = parsed;
    const variable = text(step.service, `${stepName} of ${scope}: service`);
    const server = ADDRESSES[variable];
    if (server === undefined) throw new StateError(`${stepName} of ${scope}: service ${variable} is none of ${Object.keys(ADDRESSES).join(', ')}`);
    const dsn = process.env[variable];
    if (!dsn) throw new StateError(`${stepName} of ${scope}: ${variable} is not set; run make orm-test-servers <target> in one command, whose environment file sets it`);
    if (stepName === 'setup') setup(server, dsn, scope, step);
    else if (stepName === 'check') check(server, dsn, scope, step);
    else throw new StateError(`${stepName} of ${scope}: the program has no step ${stepName}; it has setup and check (SVC-6)`);
    return 0;
  } catch (error) {
    if (!(error instanceof StateError) && !(error instanceof SyntaxError)) throw error;
    process.stderr.write(`service-state: ${error.message}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
