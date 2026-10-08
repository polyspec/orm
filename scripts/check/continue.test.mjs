// 전체 suite의 target 안에서 실패한 명령 뒤에도 독립된 다음 명령이 실행되는지 검사한다(G5.38-3). 각 case는
// 실제 script를 실행하되 PATH의 앞에 둔 가짜 php와 node가 자기 인자를 log에 적고 첫 test에서 실패한다. 실제 test와
// database는 실행하지 않는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, PROCESS } from '../../tests/testcase.mjs';
import { isolatedEnvironment } from '../../tests/environment.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// fake는 program마다 인자를 log에 적고, 인자가 failing을 담으면 출력 한 줄과 함께 3으로 끝나는 가짜 program을 둔다.
function fake(programs, failing) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'continue-')));
  mkdirSync(join(base, 'bin'));
  const log = join(base, 'ran.log');
  for (const program of programs)
    writeFileSync(join(base, 'bin', program), `#!/bin/sh\necho "${program} $*" >> ${log}\ncase "$*" in *'${failing}'*) echo 'FAIL ${failing}: expected 1 row, actual 0'; exit 3;; esac\n`, { mode: 0o755 });
  return {
    base,
    run: (args, env = {}) => spawnSync('sh', args, { cwd: repo, encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(base, 'bin')}:${process.env.PATH}`, ...env }) }),
    ran: () => readFileSync(log, 'utf8').trim().split('\n'),
  };
}

caseTest('the PHP lane of client-db-test runs every test after a failed one and names the failures', PROCESS, () => {
  const f = fake(['php'], 'model_test');
  try {
    const result = f.run(['scripts/client-db-test.sh', '--lane', 'php'], { ORM_RUST_TEST_FEATURES: 'none' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const ran = f.ran();
    assert.equal(ran.length, 11, ran.join('\n'));
    assert.deepEqual([ran[0], ran.at(-1)], ['php packages/orm-php/tests/model_test.php', 'php packages/orm-php/tests/mysql_tls.php']);
    assert.match(result.stderr, /client-db-test: the php lane failed:\n {2}php packages\/orm-php\/tests\/model_test\.php \(exit 3\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

caseTest('the TypeScript SQLite tests run every test after a failed one and name the failures', PROCESS, () => {
  const f = fake(['node'], 'model.mjs');
  try {
    const result = f.run(['scripts/typescript/sqlite-test.sh']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const ran = f.ran();
    assert.equal(ran.length, 10, ran.join('\n'));
    assert.deepEqual([ran[1], ran.at(-1)], ['node packages/orm-npm/tests/model.mjs', 'node packages/orm-npm/tests/mysql_tls.mjs']);
    assert.match(result.stderr, /sqlite-test: failed:\n {2}node packages\/orm-npm\/tests\/model\.mjs \(exit 3\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// 차례 lane case(G5.53)는 lane을 병렬이 아니라 차례로 실행할 때 실패한 lane 뒤의 lane도 실행되는지 본다. 각 lane은 자기
// subshell에서 실행되므로 앞 lane의 finish가 실행 전체를 끝내지 않는다.
caseTest('client-db-test runs the next lane after a failed lane in sequence and names the failed lanes', PROCESS, () => {
  const f = fake(['php', 'node'], 'model_test');
  try {
    const result = f.run(['scripts/client-db-test.sh'], { ORM_RUST_TEST_FEATURES: 'none', ORM_CLIENT_DB_LANGS: 'php,typescript', ORM_CLIENT_DB_LANES: '' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const ran = f.ran();
    assert.ok(ran.includes('node packages/orm-npm/tests/model.mjs'), ran.join('\n'));
    assert.match(result.stderr, /client-db-test: failed lanes: php\n/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// perf case(G5.53)는 performance gate의 네 측정이 앞의 측정이 실패해도 모두 실행되는지 본다.
caseTest('the performance gates run every gate after a failed one and name the failures', PROCESS, () => {
  const f = fake(['node', 'php'], 'TestNative');
  try {
    const result = f.run(['scripts/perf-test.sh']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.ran().length, 4, f.ran().join('\n'));
    assert.match(result.stderr, /perf-test: failed:\n {2}node tests\/go-test\.mjs .*TestNative.* \(exit 3\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// package case(G5.53)는 package 검사 넷(TypeScript, PHP, Rust, Go)이 앞의 검사가 실패해도 모두 실행되는지 본다.
caseTest('the package checks run every package after a failed one and name the failures', PROCESS, () => {
  const f = fake(['npm', 'node', 'composer', 'cargo', 'go'], 'pack');
  try {
    writeFileSync(join(f.base, 'bin', 'lease'), '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    // HOME은 가짜 bin 앞에 $HOME/.cargo/bin을 두는 script가 실제 cargo를 고르지 않게 한다.
    const result = f.run(['scripts/package-check.sh'], { HOME: f.base, CARGO_TARGET_DIR: join(f.base, 'target'), LEASE: join(f.base, 'bin', 'lease'), CARGO_LEASES: join(f.base, 'leases') });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const ran = f.ran().map(line => line.split(' ')[0]);
    for (const program of ['composer', 'cargo', 'go']) assert.ok(ran.includes(program), `${program} did not run: ${ran.join(' ')}`);
    assert.match(result.stderr, /package-check: failed:\n {2}typescript package/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// drop case(G5.53)는 MySQL database를 지우지 못해도 PostgreSQL database와 실행 directory를 지우는지 본다.
caseTest('dropping the run databases removes every part after a failed one and names the failures', PROCESS, () => {
  const f = fake(['mysql', 'psql'], 'DROP DATABASE IF EXISTS `orm_x_bench`');
  try {
    const servers = join(f.base, 'servers.env');
    writeFileSync(servers, "export ORM_RUN_MYSQL_DSN='mysql://root@127.0.0.1:1/orm_run'\nexport ORM_RUN_POSTGRES_DSN='postgres://orm@127.0.0.1:2/orm_run'\nexport ORM_RUN_SQLITE_QUERY=''\n");
    const dir = join(f.base, 'databases');
    mkdirSync(dir);
    // 이 case의 servers file에는 replica가 없다. 바깥 실행의 환경이 준 replica도 쓰지 않는다.
    const result = f.run(['scripts/check/databases.sh', 'drop', servers, dir, 'orm_x'], { ORM_TEST_MYSQL_REPLICA_DSN: '' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(f.ran().map(line => line.split(' ')[0]), ['mysql', 'psql']);
    assert.ok(!existsSync(dir), 'the run directory is left');
    assert.match(result.stderr, /databases: drop failed:\n {2}mysql /);
    assert.match(result.stderr, /\n {2}purge the binary logs \(exit 1\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// binary log case(G5.55-1)는 실행의 마지막 단계(databases.sh drop)가 MySQL 두 server의 binary log를 replica가 적용을
// 마친 file까지 지우는지, replica가 적용하지 못했으면 지우지 않고 실패하는지 본다. 가짜 mysql은 port로 primary(1)와
// replica(3)를 구분하고 상태 질의에 정해진 답을 낸다. 실제 server는 make owner-check의 drop 단계가 쓴다.
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
      const result = spawnSync('sh', ['scripts/check/databases.sh', 'drop', servers, join(base, 'databases'), 'orm_x'], { cwd: repo, encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(base, 'bin')}:${process.env.PATH}` }) });
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

// 끝난 실행 case(G5.59)는 실행을 만들기 전에 kill된 실행의 database를 지우는지 본다. 가짜 mysql과 psql은 database
// 목록을 내고 DROP을 log에 적는다. 끝난 pid의 orm_owner_와 orm_check_ database만 지우고, 살아 있는 pid(이 test
// process)의 것, CI 이름, 다른 database는 남긴다.
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
    const result = spawnSync('sh', ['scripts/check/databases.sh', 'drop-dead', servers, join(base, 'databases'), 'orm_x'], { cwd: repo, encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(base, 'bin')}:${process.env.PATH}` }) });
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

// lane 이름 case(G5.54)는 ORM_CLIENT_DB_LANGS가 lane이 아닌 이름을 담거나 lane을 하나도 고르지 않으면 실행하지 않고
// 실패하는지 본다. 잘못 쓴 이름은 아무 lane도 실행하지 않고 통과했다.
caseTest('client-db-test refuses an unknown lane name and an empty selection', PROCESS, () => {
  const f = fake(['php', 'node'], 'none');
  try {
    const typo = f.run(['scripts/client-db-test.sh'], { ORM_RUST_TEST_FEATURES: 'none', ORM_CLIENT_DB_LANGS: 'typscript' });
    assert.equal(typo.status, 2, typo.stdout + typo.stderr);
    assert.match(typo.stderr, /client-db-test: ORM_CLIENT_DB_LANGS names typscript, which is no lane; the lanes are go, php, typescript and rust/);
    const empty = f.run(['scripts/client-db-test.sh'], { ORM_RUST_TEST_FEATURES: 'none', ORM_CLIENT_DB_LANGS: ',' });
    assert.equal(empty.status, 2, empty.stdout + empty.stderr);
    assert.match(empty.stderr, /selects no lane/);
    assert.ok(!existsSync(join(f.base, 'ran.log')), 'a lane ran');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

