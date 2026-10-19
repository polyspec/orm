// test-servers-mysql is the MySQL settings check and migration that `test-servers.mts start` calls for a server already running.
// It compares the settings declared by scripts/test-servers.mts (lower_case_table_names) with those of the existing data
// directory. If they match, it does nothing. If they differ, it moves the data:
//
//   preflight  finds schemas and tables whose names would collide under the new settings, and if any, rejects with that list
//   dump       dumps all non-system databases (including routines, triggers, events) and users,
//              and records for each database the counts of tables, views, routines, triggers, events and for each table its row count
//   stop       stops the MySQL primary and replica
//   keep       moves the existing data directory to .runtime/mysql-before-<stamp> (does not delete it)
//   start      initializes and starts a new primary and replica with the declared settings
//   restore    puts the users and dump into the new primary (the replica follows)
//   verify     checks that the primary and replica counts match the record, and if not, fails with that difference
//   record     writes the settings marker into the new data directory and keeps the migration record
//
// Each step is a long task, so via runLong in tests/testcase.mts it prints its output lines and the TAP result line `ok - <step>`
// or `not ok - <step>` with the reason, and has no deadline. Success and failure are decided by each command's exit code and the counts checked. Waiting for the replica to reach the primary's binary log
// position with SOURCE_POS_WAIT also has no timeout. Progress
// is recorded per step in .runtime/mysql-migration, so after a failed run, running again skips the finished steps and
// continues from the next step. The new data directory is removed and recreated only after the existing one has been moved.
//
// Usage: node scripts/test-servers-mysql.mts <test-servers.mts> <servers dir> <mysql-port> <mysql-replica-port> <lower_case_table_names>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLong, stepLines, type Step } from '../tests/testcase.mts';
import { readJsonFile } from './json/schema.mts';

/** The context of a migration step: its step line writer and, when it has one, its abort signal. */
type Context = { step?: Step; signal?: AbortSignal };
/** The options of run: the step context, the standard input, and a writer of the standard output. */
type RunOptions = Context & { input?: Buffer | string; output?: (chunk: Buffer) => void };

// The files that a step writes for the next ones are read against their schemas (scripts/schema/).
const SCHEMAS_SCHEMA = new URL('./schema/mysql-migration-schemas.schema.json', import.meta.url).pathname;
const COUNTS_SCHEMA = new URL('./schema/mysql-migration-counts.schema.json', import.meta.url).pathname;

// SYSTEM_SCHEMAS are the MySQL system schemas not dumped. SYSTEM_USERS are the accounts that initialization creates.
export const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];
const SYSTEM_USERS = ['root', 'mysql.sys', 'mysql.session', 'mysql.infoschema'];

// collisions returns the schemas and tables that would have the same name on a server where lower_case_table_names is not 0.
// schemas are schema names; tables is the list of [schema, table]. The result is one line per group of colliding names.
export function collisions(schemas: string[], tables: string[][]): string[] {
  const out: string[] = [];
  const group = (names: string[], label: string) => {
    const byLower = new Map<string, string[]>();
    for (const name of names) byLower.set(name.toLowerCase(), [...(byLower.get(name.toLowerCase()) ?? []), name]);
    for (const same of byLower.values()) if (same.length > 1) out.push(`${label}${same.sort().join(', ')}`);
  };
  group(schemas, 'schemas ');
  const bySchema = new Map<string, string[]>();
  for (const [schema = '', table = ''] of tables) bySchema.set(schema.toLowerCase(), [...(bySchema.get(schema.toLowerCase()) ?? []), table]);
  for (const [schema, names] of [...bySchema].sort(([a], [b]) => (a < b ? -1 : Number(a > b)))) group(names, `tables of ${schema}: `);
  return out;
}

// countDifferences returns one line for each key where the recorded count (before) and the new server's count (after) differ. The key
// is compared in lowercase: lower_case_table_names=1 stores names in lowercase.
export function countDifferences(before: Record<string, number>, after: Record<string, number>): string[] {
  const lower = (counts: Record<string, number>) => new Map(Object.entries(counts).map(([key, value]) => [key.toLowerCase(), value]));
  const a = lower(before);
  const b = lower(after);
  const out: string[] = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort())
    if (a.get(key) !== b.get(key)) out.push(`${key}: ${a.get(key) ?? 'absent'} before, ${b.get(key) ?? 'absent'} after`);
  return out;
}

// run executes the program and returns its stdout. stderr lines are emitted as steps. On a signal, it ends the process.
function run(program: string, args: string[], { signal, step, input, output }: RunOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, { stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'pipe', 'pipe'] });
    const lines = step ? stepLines(step) : null;
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => { if (output) output(chunk); else chunks.push(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => lines?.write(String(chunk)));
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop, { once: true });
    if (input) { child.stdin?.end(input); }
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', stop);
      lines?.flush();
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve(Buffer.concat(chunks).toString());
      else reject(new Error(`${program} ${args.filter(arg => !arg.startsWith('-p')).join(' ')} exited with ${code}`));
    });
  });
}

const mysql = (port: string, sql: string, context?: Context) =>
  run('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-N', '-B', '-e', sql], context);
const rows = async (port: string, sql: string, context?: Context): Promise<string[][]> =>
  (await mysql(port, sql, context)).split('\n').filter(Boolean).map((line: string) => line.split('\t'));
const quote = (name: string): string => `\`${name.replaceAll('`', '``')}\``;

// catalogCounts returns, for schemas, the counts of tables, views, routines, triggers, events and the row count of each table.
async function catalogCounts(port: string, schemas: string[], context: Context): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (schemas.length === 0) return counts;
  const list = schemas.map(name => `'${name.replaceAll("'", "''")}'`).join(', ');
  for (const [schema, type, count] of await rows(port, `SELECT table_schema, table_type, COUNT(*) FROM information_schema.tables WHERE table_schema IN (${list}) GROUP BY 1, 2`, context))
    counts[`${schema} ${type === 'VIEW' ? 'views' : 'tables'}`] = Number(count);
  for (const [schema, count] of await rows(port, `SELECT routine_schema, COUNT(*) FROM information_schema.routines WHERE routine_schema IN (${list}) GROUP BY 1`, context))
    counts[`${schema} routines`] = Number(count);
  for (const [schema, count] of await rows(port, `SELECT trigger_schema, COUNT(*) FROM information_schema.triggers WHERE trigger_schema IN (${list}) GROUP BY 1`, context))
    counts[`${schema} triggers`] = Number(count);
  for (const [schema, count] of await rows(port, `SELECT event_schema, COUNT(*) FROM information_schema.events WHERE event_schema IN (${list}) GROUP BY 1`, context))
    counts[`${schema} events`] = Number(count);
  const tables = await rows(port, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN (${list}) AND table_type = 'BASE TABLE' ORDER BY 1, 2`, context);
  for (const [schema, table] of tables) {
    const [[count] = []] = await rows(port, `SELECT COUNT(*) FROM ${quote(schema ?? '')}.${quote(table ?? '')}`, context);
    counts[`${schema}.${table} rows`] = Number(count);
  }
  const users = await rows(port, `SELECT user, host FROM mysql.user WHERE user NOT IN (${SYSTEM_USERS.map(user => `'${user}'`).join(', ')}) ORDER BY 1, 2`, context);
  counts['users'] = users.length;
  return counts;
}

// holdExclusive holds the server's exclusive lease (tests/lease) until this process exits. The migration
// stops the server and moves data, so if another run holds the server's lease, it changes nothing and then
// fails, naming the holder. LEASE and LEASES are provided by test-servers.mts.
function holdExclusive() {
  const { LEASE: lease, LEASES: leases } = process.env;
  if (!lease || !leases) throw new Error('LEASE and LEASES are unset; run make orm-test-servers');
  const result = spawnSync(lease, ['hold', leases, 'exclusive', '--pid', String(process.pid)], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('test-servers: the MySQL migration needs the exclusive lease of the servers; nothing changed');
    process.exit(result.status ?? 1);
  }
}

async function main() {
  const [script, dir, mysqlPort, replicaPort, declared] = process.argv.slice(2);
  if (!script || !dir || !mysqlPort || !replicaPort || !/^[0-2]$/.test(declared ?? '')) {
    console.error('usage: test-servers-mysql.mts <test-servers.mts> <servers dir> <mysql-port> <mysql-replica-port> <lower_case_table_names>');
    process.exit(2);
  }
  const runtime = dirname(dir);
  const work = join(runtime, 'mysql-migration');
  const marker = join(dir, 'mysql.settings');
  const wanted = `lower_case_table_names=${declared}\n`;
  const state = (name: string) => join(work, name);
  const done = (name: string) => existsSync(state(`${name}.done`));
  const mark = (name: string, text = '') => writeFileSync(state(`${name}.done`), text);

  // If no migration is in progress, it compares the recorded settings (the marker, or else the running primary) with the declaration.
  if (!existsSync(work)) {
    let recorded: string;
    if (existsSync(marker)) recorded = readFileSync(marker, 'utf8');
    else {
      const [[value] = []] = await rows(mysqlPort, 'SELECT @@lower_case_table_names').catch((error: unknown) => {
        throw new Error(`the MySQL primary on ${mysqlPort} has no settings marker and does not answer: ${error instanceof Error ? error.message : String(error)}`);
      });
      recorded = `lower_case_table_names=${value}\n`;
    }
    if (recorded === wanted) {
      console.log(`test-servers: MySQL settings ${wanted.trim()} unchanged`);
      return;
    }
    console.log(`test-servers: MySQL data has ${recorded.trim()}; the declared ${wanted.trim()} needs a migration under ${work}`);
    holdExclusive();
    mkdirSync(work, { recursive: true });
    writeFileSync(state('stamp'), new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-') + '\n');
  } else {
    holdExclusive();
    console.log(`test-servers: resuming the MySQL migration under ${work}`);
  }
  const stamp = readFileSync(state('stamp'), 'utf8').trim();
  const kept = join(runtime, `mysql-before-${stamp}`);
  const steps: [string, (context: { step: Step }) => Promise<unknown>][] = [
    ['preflight', async context => {
      const schemas = (await rows(mysqlPort, 'SELECT schema_name FROM information_schema.schemata', context)).map(([name = '']) => name).filter(name => !SYSTEM_SCHEMAS.includes(name));
      const tables = await rows(mysqlPort, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN (${SYSTEM_SCHEMAS.map(name => `'${name}'`).join(', ')})`, context);
      const found = collisions(schemas, tables);
      if (found.length) throw new Error(`names that ${wanted.trim()} would merge, nothing changed: ${found.join('; ')}`);
      context.step(`${schemas.length} database(s), no name collides under ${wanted.trim()}`);
      writeFileSync(state('schemas.json'), JSON.stringify(schemas.sort()) + '\n');
    }],
    ['dump', async context => {
      const schemas = readJsonFile<string[]>(state('schemas.json'), SCHEMAS_SCHEMA);
      const counts = await catalogCounts(mysqlPort, schemas, context);
      writeFileSync(state('counts.json'), JSON.stringify(counts, null, 1) + '\n');
      for (const [key, value] of Object.entries(counts)) if (!key.endsWith(' rows')) context.step(`${key} ${value}`);
      const users = await rows(mysqlPort, `SELECT user, host FROM mysql.user WHERE user NOT IN (${SYSTEM_USERS.map(user => `'${user}'`).join(', ')}) ORDER BY 1, 2`, context);
      const statements: string[] = [];
      for (const [user = '', host = ''] of users) {
        const account = `'${user.replaceAll("'", "''")}'@'${host.replaceAll("'", "''")}'`;
        // print_identified_with_as_hex writes the password hash as hex so it can be re-run as SQL text.
        const [[create = ''] = []] = await rows(mysqlPort, `SET SESSION print_identified_with_as_hex = ON; SHOW CREATE USER ${account}`, context);
        statements.push(`${create.replace(/^CREATE USER /, 'CREATE USER IF NOT EXISTS ')};`);
        for (const [grant] of await rows(mysqlPort, `SHOW GRANTS FOR ${account}`, context)) statements.push(`${grant};`);
      }
      writeFileSync(state('users.sql'), statements.join('\n') + '\n');
      const dump: Buffer[] = [];
      if (schemas.length)
        await run('mysqldump', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', mysqlPort, '-u', 'root',
          '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--set-gtid-purged=OFF', '--no-tablespaces',
          '--databases', ...schemas], { ...context, output: (chunk: Buffer) => { dump.push(chunk); } });
      writeFileSync(state('dump.sql'), Buffer.concat(dump));
      context.step(`${schemas.length} database(s) and ${users.length} user(s) dumped to ${state('dump.sql')}`);
    }],
    ['stop', context => run(process.execPath, [script, 'mysql-stop'], context)],
    ['keep', async context => {
      mkdirSync(kept, { recursive: true });
      for (const name of ['mysql', 'mysql-replica']) {
        if (existsSync(join(dir, name))) renameSync(join(dir, name), join(kept, name));
        context.step(`${join(dir, name)} kept as ${join(kept, name)}`);
      }
    }],
    ['start', async context => {
      // The keep step already moved the existing data, so only the new data directory left by the earlier attempt is removed.
      for (const name of ['mysql', 'mysql-replica']) rmSync(join(dir, name), { recursive: true, force: true });
      await run(process.execPath, [script, 'mysql-start', mysqlPort, replicaPort], context);
    }],
    ['restore', async context => {
      await run('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', mysqlPort, '-u', 'root'], { ...context, input: readFileSync(state('users.sql')) });
      await run('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', mysqlPort, '-u', 'root'], { ...context, input: readFileSync(state('dump.sql')) });
    }],
    ['verify', async context => {
      const before = readJsonFile<Record<string, number>>(state('counts.json'), COUNTS_SCHEMA);
      const schemas = readJsonFile<string[]>(state('schemas.json'), SCHEMAS_SCHEMA).map(name => name.toLowerCase());
      const [[file, position] = []] = await rows(mysqlPort, 'SHOW BINARY LOG STATUS', context);
      const [[waited] = []] = await rows(replicaPort, `SELECT SOURCE_POS_WAIT('${file}', ${position})`, context);
      if (waited === 'NULL' || Number(waited) < 0) throw new Error(`the replica did not reach ${file}:${position}`);
      for (const [label, port] of [['primary', mysqlPort], ['replica', replicaPort]] as const) {
        const differences = countDifferences(before, await catalogCounts(port, schemas, context));
        if (differences.length) throw new Error(`the ${label} differs from the dump: ${differences.join('; ')}`);
        context.step(`the ${label} holds the ${Object.keys(before).length} recorded counts`);
      }
    }],
    ['record', async context => {
      writeFileSync(marker, wanted);
      renameSync(work, join(kept, 'migration'));
      context.step(`${marker} records ${wanted.trim()}; the earlier data is kept in ${kept}`);
    }],
  ];
  for (const [name, body] of steps) {
    if (existsSync(work) && done(name)) { console.log(`test-servers: MySQL migration step ${name} done earlier`); continue; }
    if (!(await runLong(`mysql-migration/${name}`, body))) {
      console.error(`test-servers: the MySQL migration stopped in ${name}; run make orm-test-servers again to resume`);
      process.exit(1);
    }
    if (existsSync(work)) mark(name);
  }
  console.log(`test-servers: MySQL migrated to ${wanted.trim()}; the earlier data is kept in ${kept}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
