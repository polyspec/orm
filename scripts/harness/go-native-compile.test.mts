// CI native compatibility evidence. Compilation finishes outside any timed test case.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE, runLong, stepLines } from '../../tests/testcase.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';

type Result = { code: number | string; stdout: string; stderr: string; mainRuns: number };
const results: Result[] = [];
const directory = await mkdtemp(join(tmpdir(), 'orm-go-native-compile-'));
let prepared = false;
try {
  await writeFile(join(directory, 'go.mod'), 'module example.com/native\n\ngo 1.21\n');
  await writeFile(join(directory, 'native_test.go'), `package native
import ("os"; "testing")
func TestMain(m *testing.M) {
    f, err := os.OpenFile(os.Getenv("ORM_TESTMAIN_TRACE"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
    if err != nil { panic(err) }
    if _, err := f.WriteString("main\\n"); err != nil { panic(err) }
    if err := f.Close(); err != nil { panic(err) }
    os.Exit(m.Run())
}
func TestPresent(t *testing.T) {}
`);
  await mkdir(join(directory, 'broken'));
  await writeFile(join(directory, 'broken', 'broken_test.go'), 'package broken\nimport "testing"\nfunc TestBroken(t *testing.T) { missingSymbol() }\n');
  const script = new URL('../../tests/go-test.mts', import.meta.url).pathname;
  const trace = join(directory, 'trace');
  prepared = await runLong('go-native-compatibility', async ({ step }) => {
    for (const packages of [ ['.', '-run', '^TestNoSuchName$'], ['.', '-run', '^TestPresent$'], ['.', './broken', '-run', '^TestPresent$'] ]) {
      const result = await new Promise<Omit<Result, 'mainRuns'>>((finish, fail) => {
        const child = spawn(process.execPath, [script, '-v', '-timeout', '0', '-count=1', ...packages], {
          cwd: directory, env: isolatedEnvironment({ GOWORK: 'off', GOPROXY: 'off', GOFLAGS: '', ORM_TESTMAIN_TRACE: trace }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const lines = stepLines(step);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data: Buffer) => { stdout += String(data); lines.write(data); });
        child.stderr.on('data', (data: Buffer) => { stderr += String(data); lines.write(data); });
        child.on('error', fail);
        child.on('close', (code, signal) => {
          lines.flush();
          if (signal) stderr += `native Go helper ended by ${signal}; inspect the CI process report`;
          finish({ code: code ?? 1, stdout, stderr });
        });
      });
      const mainRuns = (await readFile(trace, 'utf8')).trim().split('\n').length;
      results.push({ ...result, mainRuns });
    }
  });
} finally { await rm(directory, { recursive: true, force: true }); }

caseTest('native Go reports an empty selector as failure and runs TestMain only during execution', COMPUTE, () => {
  assert.equal(prepared, true, 'inspect go-native-compatibility setup output');
  const none = results[0];
  assert.ok(none);
  assert.equal(none.code, 1, none.stdout + none.stderr);
  assert.match(none.stderr, /selected no test/);
  assert.equal(none.mainRuns, 1, 'compilation must not run TestMain');
  const selected = results[1];
  assert.ok(selected);
  assert.equal(selected.code, 0, selected.stdout + selected.stderr);
  assert.match(selected.stdout, /=== RUN\s+TestPresent/);
  assert.equal(selected.mainRuns, 2, 'one TestMain per actual native execution');
});

caseTest('native Go preserves a failed batch while executing the healthy package binary', COMPUTE, () => {
  assert.equal(prepared, true, 'inspect go-native-compatibility setup output');
  const partial = results[2];
  assert.ok(partial);
  assert.equal(partial.code, 1, partial.stdout + partial.stderr);
  assert.match(partial.stdout, /missingSymbol/);
  assert.match(partial.stdout, /=== RUN\s+TestPresent/);
  assert.equal(partial.mainRuns, 3);
});
