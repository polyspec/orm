// Tests the build-phase arguments of tests/go-test.mts. The run flag is removed from the build, and the package, build tag and
// build flags remain.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildArguments, packages, testEvents } from '../../tests/go-test.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { execFailure } from '../../tests/errors.mts';

caseTest('the build step keeps packages and build flags and runs no test', COMPUTE, () => {
  assert.deepEqual(buildArguments(['-v', '-timeout', '0', '-tags', 'physical', './packages/go/internal/dialects', '-run', '^(TestA|TestB)$', '-count=1']),
    ['-tags', 'physical', './packages/go/internal/dialects', '-run', '^$', '-count=1']);
  assert.deepEqual(buildArguments(['-v', '-timeout=0', '-count', '1', '-race', './packages/go/...', '-run=X']), ['-race', './packages/go/...', '-run', '^$', '-count=1']);
  assert.equal(packages(['-v', './packages/go/orm', './packages/go/orm/pg', '-run', 'X']), 'packages/go/orm,packages/go/orm/pg');
  assert.equal(packages(['-v']), '.');
});

// A slow but normal build runs to the end with no deadline. The fake go at the front of PATH, in the build phase (-run '^$'),
// waits 1.5 s between compiler lines and ends with 0 (with FAKE_GO_FAIL it ends with 2, along with an error line), and in the run
// phase it emits the test output of go test -json. The build phase reports the go output lines and `ok - <case>`, and after that
// the run phase follows. A failed build reports the error line, `not ok` and its reason, and does not start the run phase.
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
  *) echo "=== RUN   TestFixture"; echo "--- PASS: TestFixture (0.00s)" ;;
esac
`);
    await chmod(join(dir, 'go'), 0o755);
    const script = new URL('../../tests/go-test.mts', import.meta.url).pathname;
    const run = async (extra: Record<string, string>) => {
      try {
        const { stdout } = await promisify(execFile)(process.execPath, [script, '-v', '-timeout', '0', './engine', '-count=1'],
          { env: isolatedEnvironment({ ...extra, PATH: `${dir}:${process.env.PATH}` }) });
        return { code: 0, stdout };
      } catch (error) {
        const { code, stdout } = execFailure(error);
        return { code, stdout };
      }
    };
    const lines = (text: string) => text.split('\n').filter(Boolean);
    const passed = await run({});
    assert.equal(passed.code, 0, passed.stdout);
    // The build's output is go's own output, and the case's result is the TAP line of runLong; the run's output is test2json's.
    const expected = ['# orm/engine', 'ok  orm/engine 0.010s \\[no tests to run\\]', 'exit 0', 'ok - go-build/engine',
      '=== RUN   TestFixture', '--- PASS: TestFixture \\(0\\.00s\\)'];
    assert.equal(lines(passed.stdout).length, expected.length, passed.stdout);
    lines(passed.stdout).forEach((line: string, index) => assert.match(line, new RegExp(`^${expected[index]}$`), passed.stdout));
    const failed = await run({ FAKE_GO_FAIL: '1' });
    assert.equal(failed.code, 1, failed.stdout);
    assert.match(failed.stdout, /engine\/x\.go:1: undefined: y\nnot ok - go-build\/engine\n# go test build exited with 2\n$/);
    assert.doesNotMatch(failed.stdout, /TestFixture/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// The empty selection case (G5.54) checks whether a run in which `-run` selects no test counts as a failure. A `-run` with a misspelled name
// makes go test end with 0 without running any test, so it passes without testing anything. It runs with the real go test of a temporary module.
caseTest('a go test run whose -run selects no test fails', PROCESS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-go-empty-'));
  try {
    await writeFile(join(dir, 'go.mod'), 'module example.com/empty\n\ngo 1.21\n');
    await writeFile(join(dir, 'a_test.go'), 'package empty\n\nimport "testing"\n\nfunc TestPresent(t *testing.T) {}\n');
    const script = new URL('../../tests/go-test.mts', import.meta.url).pathname;
    const run = async (pattern: string) => {
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, '-v', '-timeout', '0', '-run', pattern, '-count=1', '.'], { cwd: dir, env: isolatedEnvironment({ GOFLAGS: '', GOWORK: 'off', GOPROXY: 'off' }) });
        return { code: 0, stdout, stderr };
      } catch (error) {
        return execFailure(error);
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

// The event count case (G5.54) checks whether the number of selected tests is counted from test2json's `run` events, not from the human-readable `=== RUN` lines.
// If Output has `=== RUN` but there is no run event, it is not counted; a run event is counted even without Output. Output is passed along as it is.
caseTest('the selected tests are counted from the run events of test2json', COMPUTE, () => {
  const written: string[] = [];
  const events = testEvents((text: string) => written.push(text));
  events.write('{"Action":"output","Output":"=== RUN   TestText\\n"}\n{"Action":"run","Pack');
  events.write('age":"p","Test":"TestEvent"}\n# build line\n{"Action":"run","Package":"p"}\n{"Action":"build-output","Output":"x.go:1: undefined\\n"}\n');
  events.write('{"Action":"pass","Test":"TestEvent"}');
  events.flush();
  assert.equal(events.runs(), 1);
  assert.deepEqual(written, ['=== RUN   TestText\n', '# build line\n', 'x.go:1: undefined\n']);
});

