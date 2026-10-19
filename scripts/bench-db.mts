// Recreates the bench databases named by BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN and BENCH_SQLITE_DSN: installs
// contracts/fixtures/bench/bench.dbs through the generated TypeScript model (make databases-create builds it), runs the seed of each dialect
// and fills the AES and blind-index columns of the 100000 authors with the host codecs of the TypeScript client, in one
// transaction through the command-line client of the dialect.
//
// Usage: node scripts/bench-db.mts [mysql] [postgres] [sqlite]
// With no argument every dialect is seeded. A named dialect is seeded alone, and its DSN is required; the other DSNs are
// not read.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
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
  || fail(`${name} is required; run it through make orm-check or make run-databases TARGETS=<target>, which create the bench database of the run`);
// run runs one step in the root; input names a file it reads as its standard input, text is its standard input. A failure
// stops the seed.
function run(program: string, args: string[], { input, text, env }: { input?: string; text?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const fd = input === undefined ? undefined : openSync(resolve(root, input), 'r');
  try {
    const result = spawnSync(program, args, { cwd: root, stdio: [fd ?? (text === undefined ? 'inherit' : 'pipe'), 'inherit', 'inherit'],
      env: { ...process.env, ...env }, ...(text === undefined ? {} : { input: text }), maxBuffer: 1 << 30 });
    if (result.status !== 0) fail(`bench-db: ${[program, ...args].join(' ')} exited with ${result.status ?? result.signal ?? 'no status'}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The client of the checkout, built by make typescript-build: the bench model and the host codecs.
const { connect, SCHEMA } = await import('../packages/ts/dist/models/models.js');
const { Db, blindIndex, dbspecManifest, hostEncode, parseDbspec } = await import('../packages/ts/dist/index.js');

// SHARED is the schema value of contracts/fixtures/bench/bench_shared.dbs, the external document of the bench set, as
// the set that owns it would generate it: the bench set requires its used table to exist before it installs
// (docs/spec/dbspec.md "External documents").
function sharedSchema(): { manifestText: string; manifestHash: string } {
  const parsed = parseDbspec(readFileSync(resolve(root, 'contracts/fixtures/bench/bench_shared.dbs'), 'utf8'), {});
  const manifest = parsed.document === null ? null : dbspecManifest([parsed.document]).manifest;
  if (manifest === null) return fail('bench-db: contracts/fixtures/bench/bench_shared.dbs does not parse');
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

// install installs the external document of the bench set as its own set, then the manifest of
// contracts/fixtures/bench/dbspec-set.json, on the database of a DSN.
async function install(source: string): Promise<void> {
  const shared = sharedSchema();
  const owner = await Db.connectSchema(source, shared);
  try { await owner.utils().schema().install(shared); } finally { await owner.close(); }
  const db = await connect(source);
  try { await db.utils().schema().install(SCHEMA); } finally { await db.close(); }
}

// AES_KEY, BLIND_INDEX_KEY and AES_KEY_VERSION are the keys of the bench data, which the bench clients read.
const AES_KEY = 'bench-salt', BLIND_INDEX_KEY = 'bench-blind-index', AES_KEY_VERSION = 1, AUTHORS = 100000;

// hex is the value of a host codec as hex text; any other value stops the seed.
function hex(value: string | Uint8Array | null): string {
  return typeof value === 'string' && /^[0-9A-Fa-f]+$/.test(value) ? value : fail(`bench-db: a host codec gave ${String(value)}, not hex text`);
}

// aesUpdates is the transaction that sets the AES and blind-index columns of every author: the email and phone in the
// authenticated host format (aes then hex) and their HMAC indexes. The values are hex, so they are written as literals.
function aesUpdates(quote: (name: string) => string, begin: string): string {
  const lines = [begin];
  for (let seq = 1; seq <= AUTHORS; seq++) {
    const email = `user${seq}@example.com`, phone = `010-${String(seq).padStart(8, '0')}`;
    const [aesEmail, aesPhone, emailIndex, phoneIndex] = [hostEncode(email, ['aes', 'hex'], AES_KEY), hostEncode(phone, ['aes', 'hex'], AES_KEY),
      blindIndex(email, BLIND_INDEX_KEY), blindIndex(phone, BLIND_INDEX_KEY)].map(hex);
    lines.push(`UPDATE ${quote('author')} SET ${quote('aes_hex_email')} = '${aesEmail}', ${quote('aes_hex_phone')} = '${aesPhone}', ${quote('email_blind_index')} = '${emailIndex}', ` +
      `${quote('phone_blind_index')} = '${phoneIndex}', ${quote('aes_key_version')} = ${AES_KEY_VERSION} WHERE ${quote('seq')} = ${seq};`);
  }
  lines.push('COMMIT;', '');
  return lines.join('\n');
}
const backquote = (name: string) => `\`${name}\``;
const doubleQuote = (name: string) => `"${name}"`;

// seedMysql recreates and seeds the database of BENCH_MYSQL_DSN (mysql://user@host:port/db?query).
async function seedMysql(): Promise<void> {
  const url = new URL(dsn('BENCH_MYSQL_DSN'));
  const user = decodeURIComponent(url.username);
  const database = url.pathname.slice(1);
  const cli = ['--no-defaults', '--protocol=TCP', '-h', url.hostname, '-P', url.port, '-u', user];
  run('mysql', [...cli, '-e', `DROP DATABASE IF EXISTS \`${database}\`; CREATE DATABASE \`${database}\``]);
  await install(url.href);
  run('mysql', [...cli, "--init-command=SET time_zone='+00:00'", database], { input: 'benchmarks/sql/seed.mysql.sql' });
  run('mysql', [...cli, database], { text: aesUpdates(backquote, 'START TRANSACTION;') });
  console.log(`bench-db: ${database} installed from contracts/fixtures/bench/bench.dbs and seeded`);
}

// seedPostgres recreates and seeds the database of BENCH_POSTGRES_DSN (postgres://user@host:port/db?query).
async function seedPostgres(): Promise<void> {
  const url = new URL(dsn('BENCH_POSTGRES_DSN'));
  const database = url.pathname.slice(1);
  // The server URI keeps the user information of the DSN and drops its database and query.
  const credentials = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  const server = `postgres://${credentials}${url.host}`;
  run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', `${server}/postgres?sslmode=disable`, '-c', `DROP DATABASE IF EXISTS "${database}"`, '-c', `CREATE DATABASE "${database}"`], { env: { PGTZ: 'UTC' } });
  await install(url.href);
  const psql = ['-X', '-q', '-o', '/dev/null', '-v', 'ON_ERROR_STOP=1', `${server}/${database}?sslmode=disable`];
  const env = { PGTZ: 'UTC', PGOPTIONS: '-c client_min_messages=warning' };
  run('psql', [...psql, '-f', 'benchmarks/sql/seed.pg.sql'], { env });
  run('psql', psql, { env, text: aesUpdates(doubleQuote, 'BEGIN;') });
  console.log(`bench-db: ${database} installed from contracts/fixtures/bench/bench.dbs and seeded`);
}

// seedSqlite recreates and seeds the file of BENCH_SQLITE_DSN; it uses no MySQL or PostgreSQL server.
async function seedSqlite(): Promise<void> {
  const source = dsn('BENCH_SQLITE_DSN');
  const path = source.replace(/^sqlite:\/\//, '').replace(/\?.*$/, '');
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  await install(source);
  run('sqlite3', [path], { input: 'benchmarks/sql/seed.sqlite.sql' });
  run('sqlite3', ['-bail', path], { text: aesUpdates(doubleQuote, 'BEGIN;') });
  console.log(`bench-db: ${path} installed from contracts/fixtures/bench/bench.dbs and seeded`);
}

const seeds: Record<Dialect, () => Promise<void>> = { mysql: seedMysql, postgres: seedPostgres, sqlite: seedSqlite };
for (const dialect of dialects) await seeds[dialect]();
