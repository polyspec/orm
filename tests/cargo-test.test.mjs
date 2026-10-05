// tests/cargo-test.mjs의 인자 해석 test다. cargo test option과 test 이름 filter, binary 인자를 나누고, cargo의
// JSON message에서 test binary와 그 package directory만 읽는다.
import assert from 'node:assert/strict';
import { executables, split } from './cargo-test.mjs';
import { caseTest, COMPUTE } from './testcase.mjs';

caseTest('cargo-test splits options, name filters and test binary arguments', COMPUTE, () => {
  assert.deepEqual(split(['cargo', '+1.98.1', 'test', '--locked', '--features', 'a,b', '--test', 'x', 'codec', '--', '--nocapture']),
    { cargo: ['cargo', '+1.98.1'], options: ['--locked', '--features', 'a,b', '--test', 'x'], filters: ['codec'], binaryArgs: ['--nocapture'] });
  assert.deepEqual(split(['cargo', 'test', '--manifest-path', 'c/Cargo.toml', '--lib', '--', 'catalog::', 'tool_db::']),
    { cargo: ['cargo'], options: ['--manifest-path', 'c/Cargo.toml', '--lib'], filters: [], binaryArgs: ['catalog::', 'tool_db::'] });
  assert.deepEqual(split(['cargo', 'test', '-p', 'orm', '--lib', 'tx::send_tests::']).filters, ['tx::send_tests::']);
  assert.throws(() => split(['cargo', 'test', '--no-run']), /builds with --no-run itself/);
  assert.throws(() => split(['cargo', 'build']), /not a cargo test command/);
});

caseTest('cargo-test reads the test binaries and their package directories from cargo messages', COMPUTE, () => {
  const lines = [
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable: '/t/debug/deps/zone-1', manifest_path: '/r/clients/rust/orm/Cargo.toml', target: { name: 'zone' } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: false }, executable: '/t/debug/integration', manifest_path: '/r/x/Cargo.toml', target: { name: 'integration' } }),
    JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable: null, manifest_path: '/r/y/Cargo.toml', target: { name: 'lib' } }),
    JSON.stringify({ reason: 'build-finished', success: true }),
    'not json',
  ];
  assert.deepEqual(executables(lines.join('\n')), [{ executable: '/t/debug/deps/zone-1', manifestDir: '/r/clients/rust/orm', target: 'zone' }]);
});
