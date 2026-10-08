// tests/cargo-test.mjs의 인자 해석 test다. cargo test option과 test 이름 filter, binary 인자를 나누고, cargo의
// JSON message에서 test binary와 그 package directory만 읽는다.
import assert from 'node:assert/strict';
import { executables, programEnvironment, programs, split } from './cargo-test.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from './environment.mjs';
import { caseTest, COMPUTE, PROCESS } from './testcase.mjs';

caseTest('cargo-test splits options, name filters and test binary arguments', COMPUTE, () => {
  assert.deepEqual(split(['cargo', '+1.98.1', 'test', '--locked', '--features', 'a,b', '--test', 'x', 'codec', '--', '--nocapture']),
    { cargo: ['cargo', '+1.98.1'], options: ['--locked', '--features', 'a,b', '--test', 'x'], filters: ['codec'], binaryArgs: ['--nocapture'] });
  assert.deepEqual(split(['cargo', 'test', '--manifest-path', 'c/Cargo.toml', '--lib', '--', 'catalog::', 'tool_db::']),
    { cargo: ['cargo'], options: ['--manifest-path', 'c/Cargo.toml', '--lib'], filters: [], binaryArgs: ['catalog::', 'tool_db::'] });
  assert.deepEqual(split(['cargo', 'test', '-p', 'polyspec-orm', '--lib', 'tx::send_tests::']).filters, ['tx::send_tests::']);
  assert.throws(() => split(['cargo', 'test', '--no-run']), /builds with --no-run itself/);
  assert.throws(() => split(['cargo', 'build']), /not a cargo test command/);
});

caseTest('cargo-test reads the test binaries and their package directories from cargo messages', COMPUTE, () => {
  const lines = [
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable: '/t/debug/deps/zone-1', manifest_path: '/r/packages/orm-rust/orm/Cargo.toml', target: { name: 'zone' } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: false }, executable: '/t/debug/integration', manifest_path: '/r/x/Cargo.toml', target: { name: 'integration' } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable: null, manifest_path: '/r/y/Cargo.toml', target: { name: 'lib' } }),
    JSON.stringify({ reason: 'build-finished', success: true }),
    'not json',
  ];
  assert.deepEqual(executables(lines.join('\n')), [{ executable: '/t/debug/deps/zone-1', manifestDir: '/r/packages/orm-rust/orm', target: 'zone' }]);
});

caseTest('cargo-test reads the package programs and names their variables', COMPUTE, () => {
  const lines = [
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: false }, executable: '/t/debug/native', target: { name: 'native', kind: ['bin'] } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: false }, executable: '/t/debug/driver-compare', target: { name: 'driver-compare', kind: ['bin'] } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable: '/t/debug/deps/dsn-1', target: { name: 'dsn', kind: ['test'] } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: false }, executable: null, target: { name: 'polyspec_orm', kind: ['lib'] } }),
  ];
  assert.deepEqual(programs(lines.join('\n')), { native: '/t/debug/native', 'driver-compare': '/t/debug/driver-compare' });
  assert.deepEqual(programEnvironment({ native: '/r/programs/native', 'driver-compare': '/r/programs/driver-compare' }),
    { ORM_PROGRAM_NATIVE: '/r/programs/native', ORM_PROGRAM_DRIVER_COMPARE: '/r/programs/driver-compare' });
});

// 실패 뒤 계속 case(G5.38-3)는 가짜 cargo와 lease로 cargo-test.mjs를 실행한다. cargo는 test binary 셋을 알리고,
// 둘째 binary가 실패해도 셋째가 실행되며, 끝에 실패한 binary와 그 종료 코드를 적고 그 코드로 끝난다.
caseTest('cargo-test runs every test binary after a failed one and names the failures', PROCESS, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cargo-test-')));
  try {
    const log = join(base, 'ran.log');
    mkdirSync(join(base, 'bin'));
    const messages = ['one', 'two', 'three'].map(name => {
      const executable = join(base, `${name}-test`);
      // --list는 그 binary의 test 하나를 libtest 형식으로 적는다.
      writeFileSync(executable, `#!/bin/sh\nif [ "$1" = --list ]; then echo '${name}_case: test'; exit 0; fi\necho ${name} >> ${log}\n${name === 'two' ? "echo 'FAIL two_case: expected 1, actual 2'; exit 4" : 'exit 0'}\n`, { mode: 0o755 });
      return JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable, manifest_path: join(base, 'Cargo.toml'), target: { name } });
    });
    writeFileSync(join(base, 'messages.json'), `${messages.join('\n')}\n`);
    writeFileSync(join(base, 'bin/cargo'), `#!/bin/sh\ncat ${join(base, 'messages.json')}\n`, { mode: 0o755 });
    // 가짜 lease는 `--` 뒤의 명령을 그대로 실행한다.
    writeFileSync(join(base, 'lease'), '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cargo-test.mjs', import.meta.url)), 'stub', '--', 'cargo', 'test'],
      { encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(base, 'bin')}:${process.env.PATH}`, LEASE: join(base, 'lease'), CARGO_LEASES: join(base, 'leases') }) });
    assert.equal(result.status, 4, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['one', 'two', 'three']);
    assert.match(result.stdout, /cargo-test: 1 of 3 test binaries failed: two \(exit 4\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 공유 target case(G5.46)는 cargo가 artifact의 freshness를 source의 mtime으로만 판단하고 어느 checkout이 build했는지
// 기록하지 않는다는 것을 실제 cargo로 보인다. checkout a가 build한 target에 a보다 오래된 mtime의 다른 source를 가진
// checkout b를 build하면 cargo는 a의 binary를 fresh로 보고 b에서도 a의 code("from a")를 실행한다. b가 자기 target
// directory에 build하면 b의 code("from b")를 실행한다. 그래서 각 checkout은 자기 target directory에 build한다.
caseTest('cargo reuses what another checkout built into a shared target, and a target of its own builds this checkout', PROCESS, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cargo-target-')));
  try {
    const old = new Date('2026-01-01T00:00:00Z');
    const checkout = (name, text) => {
      mkdirSync(join(base, name, 'src'), { recursive: true });
      writeFileSync(join(base, name, 'Cargo.toml'), '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n');
      writeFileSync(join(base, name, 'src/main.rs'), `fn main() { println!("${text}"); }\n`);
      for (const file of ['Cargo.toml', 'src/main.rs']) utimesSync(join(base, name, file), old, old);
    };
    // cargo는 case가 주는 toolchain(rust-toolchain.toml의 channel)과 offline 설정만 받는다.
    const toolchain = /^channel = "(.*)"$/m.exec(readFileSync(new URL('../rust-toolchain.toml', import.meta.url), 'utf8'))[1];
    const env = target => isolatedEnvironment({ PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`, RUSTUP_TOOLCHAIN: toolchain, CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: target });
    const built = (name, target) => {
      const build = spawnSync('cargo', ['build', '--offline', '--quiet'], { cwd: join(base, name), env: env(target), encoding: 'utf8' });
      assert.equal(build.status, 0, build.stderr);
      return execFileSync(join(target, 'debug', 'probe'), { encoding: 'utf8' }).trim();
    };
    checkout('a', 'from a');
    checkout('b', 'from b');
    const shared = join(base, 'shared-target');
    assert.equal(built('a', shared), 'from a');
    assert.equal(built('b', shared), 'from a', 'cargo rebuilt checkout b in the shared target');
    assert.equal(built('b', join(base, 'b', 'target')), 'from b');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// target directory guard case(G5.46)는 command line의 CARGO_TARGET_DIR이 이 checkout 밖을 가리키면 make가 아무것도
// 실행하지 않고 그 이유를 적고 멈추는지, 이 checkout 안의 directory는 받는지 확인한다.
caseTest('make refuses a Rust target directory outside its checkout', PROCESS, () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const make = target => spawnSync('make', ['-n', '--no-print-directory', 'version-check', ...(target ? [`CARGO_TARGET_DIR=${target}`] : [])], { cwd: repo, encoding: 'utf8', env: isolatedEnvironment() });
  const other = make(join(tmpdir(), 'another-checkout', 'packages', 'orm-rust', 'target'));
  assert.notEqual(other.status, 0, 'make ran with the target directory of another checkout');
  assert.match(other.stderr, /CARGO_TARGET_DIR=\S+ is outside this checkout \S+; each checkout builds Rust into its own target directory/);
  assert.equal(make('').status, 0, make('').stderr);
  assert.equal(make(join(repo, '.runtime', 'run', 'x', 'target')).status, 0);
});

// 빈 선택 case(G5.54)는 test 이름 filter가 모든 test binary에서 test를 하나도 고르지 않는 실행을 실패로 보는지 본다.
// cargo-test는 binary마다 `--list`로 고른 test를 세고, 합이 0이면 binary를 실행하지 않고 실패한다. 이름을 잘못 쓴
// filter는 아무것도 실행하지 않고도 모든 binary가 0으로 끝나기 때문이다.
caseTest('cargo-test fails when the name filters select no test in any test binary', PROCESS, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cargo-empty-')));
  try {
    const log = join(base, 'ran.log');
    mkdirSync(join(base, 'bin'));
    const messages = ['one', 'two'].map(name => {
      const executable = join(base, `${name}-test`);
      writeFileSync(executable, `#!/bin/sh\nif [ "$1" = --list ]; then case "$2" in ${name}*) echo '${name}_case: test';; esac; echo '0 benchmarks'; exit 0; fi\necho ${name} >> ${log}\n`, { mode: 0o755 });
      return JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable, manifest_path: join(base, 'Cargo.toml'), target: { name } });
    });
    writeFileSync(join(base, 'messages.json'), `${messages.join('\n')}\n`);
    writeFileSync(join(base, 'bin/cargo'), `#!/bin/sh\ncat ${join(base, 'messages.json')}\n`, { mode: 0o755 });
    writeFileSync(join(base, 'lease'), '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    const run = filter => spawnSync(process.execPath, [fileURLToPath(new URL('./cargo-test.mjs', import.meta.url)), 'stub', '--', 'cargo', 'test', filter],
      { encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(base, 'bin')}:${process.env.PATH}`, LEASE: join(base, 'lease'), CARGO_LEASES: join(base, 'leases') }) });
    const none = run('no_such_name');
    assert.equal(none.status, 1, none.stdout + none.stderr);
    assert.match(none.stdout, /cargo-test: the filters no_such_name select no test in 2 test binaries/);
    assert.ok(!existsSync(log), 'a test binary ran although nothing was selected');
    const some = run('two');
    assert.equal(some.status, 0, some.stdout + some.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['one', 'two']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

