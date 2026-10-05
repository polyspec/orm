// scripts/test-servers.sh의 server 정지 test다. make test-servers-check가 tests/stop-process와 tests/lease를
// build하고 그 경로를 STOP_PROCESS와 LEASE로 준다.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { caseTest, COMPUTE, DATABASE } from '../tests/testcase.mjs';

// stop_pid case는 test-servers.sh의 stop_pid를 그대로 꺼내 가짜 서버를 멈춘다. 서버 정지는 장기 작업이므로
// 기한이 없고, 끝났는지는 polling이 아니라 운영체제의 종료 사건으로 안다. TERM을 받고 1.5초 뒤에야 끝나는
// 느리지만 정상인 서버는 그 뒤에 멈춘 것으로 보고되고, 그때 process는 이미 없다.
caseTest('stop_pid waits for the exit event of the server, with no polling', COMPUTE, () => {
  const script = readFileSync(new URL('./test-servers.sh', import.meta.url), 'utf8');
  const start = script.indexOf('stop_pid() {');
  const body = script.slice(start, script.indexOf('\n}\n', start) + 3);
  assert.ok(start >= 0 && body.endsWith('}\n'), 'stop_pid is absent from scripts/test-servers.sh');
  assert.doesNotMatch(body, /\bsleep\b|\bwhile\b|\buntil\b|kill -0/, 'stop_pid polls for the exit');
  assert.match(body, /"\$\{STOP_PROCESS:\?/, 'stop_pid does not run the Go program STOP_PROCESS of tests/stop-process');
  const stopProcess = process.env.STOP_PROCESS;
  assert.ok(stopProcess, 'STOP_PROCESS is unset; run make test-servers-check, which builds it');
  const dir = mkdtempSync(join(tmpdir(), 'orm-stop-'));
  try {
    for (const [name, delay] of [['quick', 0], ['slow', 1.5]]) {
      // 서버는 TERM의 trap을 둔 뒤 FIFO에 준비를 쓰고, 바깥 shell은 그 쓰기를 읽어 시작을 안다.
      const pidFile = join(dir, `${name}.pid`), ready = join(dir, `${name}.ready`);
      const server = spawnSync('sh', ['-c', `mkfifo ${ready}
sh -c 'trap "sleep ${delay}; kill \\$child; exit 0" TERM; sleep 30 & child=$!; echo ready > ${ready}; wait' >/dev/null 2>&1 &
echo $! > ${pidFile}
read state < ${ready}`], { timeout: 10_000 });
      assert.equal(server.status, 0, String(server.stderr));
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      const started = Date.now();
      const stopped = spawnSync('sh', ['-c', `set -eu\nSTOP_PROCESS=${stopProcess}\n${body}\nstop_pid ${pidFile}\necho stopped`], { encoding: 'utf8', timeout: 20_000 });
      const elapsed = Date.now() - started;
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.equal(stopped.stdout, 'stopped\n');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${name} server still runs after stop_pid`);
      assert.ok(elapsed >= delay * 1000, `${name} server reported stopped after ${elapsed} ms, before its ${delay} s shutdown`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// lease case는 이 checkout의 script를 임시 root로 복사하고, 다른 실행이 서버의 shared lease를 가진 동안
// `test-servers.sh stop`이 그 보유자를 적으며 거부되고 서버 directory를 남기는지, 보유가 끝나면 정지가
// 진행되는지 확인한다. 보유자는 FIFO를 읽으며 기다리는 shell이고, 준비와 끝은 FIFO로 알린다.
caseTest('stopping the test servers is refused while another run holds a lease, naming the holder', COMPUTE, () => {
  const { LEASE: lease, STOP_PROCESS: stopProcess } = process.env;
  assert.ok(lease && stopProcess, 'LEASE or STOP_PROCESS is unset; run make test-servers-check, which builds them');
  const root = mkdtempSync(join(tmpdir(), 'orm-lease-'));
  const release = join(root, 'release');
  const ready = join(root, 'ready');
  const leases = join(root, '.runtime/servers.leases');
  let holder;
  const stop = () => spawnSync('sh', [join(root, 'scripts/test-servers.sh'), 'stop'], { encoding: 'utf8', env: { ...process.env, LEASE: lease, STOP_PROCESS: stopProcess } });
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('./test-servers.sh', import.meta.url), join(root, 'scripts/test-servers.sh'));
    mkdirSync(join(root, '.runtime/servers'), { recursive: true });
    execFileSync('mkfifo', [release, ready]);
    holder = spawn('sh', ['-c', `${lease} hold ${leases} shared --pid $$ && echo held > ${ready} && read line < ${release}`], { stdio: 'ignore' });
    assert.equal(execFileSync('sh', ['-c', `read state < ${ready}; echo $state`], { encoding: 'utf8' }), 'held\n');
    const refused = stop();
    assert.equal(refused.status, 3, refused.stdout + refused.stderr);
    assert.match(refused.stderr, new RegExp(`^lease: refused the exclusive lease of ${leases.replace(/[.]/g, '\\.')}; held by:\n  shared lease of pid ${holder.pid} \\(running\\) from \\S+ since \\S+: sh -c `));
    assert.ok(existsSync(join(root, '.runtime/servers')), 'the refused stop removed the servers directory');
    execFileSync('sh', ['-c', `echo done > ${release}`]);
    // 보유자 shell이 끝나면 releaser가 lease를 지운다. 그 뒤의 정지는 lease directory의 변경 알림을 기다리지
    // 않고 곧바로 시도하므로, lease가 지워질 때까지 `lease run --wait`로 기다린 다음 정지한다.
    execFileSync(lease, ['run', leases, 'exclusive', '--wait', '--', 'true']);
    const stopped = stop();
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.match(stopped.stdout, /test-servers: removed .*\.runtime\/servers\n$/);
    assert.ok(!existsSync(join(root, '.runtime/servers')), 'the stop left the servers directory');
  } finally {
    // 실패한 case가 남긴 보유자는 끝낸다. 보유자가 끝나면 releaser가 lease를 지운다.
    if (holder?.exitCode === null) holder.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// 겹친 lease case는 exclusive를 가진 process 아래에서 동시에 실행되는 하위 process들(make feature-check의
// 기능 단계들처럼)이 그 보유를 함께 쓰지 않고 그 안에서 다시 나누어 가지는지 확인한다. 바깥 shell이 exclusive를
// 가진 채 하위 shell A가 exclusive를 얻고 FIFO를 읽으며 기다리는 동안, 다른 하위 shell의 exclusive와 shared는
// A를 보유자로 적으며 거부된다. A가 끝나면 --wait인 하위 shell이 얻고, 같은 process가 다시 얻는 일은 그 보유를
// 그대로 쓴다. 그 뒤 바깥 shell 아래의 하위 shell 두 개는 shared를 함께 가진다. 하위 shell의 보유는 그
// process가 끝난 뒤 releaser가 지우므로, 앞선 보유 뒤의 첫 hold는 --wait로 그 해제를 기다린다.
caseTest('children of an exclusive holder share its lease one exclusive holder at a time', COMPUTE, () => {
  const { LEASE: lease } = process.env;
  assert.ok(lease, 'LEASE is unset; run make test-servers-check, which builds it');
  const root = mkdtempSync(join(tmpdir(), 'orm-lease-nested-'));
  const leases = join(root, 'leases');
  try {
    const script = `set -u
L=${lease}; D=${leases}; R=${root}
mkfifo "$R/held" "$R/release"
"$L" hold "$D" exclusive --pid $$ || exit 9
sh -c '"$1" hold "$2" exclusive --pid $$ && echo held > "$3/held" && read line < "$3/release"' a "$L" "$D" "$R" &
read state < "$R/held"
sh -c '"$1" hold "$2" exclusive --pid $$' b "$L" "$D" 2> "$R/exclusive.err"; echo "exclusive=$?"
sh -c '"$1" hold "$2" shared --pid $$' c "$L" "$D" 2> "$R/shared.err"; echo "shared=$?"
echo done > "$R/release"; wait
sh -c '"$1" hold "$2" exclusive --wait --pid $$ && "$1" hold "$2" exclusive --pid $$' d "$L" "$D"; echo "after=$?"
sh -c '"$1" hold "$2" shared --wait --pid $$ && echo held > "$3/held" && read line < "$3/release"' e "$L" "$D" "$R" &
read state < "$R/held"
sh -c '"$1" hold "$2" shared --pid $$' f "$L" "$D"; echo "readers=$?"
echo done > "$R/release"; wait
`;
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stdout, 'exclusive=3\nshared=3\nafter=0\nreaders=0\n', run.stderr);
    for (const kind of ['exclusive', 'shared']) {
      assert.match(readFileSync(join(root, `${kind}.err`), 'utf8'),
        new RegExp(`^lease: refused the ${kind} lease of ${leases.replace(/[.]/g, '\\.')}; held by:\n  exclusive lease of pid \\d+ \\(running\\) from \\S+ since \\S+: sh -c `));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 공유 database case는 server 환경 file이 bench database를 정하지 않고, Makefile이 함께 쓰는 decimal
// database를 두지 않는지 확인한다. 그 database는 실행마다 scripts/check/databases.sh가 만든다.
caseTest('the server environment names no bench or decimal database that runs share', COMPUTE, () => {
  const script = readFileSync(new URL('./test-servers.sh', import.meta.url), 'utf8');
  const start = script.indexOf('write_env() {');
  const writeEnv = script.slice(start, script.indexOf('\n}\n', start));
  assert.ok(start >= 0, 'write_env is absent from scripts/test-servers.sh');
  assert.doesNotMatch(writeEnv, /export (?:ORM_)?BENCH_[A-Z_]*=/, 'the server environment names a shared bench database');
  assert.match(writeEnv, /export ORM_RUN_MYSQL_DSN='\$mysql\/orm_run\?timezone=%2B00:00'/);
  assert.doesNotMatch(script, /bench-db\.sh/, 'make test-servers seeds a shared bench database');
  const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8');
  assert.match(makefile, /^DECIMAL_ENV =$/m, 'the Makefile names a shared decimal environment');
  assert.doesNotMatch(makefile, /^decimal-db-setup:/m, 'the Makefile sets up a shared decimal database');
});

// binary log 보존 case는 test-servers.sh가 mysqld에 주는 MYSQLD_BINLOG의 보존 option을 작은 값으로 바꿔 임시
// data directory와 빈 port의 fixture 서버에 주고, 공유 서버는 건드리지 않는다. server는 만료된 binary log를
// 시작할 때와 log를 회전할 때만 지우므로 보존에는 만료 시간과 회전하는 크기가 함께 필요하다. 쓰기 묶음 하나를 쓰고
// 만료 시간보다 오래 기다린 뒤 다시 쓰면 첫 file은 server가 지워야 한다. 남으면 그 file과 남은 이유를 적고 실패한다.
caseTest('the test MySQL server removes an expired binary log by itself', DATABASE, async () => {
  const script = readFileSync(new URL('./test-servers.sh', import.meta.url), 'utf8');
  const declared = /^MYSQLD_BINLOG="([^"]*)"$/m.exec(script)?.[1] ?? '';
  const flags = declared.split(/\s+/).filter(Boolean);
  const expireFlag = flags.find(f => f.startsWith('--binlog-expire-logs-seconds='));
  const sizeFlag = flags.find(f => f.startsWith('--max-binlog-size='));
  // fixture 값: 만료 2초, 크기는 mysqld가 받는 가장 작은 4096 byte다. 선언에 없는 option은 주지 않는다.
  const EXPIRE_SECONDS = 2;
  const fixtureFlags = [`--binlog-expire-logs-seconds=${EXPIRE_SECONDS}`, ...(sizeFlag ? ['--max-binlog-size=4096'] : [])];
  const root = mkdtempSync(join(tmpdir(), 'orm-binlog-'));
  // unix socket 경로는 104 byte를 넘을 수 없으므로 짧은 directory에 둔다.
  const socketDir = mkdtempSync('/tmp/orm-binlog-');
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port: p } = server.address(); server.close(() => resolve(p)); });
  });
  const mysql = sql => execFileSync('mysql', ['--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-N', '-B', '-e', sql], { encoding: 'utf8' });
  const data = join(root, 'data');
  try {
    execFileSync('mysqld', ['--no-defaults', '--initialize-insecure', `--datadir=${data}`, `--log-error=${join(root, 'init.log')}`]);
    // --daemonize는 server가 연결을 받거나 실패한 뒤 돌아온다.
    execFileSync('mysqld', ['--no-defaults', '--daemonize', `--datadir=${data}`, `--pid-file=${join(root, 'mysqld.pid')}`, `--log-error=${join(root, 'mysqld.log')}`,
      '--bind-address=127.0.0.1', `--port=${port}`, `--socket=${join(socketDir, 's')}`, '--mysqlx=OFF', '--server-id=1', ...fixtureFlags]);
    mysql('CREATE DATABASE b; CREATE TABLE b.t (v VARCHAR(1024))');
    const burst = () => { for (let i = 0; i < 10; i++) mysql("INSERT INTO b.t VALUES (REPEAT('x', 1000))"); };
    burst();
    const first = mysql('SHOW BINARY LOGS').trim().split('\n')[0].split('\t');
    // 만료는 file의 마지막 쓰기 시각부터 센다. 그보다 1초 더 기다린다.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (EXPIRE_SECONDS + 1) * 1000);
    burst();
    const logs = mysql('SHOW BINARY LOGS').trim().split('\n').map(l => l.split('\t')[0]);
    const size = mysql('SELECT @@max_binlog_size').trim();
    assert.ok(!logs.includes(first[0]),
      `${first[0]} (${first[1]} bytes, last written more than ${EXPIRE_SECONDS + 1} s ago) is kept past binlog_expire_logs_seconds=${EXPIRE_SECONDS}: ` +
      `the server removes expired logs only when it rotates the log, and max_binlog_size=${size} was never reached` +
      (expireFlag ? '' : '; scripts/test-servers.sh sets no --binlog-expire-logs-seconds') + (sizeFlag ? '' : '; scripts/test-servers.sh sets no --max-binlog-size'));
    // 공유 서버의 두 mysqld가 같은 보존 option을 받는다.
    for (const command of ['--server-id=1', '--server-id=2']) {
      const line = script.split('\n').findIndex(l => l.includes(command));
      assert.ok(line >= 0 && /\$MYSQLD_BINLOG\b/.test(script.split('\n').slice(line - 2, line + 1).join('\n')), `the mysqld with ${command} in scripts/test-servers.sh does not take $MYSQLD_BINLOG`);
    }
  } finally {
    // mysqladmin shutdown over TCP returns before the server exits, and a server whose data directory is removed
    // while it shuts down never exits: InnoDB retries its redo log file in the missing directory and writes an
    // error for every try into its log, which fills the file system of the log. So the case stops the server
    // through STOP_PROCESS, which returns on the exit event of the process, and removes the directories only
    // after that; a server that does not stop fails the case and keeps its directories.
    const pidFile = join(root, 'mysqld.pid');
    if (existsSync(pidFile)) {
      const pid = readFileSync(pidFile, 'utf8').trim();
      const stopped = spawnSync(process.env.STOP_PROCESS ?? '', ['TERM', pid], { encoding: 'utf8' });
      assert.equal(stopped.status, 0, `the fixture mysqld ${pid} did not stop (STOP_PROCESS ${process.env.STOP_PROCESS ?? 'unset'}): ${stopped.error?.message ?? stopped.stderr}; ${root} is kept`);
      assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' }, `mysqld ${pid} still runs after STOP_PROCESS returned; ${root} is kept`);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
});
