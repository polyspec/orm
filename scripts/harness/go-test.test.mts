// Tests the build-phase arguments of tests/go-test.mts. The run flag is removed from the build, and the package, build tag and
// build flags remain.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GO_TEST_TAGS, packages, testEvents, withTestTags } from '../../tests/go-test.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';

caseTest('Go build labels retain the package patterns of the invocation', COMPUTE, () => {
  assert.equal(packages(['-v', './packages/go/orm', './packages/go/orm/pg', '-run', 'X']), 'packages/go/orm,packages/go/orm/pg');
  assert.equal(packages(['-v']), '.');
});

// Every go test of the repository builds the test entry point (protocol §3), whose file and tests carry the tag ormtest:
// a run without it would leave rollback_fault_entry_test.go and statement_fault_test.go out unseen. The tags of a run are merged
// with GO_TEST_TAGS, in either flag form, and a run with no tags gets them alone.
caseTest('every go test run carries the test entry point tag', COMPUTE, () => {
  assert.deepEqual(GO_TEST_TAGS, ['ormtest']);
  assert.deepEqual(withTestTags(['-v', './packages/go/...']), ['-tags', 'ormtest', '-v', './packages/go/...']);
  assert.deepEqual(withTestTags(['-tags', 'physical', './packages/go/orm']), ['-tags', 'physical,ormtest', './packages/go/orm']);
  assert.deepEqual(withTestTags(['-tags=physical,ormtest', './packages/go/internal/dialects']), ['-tags=physical,ormtest', './packages/go/internal/dialects']);
  assert.throws(() => withTestTags(['-tags', 'a', '-tags', 'b', './x']), /more than one -tags/);
});

// Completion evidence comes from native pass/fail events, not human-readable RUN lines or a start-only event.
caseTest('selected tests are counted from completed test2json events', COMPUTE, () => {
  const written: string[] = [];
  const events = testEvents((text: string) => written.push(text));
  events.write('{"Action":"output","Output":"=== RUN   TestText\\n"}\n{"Action":"run","Pack');
  events.write('age":"p","Test":"TestEvent"}\n# build line\n{"Action":"run","Package":"p"}\n{"Action":"build-output","Output":"x.go:1: undefined\\n"}\n');
  assert.equal(events.runs(), 0, 'starting a native case is not completion evidence');
  events.write('{"Action":"pass","Test":"TestEvent"}');
  events.flush();
  assert.equal(events.runs(), 1);
  assert.deepEqual(written, ['=== RUN   TestText\n', '# build line\n', 'x.go:1: undefined\n']);
});


caseTest('Go helper dry-run renders the native build and test flags without a Go toolchain', COMPUTE, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-go-plan-'));
  try {
    const result = spawnSync(process.execPath, [new URL('../../tests/go-test.mts', import.meta.url).pathname,
      '--dry-run', '-v', './packages/go/orm', '-run', '^TestCase$', '-count=1'], {
      env: isolatedEnvironment({ PATH: dir, HOME: dir }), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const plan: unknown = JSON.parse(result.stdout);
    assert.ok(typeof plan === 'object' && plan !== null && 'execution' in plan && 'commands' in plan);
    assert.equal(plan.execution, 'not-run');
    assert.deepEqual(plan.commands, [
      { phase: 'discover', program: 'go', args: ['list', '-e', '-f', '{{.ImportPath}}\t{{.Dir}}\t{{len .TestGoFiles}}\t{{len .XTestGoFiles}}', '-tags', 'ormtest', './packages/go/orm'] },
      { phase: 'build', program: 'go', args: ['test', '-c', '-tags', 'ormtest', '-o', '<owned build directory>', '<discovered compatible packages>'], requires: 'package discovery succeeded' },
      { phase: 'test', program: 'go', args: ['tool', 'test2json', '-t', '-p', '<discovered package>', '<owned binary>', '-test.v=test2json', '-test.run', '^TestCase$', '-test.count=1'], requires: 'this package build succeeded', cwd: '<discovered package directory>' },
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
