// scripts/test-servers.sh의 server 정지 test다. make test-servers-check가 tests/stop-process를 build하고 그
// 경로를 STOP_PROCESS로 준다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
