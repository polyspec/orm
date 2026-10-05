// make check의 runner다. 실행마다 자기 bench database와 decimal database를 만들어
// (scripts/check/databases.sh) 모든 target이 그것을 쓰게 하고, target을 하나씩 `make <target>`으로
// 실행한 뒤 database를 지운다. 공유 database에 다른 실행이나 session이 남긴 상태에 기대지 않기
// 위해서다.
//
// target 하나는 저마다 기한을 가진 case의 묶음이므로 runGroup으로 "RUN check/<target> group",
// 그 target의 출력 줄(STEP), PASS나 FAIL과 경과 시간을 보고한다. 각 target 앞에는 disk의 남은
// 공간을 단계로 출력한다. 실패한 target이 있어도 나머지 target을 실행해 한 번의 실행에서 모든
// 결과를 보이고, 끝에 target마다 결과와 경과 시간을 다시 출력하며 실패가 있으면 1로 끝난다.
//
// Usage: node scripts/check/run.mjs <servers env> <target>...
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { duration, runGroup, stepLines } from '../../tests/testcase.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const [serversArgument, ...targets] = process.argv.slice(2);
if (!serversArgument || targets.length === 0 || targets.some(target => !/^[a-z0-9-]+$/.test(target))) {
  console.error('usage: node scripts/check/run.mjs <servers env> <target>...');
  process.exit(2);
}
const servers = resolve(serversArgument);
// 실행의 이름은 process id와 임의의 값이다. 같은 이름의 database가 있으면 그것은 이 실행이 만든
// 것이 아니므로 bench-db.sh가 지우지 않도록 이름이 겹치지 않아야 한다.
const name = `orm_check_${process.pid}_${randomBytes(4).toString('hex')}`;
const directory = resolve(root, '.runtime/check', name);
const testEnv = resolve(directory, 'env');
const decimalEnv = resolve(directory, 'decimal-env');

// command는 program을 실행하고 출력 줄을 단계로 내보낸다. make의 MAKEFLAGS는 넘기지 않는다:
// 하위 make는 이 runner가 주는 TEST_ENV와 DECIMAL_ENV만 받는다.
const command = (program, args, step) => new Promise((finish, fail) => {
  const env = { ...process.env };
  for (const variable of ['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES']) delete env[variable];
  const child = spawn(program, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = stepLines(step);
  child.stdout.on('data', chunk => lines.write(String(chunk)));
  child.stderr.on('data', chunk => lines.write(String(chunk)));
  child.on('error', fail);
  child.on('close', code => {
    lines.flush();
    if (code === 0) finish();
    else fail(new Error(`${program} ${args[0]} exited with ${code}`));
  });
});

const results = [];
const record = async (label, body) => {
  const started = performance.now();
  const passed = await runGroup(`check/${label}`, body);
  results.push({ label, passed, elapsed: performance.now() - started });
  return passed;
};

const created = await record('databases/create', ({ step }) =>
  command('sh', ['scripts/check/databases.sh', 'create', servers, directory, name], step));
if (created) {
  for (const target of targets) {
    await record(target, async ({ step }) => {
      const disk = await statfs(root);
      step(`free disk ${(disk.bavail * disk.bsize / 2 ** 30).toFixed(1)} GiB`);
      // 하위 make는 MAKEFLAGS를 받지 않으므로, 이 runner를 실행한 make의 CARGO_TARGET_DIR(worktree가 main checkout의
      // target directory를 쓸 때 그 값)도 command line으로 넘긴다. 그렇지 않으면 Makefile이 자기 checkout의
      // target directory를 정한다.
      const targetDir = process.env.CARGO_TARGET_DIR ? [`CARGO_TARGET_DIR=${process.env.CARGO_TARGET_DIR}`] : [];
      await command('make', ['--no-print-directory', `TEST_ENV=${testEnv}`, `DECIMAL_ENV=${decimalEnv}`, ...targetDir, target], step);
    });
  }
}
// database는 만들기가 중간에 실패해도 만든 만큼 지운다.
await record('databases/drop', ({ step }) =>
  command('sh', ['scripts/check/databases.sh', 'drop', servers, directory, name], step));

for (const { label, passed, elapsed } of results)
  console.log(`check: ${passed ? 'PASS' : 'FAIL'} ${label} elapsed=${duration(elapsed)}`);
const failed = results.filter(result => !result.passed);
if (failed.length) {
  console.log(`check: ${failed.length} of ${results.length} step(s) failed`);
  process.exitCode = 1;
}
