// scripts/test-servers.sh의 server 정지 test다. make test-servers-check가 tests/stop-process와 tests/lease를
// build하고 그 경로를 STOP_PROCESS와 LEASE로 준다.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../tests/testcase.mjs';

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
