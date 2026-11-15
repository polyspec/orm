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

function rollbackHeld(dsn: string, scope: string, what: string) {
  const id = xid(scope);
  const held = run('mysql', dsn, 'XA RECOVER;', what).split('\n').some(line => line.split('\t')[3] === id);
  if (held) run('mysql', dsn, `XA ROLLBACK '${id}';`, what);
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
  let sql = `CREATE TABLE IF NOT EXISTS ${table} (${columns});\n`;
  if (values.length > 0) {
    sql += server === 'mysql' ? `INSERT IGNORE INTO ${table} VALUES ${values.join(', ')};\n` : `INSERT INTO ${table} VALUES ${values.join(', ')} ON CONFLICT DO NOTHING;\n`;
  }
  run(server, dsn, sql, what);
  if (step.hold === undefined) return;
  if (server !== 'mysql') throw new StateError(`${what}: hold needs the service mysql, because the PostgreSQL test servers keep no prepared transaction (SVC-4)`);
  const hold = step.hold as { where?: unknown; mode?: unknown; column?: unknown };
  if (hold.mode !== 'update') throw new StateError(`${what}: hold.mode is update`);
  const where = text(hold.where, `${what}: hold.where`);
  const column = text(hold.column, `${what}: hold.column`);
  rollbackHeld(dsn, scope, what);
  const id = xid(scope);
  run('mysql', dsn, `XA START '${id}';\nUPDATE ${table} SET ${column} = ${quoteValue(id.slice(0, 16), what)} WHERE ${where};\nXA END '${id}';\nXA PREPARE '${id}';\n`, what);
}

function check(server: Server, dsn: string, scope: string, step: Step) {
  const what = `check of ${scope}`;
  if (step.release === true) {
    if (server !== 'mysql') throw new StateError(`${what}: release needs the service mysql (SVC-6)`);
    rollbackHeld(dsn, scope, what);
    const left = run('mysql', dsn, 'XA RECOVER;', what).split('\n').some(line => line.split('\t')[3] === xid(scope));
    if (left) throw new StateError(`${what}: the prepared transaction of the scope is still held`);
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
    const step = JSON.parse(readFileSync(0, 'utf8')) as Step;
    const variable = text(step.service, `${stepName} of ${scope}: service`);
    const server = ADDRESSES[variable];
    if (server === undefined) throw new StateError(`${stepName} of ${scope}: service ${variable} is none of ${Object.keys(ADDRESSES).join(', ')}`);
    const dsn = process.env[variable];
    if (!dsn) throw new StateError(`${stepName} of ${scope}: ${variable} is not set; run make orm-test-servers, whose environment file sets it`);
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
