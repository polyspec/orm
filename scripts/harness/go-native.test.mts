import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { goBatches, goCompileArguments, goDiscoveryArguments, goExecuteArguments, goInvocation, goPackages } from '../../tests/go-native.mts';

caseTest('Go compilation retains build settings and native execution receives only test flags', COMPUTE, () => {
  const plan = goInvocation(['-tags', 'ormtest,physical', '-race', '-json', '-v', './a', './b', '-skip', 'TestOther', '-run=TestCase', '-timeout', '0', '-count=1']);
  assert.deepEqual(plan.packages, ['./a', './b']);
  assert.deepEqual(plan.build, ['-tags', 'ormtest,physical', '-race']);
  assert.deepEqual(plan.discovery, plan.build);
  assert.deepEqual(plan.native, ['-test.v=test2json', '-test.skip', 'TestOther', '-test.run=TestCase', '-test.timeout', '0', '-test.count=1']);
  const pkg = { path: 'example.com/a', directory: '/checkout/a', hasTests: true };
  assert.deepEqual(goCompileArguments(plan, [pkg], '/run/0.test'), ['test', '-c', '-tags', 'ormtest,physical', '-race', '-o', '/run/0.test', 'example.com/a']);
  assert.deepEqual(goExecuteArguments(plan, pkg, '/run/0.test'), ['tool', 'test2json', '-t', '-p', pkg.path, '/run/0.test', ...plan.native]);
  assert.equal(plan.raw, true);
  assert.deepEqual(goInvocation([]).packages, ['.']);
  assert.equal(goDiscoveryArguments(plan)[0], 'list');
});

caseTest('Go discovery preserves package identity, external tests and empty packages and refuses malformed output', COMPUTE, () => {
  assert.deepEqual(goPackages('m/a\t/checkout/a\t1\t0\nm/b\t/checkout/b\t0\t2\nm/c\t/checkout/c\t0\t0\n'), [
    { path: 'm/a', directory: '/checkout/a', hasTests: true },
    { path: 'm/b', directory: '/checkout/b', hasTests: true },
    { path: 'm/c', directory: '/checkout/c', hasTests: false },
  ]);
  assert.throws(() => goPackages(''), /selected no package/);
  assert.throws(() => goPackages('m/a\t/a\t0\t0\nm/a\t/a\t0\t0'), /duplicate package/);
  assert.throws(() => goPackages('m/a\trelative\t1\t0'), /invalid package discovery/);
  assert.throws(() => goInvocation(['-timeout']), /needs a value/);
  assert.throws(() => goInvocation(['-fuzz', 'FuzzX']), /unsupported flag -fuzz/);
});

caseTest('Go helper compiles once, executes only prepared binaries and keeps healthy packages after a build failure', PROCESS, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orm-go-native-')));
  try {
    mkdirSync(join(root, 'bin'));
    for (const name of ['one', 'two', 'three']) mkdirSync(join(root, name));
    const log = join(root, 'commands');
    // This stand-in checks command phases; real Go flag and event compatibility is also tested by the existing CI native case.
    writeFileSync(join(root, 'bin/go'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'list') {
  for (const n of ['one', 'two', 'three']) console.log('example.com/' + n + '\\t' + process.env.PACKAGE_ROOT + '/' + n + '\\t1\\t0');
} else if (a[0] === 'test' && a[1] === '-c') {
  let failed = false;
  for (const name of a.slice(a.indexOf('-o') + 2)) {
    if (name === 'example.com/two' && process.env.FAIL_BUILD) { console.error('two.go: expected a type, actual undefined'); failed = true; continue; }
    fs.writeFileSync(a[a.indexOf('-o') + 1] + '/' + name.split('/').at(-1) + '.test', 'prepared');
  }
  if (failed) process.exit(3);
} else if (a[0] === 'tool' && a[1] === 'test2json') {
  if (!fs.existsSync(a[5])) throw Error('prepared binary is missing');
  const name = a[4];
  if (process.cwd() !== process.env.PACKAGE_ROOT + '/' + name.split('/').at(-1)) throw Error('wrong package working directory');
  console.log(JSON.stringify({ Action: 'run', Package: name, Test: 'TestCase' }));
  const failed = name === 'example.com/two' && process.env.FAIL_TEST;
  console.log(JSON.stringify({ Action: failed ? 'fail' : 'pass', Package: name, Test: 'TestCase' }));
  if (failed) process.exit(4);
} else { console.error('unexpected Go invocation: ' + a.join(' ')); process.exit(9); }
`, { mode: 0o755 });
    const script = new URL('../../tests/go-test.mts', import.meta.url).pathname;
    for (const failure of ['', 'FAIL_BUILD', 'FAIL_TEST']) {
      const fail = failure === 'FAIL_BUILD';
      writeFileSync(log, '');
      const child = spawnSync(process.execPath, [script, '-json', '-timeout', '0', './...'], {
        cwd: root, encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(root, 'bin')}:${process.env.PATH}`, COMMAND_LOG: log,
          PACKAGE_ROOT: root, ...(failure ? { [failure]: '1' } : {}) }),
      });
      assert.ifError(child.error);
      assert.equal(child.signal, null);
      assert.equal(child.status, failure ? 1 : 0, child.stdout + child.stderr);
      const commands: string[][] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(commands.filter(a => a[0] === 'test' && a[1] === '-c').length, 1);
      const runs = commands.filter(a => a[0] === 'tool');
      assert.deepEqual(runs.map(a => a[4]), fail ? ['example.com/one', 'example.com/three'] : ['example.com/one', 'example.com/two', 'example.com/three']);
      for (const a of runs) assert.equal(a.includes('-test.v=test2json'), true);
      for (const a of commands) assert.ok(a[0] !== 'test' || a[1] === '-c', 'go test executes no test process');
      for (const a of runs) assert.throws(() => readFileSync(a[5] ?? ''), /ENOENT/, 'owned binaries are removed after the run');
      if (fail) assert.match(child.stdout, /two.go: expected a type, actual undefined/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

caseTest('Go batches retain every package and separate equal native binary names before building', COMPUTE, () => {
  const packages = ['first/orm', 'second/orm', 'third/client', 'last/orm'].map(path => ({ path, directory: '/' + path, hasTests: true }));
  const batches = goBatches(packages, '/run');
  assert.deepEqual(batches.map(batch => batch.entries.map(entry => entry.pkg.path)), [['first/orm', 'third/client'], ['second/orm'], ['last/orm']]);
  assert.equal(new Set(batches.flatMap(batch => batch.entries.map(entry => entry.binary))).size, packages.length);
});
