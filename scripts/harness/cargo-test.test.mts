// Tests the argument parsing of tests/cargo-test.mts: it splits cargo test options, the test name filter and the binary arguments, and reads cargo's
// JSON messages, reading only the test binary and its package directory.
import assert from 'node:assert/strict';
import { executables, programEnvironment, programs, split } from '../../tests/cargo-test.mts';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';

// stubCargo writes the fake cargo of a case, which prints one compiler message for each binary and runs as the test lease.
// script is the shell body of the test binary named by its argument.
function stubCargo(base: string, names: readonly string[], script: (name: string) => string): void {
  mkdirSync(join(base, 'bin'));
  const messages = names.map(name => {
    const executable = join(base, `${name}-test`);
    writeFileSync(executable, script(name), { mode: 0o755 });
    return JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable, manifest_path: join(base, 'Cargo.toml'), target: { name } });
  });
  writeFileSync(join(base, 'messages.json'), `${messages.join('\n')}\n`);
  writeFileSync(join(base, 'bin/cargo'), `#!/bin/sh\ncat ${join(base, 'messages.json')}\n`, { mode: 0o755 });
  // The fake lease runs the command after `--` as it is.
  writeFileSync(join(base, 'lease'), '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
}

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
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable: '/t/debug/deps/zone-1', manifest_path: '/r/packages/rust/orm/Cargo.toml', target: { name: 'zone' } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: false }, executable: '/t/debug/integration', manifest_path: '/r/x/Cargo.toml', target: { name: 'integration' } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable: null, manifest_path: '/r/y/Cargo.toml', target: { name: 'lib' } }),
    JSON.stringify({ reason: 'build-finished', success: true }),
    'not json',
  ];
  assert.deepEqual(executables(lines.join('\n')), [{ executable: '/t/debug/deps/zone-1', manifestDir: '/r/packages/rust/orm', target: 'zone' }]);
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

// The case that keeps going after a failure (G5.38-3) runs cargo-test.mts with a fake cargo and a lease. cargo reports three test binaries,
// the second binary fails but the third still runs; at the end it reports the failed binary and its exit code, and exits with that code.
caseTest('cargo-test runs every test binary after a failed one and names the failures', PROCESS, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cargo-test-')));
  try {
    const log = join(base, 'ran.log');
    stubCargo(base, ['one', 'two', 'three'], name => `#!/bin/sh\nif [ "$1" = --list ]; then echo '${name}_case: test'; exit 0; fi\necho ${name} >> ${log}\n${name === 'two' ? "echo 'FAIL two_case: expected 1, actual 2'; exit 4" : 'exit 0'}\n`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../tests/cargo-test.mts', import.meta.url)), 'stub', '--', 'cargo', 'test'],
      { encoding: 'utf8', env: isolatedEnvironment({ PATH: `${join(base, 'bin')}:${process.env.PATH}`, LEASE: join(base, 'lease'), CARGO_LEASES: join(base, 'leases') }) });
    assert.equal(result.status, 4, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['one', 'two', 'three']);
    assert.match(result.stdout, /cargo-test: 1 of 3 test binaries failed: two \(exit 4\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The shared-target case (G5.46) shows with real cargo that cargo judges an artifact's freshness only by the source mtime, and does not record which checkout
// built it: when checkout b is built into a target that a built, and b's sources have older mtimes than a's,
// cargo sees a's binary as fresh and runs a's code ("from a") in b too. When b builds into its own target
// directory, it runs b's code ("from b"). So each checkout builds into its own target directory.
caseTest('cargo reuses what another checkout built into a shared target, and a target of its own builds this checkout', PROCESS, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cargo-target-')));
  try {
    const old = new Date('2026-01-01T00:00:00Z');
    const checkout = (name: string, text: string) => {
      mkdirSync(join(base, name, 'src'), { recursive: true });
      writeFileSync(join(base, name, 'Cargo.toml'), '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n');
      writeFileSync(join(base, name, 'src/main.rs'), `fn main() { println!("${text}"); }\n`);
      for (const file of ['Cargo.toml', 'src/main.rs']) utimesSync(join(base, name, file), old, old);
    };
    // cargo receives only the toolchain the case gives (the channel in rust-toolchain.toml) and the offline setting.
    const channel = /^channel = "(.*)"$/m.exec(readFileSync(new URL('../../rust-toolchain.toml', import.meta.url), 'utf8'))?.[1];
    assert.ok(channel, 'rust-toolchain.toml declares a channel');
    const toolchain = channel;
    const env = (target: string) => isolatedEnvironment({ PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`, RUSTUP_TOOLCHAIN: toolchain, CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: target });
    const built = (name: string, target: string) => {
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

// The target directory guard case (G5.46) checks that when CARGO_TARGET_DIR on the command line points outside this checkout, make stops without running anything,
// states the reason, and accepts a directory inside this checkout.
caseTest('make refuses a Rust target directory outside its checkout', PROCESS, () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const make = (target?: string) => spawnSync('make', ['-n', '--no-print-directory', 'version-check', ...(target ? [`CARGO_TARGET_DIR=${target}`] : [])], { cwd: repo, encoding: 'utf8', env: isolatedEnvironment() });
  const other = make(join(tmpdir(), 'another-checkout', 'packages', 'rust', 'target'));
  assert.notEqual(other.status, 0, 'make ran with the target directory of another checkout');
  assert.match(other.stderr, /CARGO_TARGET_DIR=\S+ is outside this checkout \S+; each checkout builds Rust into its own target directory/);
  assert.equal(make('').status, 0, make('').stderr);
  assert.equal(make(join(repo, '.runtime', 'run', 'x', 'target')).status, 0);
});

// The empty selection case (G5.54) checks whether a run in which the test name filter selects no test in any test binary counts as a failure.
// cargo-test counts the tests each binary selects with `--list`, and if the sum is 0 it fails without running the binary. A filter with a misspelled name
// would otherwise let every binary end with 0 without running anything.
caseTest('cargo-test fails when the name filters select no test in any test binary', PROCESS, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cargo-empty-')));
  try {
    const log = join(base, 'ran.log');
    stubCargo(base, ['one', 'two'], name => `#!/bin/sh\nif [ "$1" = --list ]; then case "$2" in ${name}*) echo '${name}_case: test';; esac; echo '0 benchmarks'; exit 0; fi\necho ${name} >> ${log}\n`);
    const run = (filter: string) => spawnSync(process.execPath, [fileURLToPath(new URL('../../tests/cargo-test.mts', import.meta.url)), 'stub', '--', 'cargo', 'test', filter],
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

