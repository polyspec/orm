// Checks, within a target of the full suite, that an independent next command still runs after a failed command (G5.38-3). Each case
// runs the real script, but with fake php and node placed first on PATH; they log their arguments and fail at the first test. Real tests and
// database are not run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, PROCESS } from '../../tests/testcase.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// fake logs each program's arguments, and provides a fake program that prints one line and exits with 3 when an argument contains failing.
function fake(programs: string[], failing: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'continue-')));
  try {
    mkdirSync(join(base, 'bin'));
    const log = join(base, 'ran.log');
    for (const program of programs)
      writeFileSync(join(base, 'bin', program), `#!/bin/sh\necho "${program} $*" >> ${log}\ncase "$*" in *'${failing}'*) echo 'FAIL ${failing}: expected 1 row, actual 0'; exit 3;; esac\n`, { mode: 0o755 });
    return {
      base,
      run: (args: string[], env = {}) => spawnSync(args[0]?.endsWith('.mts') ? process.execPath : 'sh', args, { cwd: repo, encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(base, 'bin')}:${process.env.PATH}`, ...env }) }),
      ran: () => readFileSync(log, 'utf8').trim().split('\n'),
    };
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    throw error;
  }
}

// declared reads the commands the script runs from COMMANDS (scripts/check/commands.mts), which the script exports. The expected commands and
// their count are not hand-written, so the case still matches when test files are added to or removed from a lane. It returns the commands that start with a program, in run order.
async function declared(script: string, program: string): Promise<string[]> {
  const module: unknown = await import(join(repo, script));
  assert.ok(typeof module === 'object' && module !== null && 'COMMANDS' in module && Array.isArray(module.COMMANDS), `${script} exports no COMMANDS`);
  const commands = module.COMMANDS.filter((command): command is string => typeof command === 'string' && command.startsWith(`${program} `));
  assert.ok(commands.length > 1, `${script} declares no ${program} commands`);
  return commands;
}

caseTest('the PHP lane of client-db-test runs every test after a failed one and names the failures', PROCESS, async () => {
  const f = fake(['php'], 'ModelTest');
  try {
    const result = f.run(['scripts/client-db-test.mts'], { ORM_RUST_TEST_FEATURES: 'none', ORM_CLIENT_DB_LANGS: 'php' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const expected = await declared('scripts/client-db-test.mts', 'php');
    assert.equal(expected[0], 'php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelTest.php');
    assert.deepEqual(f.ran(), expected);
    assert.match(result.stderr, /client-db-test: the php lane failed:\n {2}php vendor-php\/bin\/phpunit --configuration packages\/php\/phpunit\.xml\.dist packages\/php\/tests\/ModelTest\.php \(exit 3\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

caseTest('the TypeScript SQLite tests run every test after a failed one and name the failures', PROCESS, async () => {
  const f = fake(['node'], 'model.mjs');
  try {
    const result = f.run(['scripts/typescript/sqlite-test.mts']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    // The first node command is the build, and the tests run after it.
    const expected = await declared('scripts/typescript/sqlite-test.mts', 'node');
    assert.equal(expected[1], 'node packages/ts/tests/model.mjs');
    assert.deepEqual(f.ran(), expected);
    assert.match(result.stderr, /sqlite-test: failed:\n {2}node packages\/ts\/tests\/model\.mjs \(exit 3\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// The sequential-lane case (G5.53) checks whether, when lanes run in sequence rather than in parallel, the lanes after a failed lane still run. A failed lane
// only collects its own failures and returns them; it does not end the whole run.
caseTest('client-db-test runs the next lane after a failed lane in sequence and names the failed lanes', PROCESS, () => {
  const f = fake(['php', 'node'], 'ModelTest');
  try {
    const result = f.run(['scripts/client-db-test.mts'], { ORM_RUST_TEST_FEATURES: 'none', ORM_CLIENT_DB_LANGS: 'php,typescript', ORM_CLIENT_DB_LANES: '' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const ran = f.ran();
    assert.ok(ran.includes('node packages/ts/tests/model.mjs'), ran.join('\n'));
    assert.match(result.stderr, /client-db-test: failed lanes: php\n/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// The perf case (G5.53) checks whether all four performance gate measurements still run when an earlier measurement fails.
caseTest('the performance gates run every gate after a failed one and name the failures', PROCESS, () => {
  const f = fake(['node', 'php'], 'TestNative');
  try {
    const result = f.run(['scripts/perf-test.mts']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.ran().length, 4, f.ran().join('\n'));
    assert.match(result.stderr, /perf-test: failed:\n {2}node tests\/go-test\.mts .*TestNative.* \(exit 3\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// The package case (G5.53) checks whether all four package checks (TypeScript, PHP, Rust, Go) still run when an earlier check fails.
caseTest('the package checks run every package after a failed one and name the failures', PROCESS, () => {
  const f = fake(['npm', 'node', 'composer', 'cargo', 'go'], 'pack');
  try {
    writeFileSync(join(f.base, 'bin', 'lease'), '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    // HOME keeps a script that puts $HOME/.cargo/bin ahead of the fake bin from selecting the real cargo.
    const result = f.run(['scripts/package-check.mts'], { HOME: f.base, CARGO_TARGET_DIR: join(f.base, 'target'), LEASE: join(f.base, 'bin', 'lease'), CARGO_LEASES: join(f.base, 'leases') });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const ran = f.ran().map(line => line.split(' ')[0]);
    for (const program of ['composer', 'cargo', 'go']) assert.ok(ran.includes(program), `${program} did not run: ${ran.join(' ')}`);
    assert.match(result.stderr, /package-check: failed:\n {2}typescript package/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

caseTest('database commands report unreadable server configuration before calling MySQL or PostgreSQL', PROCESS, () => {
  const f = fake(['mysql', 'psql'], 'never');
  try {
    const dir = join(f.base, 'databases');
    mkdirSync(dir);
    let index = 0;
    const run = (action: string, servers: string, expected: RegExp, status = 1) => {
      const path = join(f.base, `${action}-${index++}.env`);
      if (servers !== 'DIRECTORY' && servers !== 'MISSING') writeFileSync(path, servers === 'INVALID' ? 'BROKEN=yes\n' : servers);
      if (servers === 'DIRECTORY') mkdirSync(path);
      const result = f.run(['scripts/check/databases.mts', action, path, dir, 'orm_x']);
      assert.equal(result.status, status, result.stdout + result.stderr);
      assert.match(result.stderr, expected);
      assert.match(result.stderr, /run make orm-test-servers to rewrite it/);
      assert.ok(!existsSync(join(f.base, 'ran.log')), 'a database client ran before configuration was rejected');
    };
    run('create', '', /create: .* names no ORM_RUN_MYSQL_DSN/);
    run('drop-dead', "export ORM_RUN_MYSQL_DSN='mysql://root@127.0.0.1:1/run'\n", /drop-dead: .* names no ORM_RUN_POSTGRES_DSN/);
    run('drop', "export ORM_RUN_MYSQL_DSN='mysql://root@127.0.0.1:1/run'\nexport ORM_RUN_POSTGRES_DSN='postgres://root@127.0.0.1:2/run'\n", /drop: .* names no ORM_TEST_MYSQL_REPLICA_DSN/);
    run('create', "export ORM_RUN_MYSQL_DSN='mysql://root@127.0.0.1:1/run'\nexport ORM_RUN_POSTGRES_DSN='postgres://root@127.0.0.1:2/run'\nexport BROKEN=yes\n", /create: .* unexpected environment line: export BROKEN=yes/, 2);
    run('create', 'MISSING', /create: .* ENOENT/, 2);
    run('create', 'DIRECTORY', /create: .* EISDIR/, 2);
    run('create', 'INVALID', /create: .* unexpected environment line/, 2);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// The drop case (G5.53) checks whether the PostgreSQL database and the run directory are still removed when the MySQL database cannot be dropped.
caseTest('dropping the run databases removes every part after a failed one and names the failures', PROCESS, () => {
  const f = fake(['mysql', 'psql'], 'DROP DATABASE IF EXISTS `orm_x_bench`');
  try {
    const servers = join(f.base, 'servers.env');
    writeFileSync(servers, "export ORM_RUN_MYSQL_DSN='mysql://root@127.0.0.1:1/orm_run'\nexport ORM_RUN_POSTGRES_DSN='postgres://orm@127.0.0.1:2/orm_run'\nexport ORM_TEST_MYSQL_REPLICA_DSN='mysql://root@127.0.0.1:3/orm_test'\nexport ORM_RUN_SQLITE_QUERY=''\n");
    const dir = join(f.base, 'databases');
    mkdirSync(dir);
    // The server file supplies the replica needed to purge its binary logs.
    const result = f.run(['scripts/check/databases.mts', 'drop', servers, dir, 'orm_x']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(f.ran().map(line => line.split(' ')[0]), ['mysql', 'psql', 'mysql', 'mysql']);
    assert.ok(!existsSync(dir), 'the run directory is left');
    assert.match(result.stderr, /databases: drop failed:\n {2}mysql /);
    assert.match(result.stderr, /\n {2}purge the binary logs \(exit 1\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// The binary log case (G5.55-1) checks whether the run's last step (databases.mts drop) removes the binary log files of the two MySQL servers only after the replica has applied
// them, and fails without deleting them if the replica could not apply them. The fake mysql tells the primary (1) and
// the replica (3) apart by port and gives fixed answers to status queries. The real servers are used by the drop step of make owner-check.
caseTest('dropping the run databases purges the binary logs that the replica applied', PROCESS, () => {
  for (const applied of ['7', 'NULL']) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'continue-')));
    try {
      mkdirSync(join(base, 'bin'));
      const log = join(base, 'ran.log');
      writeFileSync(join(base, 'bin', 'mysql'), `#!/bin/sh
for a in "$@"; do last=$a; done
case "$*" in *"-P 1 "*) server=primary ;; *) server=replica ;; esac
echo "$server $last" >> ${log}
case "$last" in
'SHOW BINARY LOG STATUS') [ $server = primary ] && printf 'binlog.000012\t157\t\t\t\n' || printf 'binlog.000031\t157\t\t\t\n' ;;
*SOURCE_POS_WAIT*) echo ${applied} ;;
esac
`, { mode: 0o755 });
      writeFileSync(join(base, 'bin', 'psql'), '#!/bin/sh\n', { mode: 0o755 });
      const servers = join(base, 'servers.env');
      writeFileSync(servers, "export ORM_RUN_MYSQL_DSN='mysql://root@127.0.0.1:1/orm_run'\nexport ORM_RUN_POSTGRES_DSN='postgres://orm@127.0.0.1:2/orm_run'\nexport ORM_RUN_SQLITE_QUERY=''\nexport ORM_TEST_MYSQL_REPLICA_DSN='mysql://root@127.0.0.1:3/orm_test'\n");
      const result = spawnSync(process.execPath, ['scripts/check/databases.mts', 'drop', servers, join(base, 'databases'), 'orm_x'], { cwd: repo, encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(base, 'bin')}:${process.env.PATH}` }) });
      const ran = readFileSync(log, 'utf8').trim().split('\n');
      assert.ok(!(result.stdout + result.stderr).includes('127.0.0.1'), 'no DSN or address is printed');
      if (applied === '7') {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(ran.slice(1), ['primary FLUSH BINARY LOGS', 'primary SHOW BINARY LOG STATUS', "replica SELECT IFNULL(SOURCE_POS_WAIT('binlog.000012', 157, 120), 'NULL')",
          "primary PURGE BINARY LOGS TO 'binlog.000012'", 'replica FLUSH BINARY LOGS; FLUSH RELAY LOGS', 'replica SHOW BINARY LOG STATUS', "replica PURGE BINARY LOGS TO 'binlog.000031'"]);
        assert.match(result.stdout, /databases: binary logs purged up to binlog.000012 on the primary and binlog.000031 on the replica/);
      } else {
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.ok(!ran.some(line => line.includes('PURGE')), ran.join('\n'));
        assert.match(result.stderr, /the replica did not apply the primary's binary log up to binlog.000012:157 \(SOURCE_POS_WAIT returned NULL\); the binary logs are kept/);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

// The finished-run case (G5.59) checks whether databases of runs killed before they started are removed. The fake mysql and psql list databases
// and log DROP. Only the orm_owner_ and orm_check_ databases of ended pids are removed; the databases of a live pid (this test
// process), CI names, and other databases are kept.
caseTest('a run first drops the databases of runs whose process no longer runs', PROCESS, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'continue-')));
  try {
    const dead = spawnSync('true').pid;
    const live = process.pid;
    const names = [`orm_owner_${dead}_ab12cd34_bench`, `orm_owner_${dead}_ab12cd34_decimal`, `orm_check_${dead}_0f0f0f0f_bench`,
      `orm_owner_${live}_ab12cd34_bench`, 'orm_check_ci_1001_1_bench', 'orm_test', 'orm_run'];
    mkdirSync(join(base, 'bin'));
    const log = join(base, 'ran.log');
    for (const program of ['mysql', 'psql'])
      writeFileSync(join(base, 'bin', program), `#!/bin/sh
for a in "$@"; do last=$a; done
case "$last" in
'SHOW DATABASES'|'SELECT datname FROM pg_database') printf '%s\\n' ${names.join(' ')} ;;
DROP*) echo "${program} $last" >> ${log} ;;
esac
`, { mode: 0o755 });
    const servers = join(base, 'servers.env');
    writeFileSync(servers, "export ORM_RUN_MYSQL_DSN='mysql://root@127.0.0.1:1/orm_run'\nexport ORM_RUN_POSTGRES_DSN='postgres://orm@127.0.0.1:2/orm_run'\nexport ORM_RUN_SQLITE_QUERY=''\n");
    const result = spawnSync(process.execPath, ['scripts/check/databases.mts', 'drop-dead', servers, join(base, 'databases'), 'orm_x'], { cwd: repo, encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(base, 'bin')}:${process.env.PATH}` }) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const dropped = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(dropped, [
      ...names.slice(0, 3).map(name => `mysql DROP DATABASE IF EXISTS \`${name}\``),
      ...names.slice(0, 3).map(name => `psql DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    ]);
    assert.match(result.stdout, new RegExp(`databases: dropped the MySQL database orm_owner_${dead}_ab12cd34_bench of run pid ${dead}, which no longer runs`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The lane-name case (G5.54) checks that when ORM_CLIENT_DB_LANGS holds a name that is not a lane, or selects no lane at all, it fails without running
// anything. A misspelled name passed without running any lane.
caseTest('client-db-test refuses an unknown lane name and an empty selection', PROCESS, () => {
  const f = fake(['php', 'node'], 'none');
  try {
    const typo = f.run(['scripts/client-db-test.mts'], { ORM_RUST_TEST_FEATURES: 'none', ORM_CLIENT_DB_LANGS: 'typscript' });
    assert.equal(typo.status, 2, typo.stdout + typo.stderr);
    assert.match(typo.stderr, /client-db-test: ORM_CLIENT_DB_LANGS names typscript, which is no lane; the lanes are go, php, typescript and rust/);
    const empty = f.run(['scripts/client-db-test.mts'], { ORM_RUST_TEST_FEATURES: 'none', ORM_CLIENT_DB_LANGS: ',' });
    assert.equal(empty.status, 2, empty.stdout + empty.stderr);
    assert.match(empty.stderr, /selects no lane/);
    assert.ok(!existsSync(join(f.base, 'ran.log')), 'a lane ran');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

