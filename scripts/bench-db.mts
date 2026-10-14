// Recreates the bench databases named by BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN and BENCH_SQLITE_DSN: installs
// schema/bench.dbs through the generated Go model, runs the seed of each dialect and fills the AES and blind-index columns.
//
// Usage: node scripts/bench-db.mts [mysql] [postgres] [sqlite]
// With no argument every dialect is seeded. A named dialect is seeded alone, and its DSN is required; the other DSNs are
// not read.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const DIALECTS = ['mysql', 'postgres', 'sqlite'] as const;
type Dialect = (typeof DIALECTS)[number];
const isDialect = (name: string): name is Dialect => DIALECTS.some(dialect => dialect === name);

const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};
const given = process.argv.slice(2);
const unknown = given.find(name => !isDialect(name));
if (unknown !== undefined) fail(`bench-db: unknown dialect ${unknown}; use mysql, postgres or sqlite`, 2);
const dialects: Dialect[] = given.length === 0 ? [...DIALECTS] : given.filter(isDialect);

const dsn = (name: string): string => process.env[name]
  || fail(`${name} is required; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run`);
// run runs one step in the root; input names a file it reads as its standard input. A failure stops the seed.
function run(program: string, args: string[], { input, env }: { input?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const fd = input === undefined ? undefined : openSync(resolve(root, input), 'r');
  try {
    const result = spawnSync(program, args, { cwd: root, stdio: [fd ?? 'inherit', 'inherit', 'inherit'], env: { ...process.env, ...env } });
    if (result.status !== 0) fail(`bench-db: ${[program, ...args].join(' ')} exited with ${result.status ?? result.signal ?? 'no status'}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const goRun = (label: string, ...args: string[]) => run('node', [resolve(root, 'tests/go-run.mts'), label, ...args]);

// seedMysql recreates and seeds the database of BENCH_MYSQL_DSN (mysql://user@host:port/db?query).
function seedMysql(): void {
  const url = new URL(dsn('BENCH_MYSQL_DSN'));
  const user = decodeURIComponent(url.username);
  const database = url.pathname.slice(1);
  const cli = ['--no-defaults', '--protocol=TCP', '-h', url.hostname, '-P', url.port, '-u', user];
  run('mysql', [...cli, '-e', `DROP DATABASE IF EXISTS \`${database}\`; CREATE DATABASE \`${database}\``]);
  goRun('bench-install', './bench/install', '-dsn', url.href);
  run('mysql', [...cli, "--init-command=SET time_zone='+00:00'", database], { input: 'bench/sql/seed.mysql.sql' });
  goRun('bench-seedaes', './bench/seedaes', '-driver', 'mysql', '-dsn', `${user}@tcp(${url.hostname}:${url.port})/${database}?parseTime=true`);
  console.log(`bench-db: ${database} installed from schema/bench.dbs and seeded`);
}

// seedPostgres recreates and seeds the database of BENCH_POSTGRES_DSN (postgres://user@host:port/db?query).
function seedPostgres(): void {
  const url = new URL(dsn('BENCH_POSTGRES_DSN'));
  const database = url.pathname.slice(1);
  // The server URI keeps the user information of the DSN and drops its database and query.
  const credentials = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  const server = `postgres://${credentials}${url.host}`;
  run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', `${server}/postgres?sslmode=disable`, '-c', `DROP DATABASE IF EXISTS "${database}"`, '-c', `CREATE DATABASE "${database}"`], { env: { PGTZ: 'UTC' } });
  goRun('bench-install', './bench/install', '-dsn', url.href);
  run('psql', ['-X', '-q', '-o', '/dev/null', '-v', 'ON_ERROR_STOP=1', `${server}/${database}?sslmode=disable`, '-f', 'bench/sql/seed.pg.sql'],
    { env: { PGTZ: 'UTC', PGOPTIONS: '-c client_min_messages=warning' } });
  goRun('bench-seedaes', './bench/seedaes', '-driver', 'postgres', '-dsn', `${server}/${database}?sslmode=disable`);
  console.log(`bench-db: ${database} installed from schema/bench.dbs and seeded`);
}

// seedSqlite recreates and seeds the file of BENCH_SQLITE_DSN; it uses no MySQL or PostgreSQL server.
function seedSqlite(): void {
  const source = dsn('BENCH_SQLITE_DSN');
  const path = source.replace(/^sqlite:\/\//, '').replace(/\?.*$/, '');
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  goRun('bench-install', './bench/install', '-dsn', source);
  run('sqlite3', [path], { input: 'bench/sql/seed.sqlite.sql' });
  goRun('bench-seedaes', './bench/seedaes', '-driver', 'sqlite', '-dsn', `file:${path}`);
  console.log(`bench-db: ${path} installed from schema/bench.dbs and seeded`);
}

const seeds: Record<Dialect, () => void> = { mysql: seedMysql, postgres: seedPostgres, sqlite: seedSqlite };
for (const dialect of dialects) seeds[dialect]();
