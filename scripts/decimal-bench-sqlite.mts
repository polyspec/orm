// Prepare a separate SQLite bench database with exact decimal storage, and print its DSN.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runtime = join(root, '.runtime');
const database = join(runtime, 'decimal-bench.sqlite');
const leases = join(runtime, 'decimal-bench.leases');
mkdirSync(runtime, { recursive: true });
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
// The preparation runs under the exclusive lease (tests/lease). A lease never blocks after its holder ends: the releaser
// removes the lease of an ended holder or the next exclusive holder takes it, so a killed preparation blocks none.
if (process.env['DECIMAL_BENCH_LEASED'] === undefined) {
  const lease = process.env['LEASE'] || fail('LEASE is unset; run this through make, which exports it');
  const held = spawnSync(lease, ['run', leases, 'exclusive', '--wait', '--', process.execPath, import.meta.filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, DECIMAL_BENCH_LEASED: '1' } });
  process.exit(held.status ?? 1);
}
// sqlite runs the sqlite3 program on a database: its SQL from a file or as an argument, and its output.
function sqlite(path: string, sql: { file: string } | { query: string }): string {
  const fd = 'file' in sql ? openSync(sql.file, 'r') : undefined;
  try {
    const result = spawnSync('sqlite3', 'query' in sql ? [path, sql.query] : [path], { stdio: [fd ?? 'ignore', 'pipe', 'inherit'], encoding: 'utf8' });
    if (result.status !== 0) fail(`decimal-bench-sqlite: sqlite3 ${path} exited with ${result.status ?? result.signal ?? 'no status'}`);
    return result.stdout.trim();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
if (!existsSync(database)) {
  // The database is built in a temporary file and linked into place only when complete; mv -n of the shell script is a
  // link that fails when the database already exists, and the temporary file is removed in every case.
  const directory = mkdtempSync(join(runtime, 'decimal-bench.'));
  const temporary = join(directory, 'bench.sqlite');
  try {
    // scripts/bench-db.mts installs, seeds and fills the AES columns, as it does for the bench database of a run.
    const seeded = spawnSync(process.execPath, [join(root, 'scripts/bench-db.mts'), 'sqlite'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, BENCH_SQLITE_DSN: `sqlite://${temporary}` } });
    if (seeded.status !== 0) fail(`decimal-bench-sqlite: scripts/bench-db.mts sqlite exited with ${seeded.status ?? seeded.signal ?? 'no status'}`);
    try { linkSync(temporary, database); } catch (error) { if (!existsSync(database)) throw error; }
    unlinkSync(temporary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const type = sqlite(database, { query: "SELECT type FROM pragma_table_info('author') WHERE name='price'" });
if (type !== 'DECIMALINT(13,3)') fail(`decimal SQLite bench price type is ${type}, expected DECIMALINT(13,3)`);
const rows = sqlite(database, { query: 'SELECT count(*) FROM author' });
if (rows !== '100000') fail(`decimal SQLite bench has ${rows} rows, expected 100000`);
console.log(`sqlite://${database}?_pragma=busy_timeout(5000)&timezone=%2B00:00`);
