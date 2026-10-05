// test-servers-mysql는 `test-servers.sh start`가 이미 실행 중인 서버에 대해 부르는 MySQL 설정 검사와
// migration이다. scripts/test-servers.sh가 선언한 설정(lower_case_table_names)을 기존 data
// directory의 설정과 비교한다. 같으면 아무것도 하지 않는다. 다르면 data를 옮긴다:
//
//   preflight  새 설정에서 이름이 겹칠 schema와 table을 찾고, 있으면 그 목록과 함께 거부한다
//   dump       system이 아닌 모든 database(routine, trigger, event 포함)와 사용자를 dump하고
//              database마다 table, view, routine, trigger, event 수와 table마다 행 수를 적는다
//   stop       MySQL primary와 replica를 멈춘다
//   keep       기존 data directory를 .runtime/mysql-before-<stamp>로 옮긴다(지우지 않는다)
//   start      선언한 설정으로 새 primary와 replica를 초기화하고 시작한다
//   restore    사용자와 dump를 새 primary에 넣는다(replica는 따라온다)
//   verify     primary와 replica의 수가 기록과 같은지 확인하고, 다르면 그 차이로 실패한다
//   record     새 data directory에 설정 marker를 쓰고 migration 기록을 보관한다
//
// 각 단계는 tests/testcase.mjs의 RUN, STEP, PASS, FAIL과 경과 시간, 자기 기한을 가진다. 진행은
// .runtime/mysql-migration에 단계마다 기록되므로, 실패한 뒤 다시 실행하면 끝난 단계는 건너뛰고
// 다음 단계부터 이어 간다. 새 data directory는 기존 것을 옮긴 뒤에만 지우고 다시 만든다.
//
// Usage: node scripts/test-servers-mysql.mjs <test-servers.sh> <servers dir> <mysql-port> <mysql-replica-port> <lower_case_table_names>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCase, stepLines } from '../tests/testcase.mjs';

// SYSTEM_SCHEMAS는 dump하지 않는 MySQL system schema다. SYSTEM_USERS는 초기화가 만드는 계정이다.
export const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];
const SYSTEM_USERS = ['root', 'mysql.sys', 'mysql.session', 'mysql.infoschema'];

// collisions는 lower_case_table_names가 0이 아닌 서버에서 같은 이름이 될 schema와 table을 돌려준다.
// schemas는 schema 이름, tables는 [schema, table] 목록이다. 결과는 겹치는 이름 묶음마다 한 줄이다.
export function collisions(schemas, tables) {
  const out = [];
  const group = (names, label) => {
    const byLower = new Map();
    for (const name of names) byLower.set(name.toLowerCase(), [...(byLower.get(name.toLowerCase()) ?? []), name]);
    for (const same of byLower.values()) if (same.length > 1) out.push(`${label}${same.sort().join(', ')}`);
  };
  group(schemas, 'schemas ');
  const bySchema = new Map();
  for (const [schema, table] of tables) bySchema.set(schema.toLowerCase(), [...(bySchema.get(schema.toLowerCase()) ?? []), table]);
  for (const [schema, names] of [...bySchema].sort()) group(names, `tables of ${schema}: `);
  return out;
}

// countDifferences는 기록한 수(before)와 새 서버의 수(after)가 다른 key마다 한 줄을 돌려준다. key는
// 소문자로 비교한다: lower_case_table_names=1은 이름을 소문자로 저장한다.
export function countDifferences(before, after) {
  const lower = counts => new Map(Object.entries(counts).map(([key, value]) => [key.toLowerCase(), value]));
  const a = lower(before);
  const b = lower(after);
  const out = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort())
    if (a.get(key) !== b.get(key)) out.push(`${key}: ${a.get(key) ?? 'absent'} before, ${b.get(key) ?? 'absent'} after`);
  return out;
}

// run은 program을 실행해 stdout을 돌려준다. stderr 줄은 단계로 내보낸다. signal에 process를 끝낸다.
function run(program, args, { signal, step, input, output } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'pipe', 'pipe'] });
    const lines = step ? stepLines(step) : null;
    const chunks = [];
    child.stdout.on('data', chunk => (output ? output(chunk) : chunks.push(chunk)));
    child.stderr.on('data', chunk => lines?.write(String(chunk)));
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop, { once: true });
    if (input) { child.stdin.end(input); }
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

const mysql = (port, sql, context) =>
  run('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-N', '-B', '-e', sql], context);
const rows = async (port, sql, context) =>
  (await mysql(port, sql, context)).split('\n').filter(Boolean).map(line => line.split('\t'));
const quote = name => `\`${name.replaceAll('`', '``')}\``;

// catalogCounts는 schemas의 table, view, routine, trigger, event 수와 table마다 행 수를 돌려준다.
async function catalogCounts(port, schemas, context) {
  const counts = {};
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
    const [[count]] = await rows(port, `SELECT COUNT(*) FROM ${quote(schema)}.${quote(table)}`, context);
    counts[`${schema}.${table} rows`] = Number(count);
  }
  const users = await rows(port, `SELECT user, host FROM mysql.user WHERE user NOT IN (${SYSTEM_USERS.map(user => `'${user}'`).join(', ')}) ORDER BY 1, 2`, context);
  counts.users = users.length;
  return counts;
}

// holdExclusive는 이 process가 끝날 때까지 서버의 exclusive lease(tests/lease)를 가진다. migration은
// 서버를 멈추고 data를 옮기므로, 다른 실행이 서버의 lease를 가지고 있으면 아무것도 바꾸지 않고 그
// 보유자를 적으며 실패한다. LEASE와 LEASES는 test-servers.sh가 준다.
function holdExclusive() {
  const { LEASE: lease, LEASES: leases } = process.env;
  if (!lease || !leases) throw new Error('LEASE and LEASES are unset; run make test-servers');
  const result = spawnSync(lease, ['hold', leases, 'exclusive', '--pid', String(process.pid)], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('test-servers: the MySQL migration needs the exclusive lease of the servers; nothing changed');
    process.exit(result.status ?? 1);
  }
}

async function main() {
  const [script, dir, mysqlPort, replicaPort, declared] = process.argv.slice(2);
  if (!script || !dir || !mysqlPort || !replicaPort || !/^[0-2]$/.test(declared ?? '')) {
    console.error('usage: test-servers-mysql.mjs <test-servers.sh> <servers dir> <mysql-port> <mysql-replica-port> <lower_case_table_names>');
    process.exit(2);
  }
  const runtime = dirname(dir);
  const work = join(runtime, 'mysql-migration');
  const marker = join(dir, 'mysql.settings');
  const wanted = `lower_case_table_names=${declared}\n`;
  const state = name => join(work, name);
  const done = name => existsSync(state(`${name}.done`));
  const mark = (name, text = '') => writeFileSync(state(`${name}.done`), text);

  // 진행 중인 migration이 없으면 기록된 설정(marker, 없으면 실행 중인 primary)을 선언과 비교한다.
  if (!existsSync(work)) {
    let recorded;
    if (existsSync(marker)) recorded = readFileSync(marker, 'utf8');
    else {
      const [[value]] = await rows(mysqlPort, 'SELECT @@lower_case_table_names').catch(error => {
        throw new Error(`the MySQL primary on ${mysqlPort} has no settings marker and does not answer: ${error.message}`);
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
  const steps = [
    ['preflight', 60_000, async context => {
      const schemas = (await rows(mysqlPort, 'SELECT schema_name FROM information_schema.schemata', context)).map(([name]) => name).filter(name => !SYSTEM_SCHEMAS.includes(name));
      const tables = await rows(mysqlPort, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN (${SYSTEM_SCHEMAS.map(name => `'${name}'`).join(', ')})`, context);
      const found = collisions(schemas, tables);
      if (found.length) throw new Error(`names that ${wanted.trim()} would merge, nothing changed: ${found.join('; ')}`);
      context.step(`${schemas.length} database(s), no name collides under ${wanted.trim()}`);
      writeFileSync(state('schemas.json'), JSON.stringify(schemas.sort()) + '\n');
    }],
    ['dump', 30 * 60_000, async context => {
      const schemas = JSON.parse(readFileSync(state('schemas.json'), 'utf8'));
      const counts = await catalogCounts(mysqlPort, schemas, context);
      writeFileSync(state('counts.json'), JSON.stringify(counts, null, 1) + '\n');
      for (const [key, value] of Object.entries(counts)) if (!key.endsWith(' rows')) context.step(`${key} ${value}`);
      const users = await rows(mysqlPort, `SELECT user, host FROM mysql.user WHERE user NOT IN (${SYSTEM_USERS.map(user => `'${user}'`).join(', ')}) ORDER BY 1, 2`, context);
      const statements = [];
      for (const [user, host] of users) {
        const account = `'${user.replaceAll("'", "''")}'@'${host.replaceAll("'", "''")}'`;
        // print_identified_with_as_hex는 password hash를 hex로 적어 SQL text로 다시 실행할 수 있게 한다.
        const [[create]] = await rows(mysqlPort, `SET SESSION print_identified_with_as_hex = ON; SHOW CREATE USER ${account}`, context);
        statements.push(`${create.replace(/^CREATE USER /, 'CREATE USER IF NOT EXISTS ')};`);
        for (const [grant] of await rows(mysqlPort, `SHOW GRANTS FOR ${account}`, context)) statements.push(`${grant};`);
      }
      writeFileSync(state('users.sql'), statements.join('\n') + '\n');
      const dump = [];
      if (schemas.length)
        await run('mysqldump', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', mysqlPort, '-u', 'root',
          '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--set-gtid-purged=OFF', '--no-tablespaces',
          '--databases', ...schemas], { ...context, output: chunk => dump.push(chunk) });
      writeFileSync(state('dump.sql'), Buffer.concat(dump));
      context.step(`${schemas.length} database(s) and ${users.length} user(s) dumped to ${state('dump.sql')}`);
    }],
    ['stop', 5 * 60_000, context => run('sh', [script, 'mysql-stop'], context)],
    ['keep', 60_000, async context => {
      mkdirSync(kept, { recursive: true });
      for (const name of ['mysql', 'mysql-replica']) {
        if (existsSync(join(dir, name))) renameSync(join(dir, name), join(kept, name));
        context.step(`${join(dir, name)} kept as ${join(kept, name)}`);
      }
    }],
    ['start', 5 * 60_000, async context => {
      // 기존 data는 keep 단계가 옮겼으므로, 앞선 시도가 남긴 새 data directory만 지운다.
      for (const name of ['mysql', 'mysql-replica']) rmSync(join(dir, name), { recursive: true, force: true });
      await run('sh', [script, 'mysql-start', mysqlPort, replicaPort], context);
    }],
    ['restore', 30 * 60_000, async context => {
      await run('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', mysqlPort, '-u', 'root'], { ...context, input: readFileSync(state('users.sql')) });
      await run('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', mysqlPort, '-u', 'root'], { ...context, input: readFileSync(state('dump.sql')) });
    }],
    ['verify', 10 * 60_000, async context => {
      const before = JSON.parse(readFileSync(state('counts.json'), 'utf8'));
      const schemas = JSON.parse(readFileSync(state('schemas.json'), 'utf8')).map(name => name.toLowerCase());
      const [[file, position]] = await rows(mysqlPort, 'SHOW BINARY LOG STATUS', context);
      const [[waited]] = await rows(replicaPort, `SELECT SOURCE_POS_WAIT('${file}', ${position}, 600)`, context);
      if (waited === 'NULL' || Number(waited) < 0) throw new Error(`the replica did not reach ${file}:${position}`);
      for (const [label, port] of [['primary', mysqlPort], ['replica', replicaPort]]) {
        const differences = countDifferences(before, await catalogCounts(port, schemas, context));
        if (differences.length) throw new Error(`the ${label} differs from the dump: ${differences.join('; ')}`);
        context.step(`the ${label} holds the ${Object.keys(before).length} recorded counts`);
      }
    }],
    ['record', 60_000, async context => {
      writeFileSync(marker, wanted);
      renameSync(work, join(kept, 'migration'));
      context.step(`${marker} records ${wanted.trim()}; the earlier data is kept in ${kept}`);
    }],
  ];
  for (const [name, deadline, body] of steps) {
    if (existsSync(work) && done(name)) { console.log(`test-servers: MySQL migration step ${name} done earlier`); continue; }
    if (!(await runCase(`mysql-migration/${name}`, deadline, body))) {
      console.error(`test-servers: the MySQL migration stopped in ${name}; run make test-servers again to resume`);
      process.exit(1);
    }
    if (existsSync(work)) mark(name);
  }
  console.log(`test-servers: MySQL migrated to ${wanted.trim()}; the earlier data is kept in ${kept}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
