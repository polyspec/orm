// tests/go-test.mjs의 build 단계 인자 test다. 실행 flag는 build에서 빠지고, package, build tag와
// build flag는 남는다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildArguments, packages } from './go-test.mjs';
import { caseTest, COMPUTE, PROCESS } from './testcase.mjs';

caseTest('the build step keeps packages and build flags and runs no test', COMPUTE, () => {
  assert.deepEqual(buildArguments(['-v', '-timeout', '0', '-tags', 'physical', './tests/dialects', '-run', '^(TestA|TestB)$', '-count=1']),
    ['-tags', 'physical', './tests/dialects', '-run', '^$', '-count=1']);
  assert.deepEqual(buildArguments(['-v', '-timeout=0', '-count', '1', '-race', './clients/go/...', '-run=X']), ['-race', './clients/go/...', '-run', '^$', '-count=1']);
  assert.equal(packages(['-v', './clients/go/orm', './clients/go/orm/pg', '-run', 'X']), 'clients/go/orm,clients/go/orm/pg');
  assert.equal(packages(['-v']), '.');
});

// 느리지만 정상인 build는 기한 없이 끝까지 실행한다. PATH 앞의 가짜 go는 build 단계(-run '^$')에서
// compiler 줄 사이에 1.5초를 쉬고 0으로 끝나며(FAKE_GO_FAIL이 있으면 오류 줄과 함께 2로 끝난다), 실행
// 단계에서는 case 줄을 출력한다. build 단계는 RUN no-deadline, 출력 줄, exit 0과 PASS를 보고하고 그 뒤
// 실행 단계가 이어진다. 실패한 build는 오류 줄과 종료 코드를 보고하고 실행 단계를 시작하지 않는다.
caseTest('a slow but healthy go test build runs to its end without a deadline', PROCESS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-go-test-'));
  try {
    await writeFile(join(dir, 'go'), `#!/bin/sh
case "$*" in
  *"-run ^$ -count=1"*)
    echo "# orm/engine"
    if [ -n "\${FAKE_GO_FAIL:-}" ]; then echo "engine/x.go:1: undefined: y"; exit 2; fi
    sleep 1.5
    echo "ok  orm/engine 0.010s [no tests to run]" ;;
  *) echo "RUN TestFixture deadline=1m0s"; echo "PASS TestFixture elapsed=1ms" ;;
esac
`);
    await chmod(join(dir, 'go'), 0o755);
    const script = new URL('./go-test.mjs', import.meta.url).pathname;
    const run = async extra => {
      try {
        const { stdout } = await promisify(execFile)(process.execPath, [script, '-v', '-timeout', '0', './engine', '-count=1'],
          { env: { ...process.env, ...extra, PATH: `${dir}:${process.env.PATH}` } });
        return { code: 0, stdout };
      } catch (error) {
        return { code: error.code, stdout: error.stdout };
      }
    };
    const elapsed = 'elapsed=[0-9.]+(µs|ms|s|m[0-9.]+s)';
    const lines = text => text.split('\n').filter(Boolean);
    const passed = await run({});
    assert.equal(passed.code, 0, passed.stdout);
    const expected = [`RUN go-build/engine no-deadline`, `STEP go-build/engine ${elapsed}: # orm/engine`,
      `STEP go-build/engine ${elapsed}: ok  orm/engine 0.010s \\[no tests to run\\]`, `STEP go-build/engine ${elapsed}: exit 0`,
      `PASS go-build/engine elapsed=(1\\.[5-9][0-9]*|[2-9](\\.[0-9]+)?)s`, 'RUN TestFixture deadline=1m0s', 'PASS TestFixture elapsed=1ms'];
    assert.equal(lines(passed.stdout).length, expected.length, passed.stdout);
    lines(passed.stdout).forEach((line, index) => assert.match(line, new RegExp(`^${expected[index]}$`), passed.stdout));
    const failed = await run({ FAKE_GO_FAIL: '1' });
    assert.equal(failed.code, 1, failed.stdout);
    assert.match(failed.stdout, /STEP go-build\/engine [^:]*: engine\/x\.go:1: undefined: y\nFAIL go-build\/engine [^:]*: go test build exited with 2\n$/);
    assert.doesNotMatch(failed.stdout, /TestFixture/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
