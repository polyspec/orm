// tests/go-test.mjs의 build 단계 인자 test다. 실행 flag는 build에서 빠지고, package, build tag와
// build flag는 남는다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildArguments, packages, testEvents } from './go-test.mjs';
import { isolatedEnvironment } from './environment.mjs';
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
          { env: isolatedEnvironment({ ...extra, PATH: `${dir}:${process.env.PATH}` }) });
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

// 빈 선택 case(G5.54)는 `-run`이 test를 하나도 고르지 않는 실행을 실패로 보는지 본다. 이름을 잘못 쓴 `-run`은 test를
// 실행하지 않고도 go test를 0으로 끝내므로 아무것도 시험하지 않은 채 통과한다. 임시 module의 실제 go test로 실행한다.
caseTest('a go test run whose -run selects no test fails', PROCESS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-go-empty-'));
  try {
    await writeFile(join(dir, 'go.mod'), 'module example.com/empty\n\ngo 1.21\n');
    await writeFile(join(dir, 'a_test.go'), 'package empty\n\nimport "testing"\n\nfunc TestPresent(t *testing.T) {}\n');
    const script = new URL('./go-test.mjs', import.meta.url).pathname;
    const run = async pattern => {
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, '-v', '-timeout', '0', '-run', pattern, '-count=1', '.'], { cwd: dir, env: isolatedEnvironment({ GOFLAGS: '', GOWORK: 'off', GOPROXY: 'off' }) });
        return { code: 0, stdout, stderr };
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    };
    const none = await run('^TestNoSuchName$');
    assert.equal(none.code, 1, none.stdout + none.stderr);
    assert.match(none.stderr, /go-test: -run \^TestNoSuchName\$ selected no test in \.\n/);
    const one = await run('^TestPresent$');
    assert.equal(one.code, 0, one.stdout + one.stderr);
    assert.match(one.stdout, /=== RUN {3}TestPresent/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// event 수 case(G5.54)는 고른 test의 수를 사람이 읽는 `=== RUN` 줄이 아니라 test2json의 `run` event로 세는지 본다.
// Output에 `=== RUN`이 있어도 run event가 없으면 세지 않고, run event는 Output 없이도 센다. Output은 그대로 잇는다.
caseTest('the selected tests are counted from the run events of test2json', COMPUTE, () => {
  const written = [];
  const events = testEvents(text => written.push(text));
  events.write('{"Action":"output","Output":"=== RUN   TestText\\n"}\n{"Action":"run","Pack');
  events.write('age":"p","Test":"TestEvent"}\n# build line\n{"Action":"run","Package":"p"}\n{"Action":"build-output","Output":"x.go:1: undefined\\n"}\n');
  events.write('{"Action":"pass","Test":"TestEvent"}');
  events.flush();
  assert.equal(events.runs(), 1);
  assert.deepEqual(written, ['=== RUN   TestText\n', '# build line\n', 'x.go:1: undefined\n']);
});

