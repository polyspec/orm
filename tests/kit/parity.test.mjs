// Tests of scripts/kit/parity.mjs, the language-parity check. Each test builds a mini repository of five implementations
// (go, rust, ts, php, python) whose declaration config/parity.json passes, changes one dimension of it and expects the
// finding of exactly one rule: R1 to R11 and the declaration errors. Stub commands stand in for go, cargo, php and the
// Python of var/tools, and print the native output of their tool for the cases of the test file they run; the TypeScript
// tests are node:test files that run on the real node. A stub reads the lines `PASS <name>` and `FAIL <name>` of its test
// file (the name of a native test: a go subtest, a libtest path, a PHPUnit or unittest method) and exits with the status of
// its `EXIT <n>` line (go: `EXIT <symbol> <n>`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkParity } from '../../scripts/kit/parity.mjs';
import { runOf } from '../../scripts/kit/parity-runners.mjs';
import { tree } from './tree.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/kit');
const TIMEOUT = { timeout: 120_000 };

// The stub of go: `go test -json -count=1 -run ^<symbol>$ ./<directory>` in the module directory. It reads the lines
// `PASS <symbol>/<case>` and `FAIL <symbol>/<case>` of the *_test.go files of the directory and writes the events of go test;
// it exits with the status of the line `EXIT <symbol> <n>`, so a test function of the same directory keeps status 0.
const GO_STUB = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const symbol = args[args.indexOf('-run') + 1].replace(/^\\^|\\$$/g, '');
const directory = args[args.length - 1];
let exit = 0;
// A line \`BUILD <message>\` makes the package fail to build, with the events that go 1.27 writes, observed with a real module.
const build = fs.readdirSync(directory).filter(name => name.endsWith('_test.go')).sort()
  .flatMap(file => fs.readFileSync(path.join(directory, file), 'utf8').split('\\n').filter(line => line.startsWith('BUILD ')).map(line => line.slice(6)));
if (build.length) {
  const id = 'example.com/codec [example.com/codec.test]';
  console.log(JSON.stringify({ ImportPath: id, Action: 'build-output', Output: '# ' + id + '\\n' }));
  for (const message of build) console.log(JSON.stringify({ ImportPath: id, Action: 'build-output', Output: message + '\\n' }));
  console.log(JSON.stringify({ ImportPath: id, Action: 'build-fail' }));
  console.log(JSON.stringify({ Action: 'start', Package: 'example.com/codec' }));
  console.log(JSON.stringify({ Action: 'output', Package: 'example.com/codec', Output: 'FAIL\\texample.com/codec [build failed]\\n', OutputType: 'frame' }));
  console.log(JSON.stringify({ Action: 'fail', Package: 'example.com/codec', Elapsed: 0.003, FailedBuild: id }));
  process.exit(1);
}
console.log(JSON.stringify({ Action: 'start', Package: 'example' }));
for (const file of fs.readdirSync(directory).filter(name => name.endsWith('_test.go')).sort()) {
  for (const line of fs.readFileSync(path.join(directory, file), 'utf8').split('\\n')) {
    const found = /^(PASS|FAIL) (\\S+)$/.exec(line);
    if (found && found[2].startsWith(symbol + '/')) {
      console.log(JSON.stringify({ Action: 'run', Test: found[2] }));
      console.log(JSON.stringify({ Action: 'output', Test: found[2], Output: '=== RUN ' + found[2] + '\\n' }));
      console.log(JSON.stringify({ Action: found[1] === 'PASS' ? 'pass' : 'fail', Test: found[2] }));
    }
    const status = /^EXIT (\\S+) (\\d+)$/.exec(line);
    if (status && status[1] === symbol) exit = Number(status[2]);
  }
}
console.log(JSON.stringify({ Action: exit ? 'fail' : 'pass', Test: symbol }));
process.exit(exit);
`;

// The stub of cargo: `cargo test --manifest-path <crate>/Cargo.toml (--test <name> | --lib) -- --test-threads=1 <filter>`
// reads tests/<name>.rs or src/lib.rs of the crate and runs each test whose name starts with the filter. It writes what cargo
// writes for serial tests: `running <n> tests`, then `test <name> ... ok` or `FAILED` for each test, then the result line.
const CARGO_STUB = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const crate = path.dirname(args[args.indexOf('--manifest-path') + 1]);
const file = args.includes('--lib') ? path.join(crate, 'src/lib.rs') : path.join(crate, 'tests', args[args.indexOf('--test') + 1] + '.rs');
const filter = args[args.length - 1];
const tests = fs.readFileSync(file, 'utf8').split('\\n').map(line => /^(PASS|FAIL) (\\S+)$/.exec(line)).filter(match => match && match[2].startsWith(filter));
process.stderr.write('   Compiling codec v0.1.0\\n    Finished \\x60test\\x60 profile [unoptimized + debuginfo] target(s) in 0.01s\\n     Running ' + file + '\\n');
process.stdout.write('\\nrunning ' + tests.length + ' tests\\n');
let exit = 0;
for (const [, outcome, name] of tests) {
  process.stdout.write('test ' + name + ' ... ' + (outcome === 'PASS' ? 'ok' : 'FAILED') + '\\n');
  if (outcome === 'FAIL') exit = 1;
}
for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
  const status = /^EXIT (\\d+)$/.exec(line);
  if (status) exit = Number(status[1]);
}
process.stdout.write(exit ? '\\nfailures:\\n\\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\\n\\n' : '\\ntest result: ok. ' + tests.length + ' passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\\n\\n');
process.exit(exit ? 101 : 0);
`;

// The stub of PHPUnit (`php <args> vendor/bin/phpunit --teamcity <test>`): each `PASS <name>` and `FAIL <name>` line of the test
// file is a test method, which PHPUnit reports as TeamCity messages; a `##teamcity[` line of the file is printed as it is. It
// exits with 1 when a test failed.
const PHP_STUB = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const file = args[args.length - 1];
let exit = 0;
const teamcity = (name, attributes) => '##teamcity[' + name + ' ' + Object.entries(attributes).map(([key, value]) => key + "='" + value + "'").join(' ') + ']';
for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
  const test = /^(PASS|FAIL) (\\S+)$/.exec(line);
  if (test) {
    const location = 'php_qn://' + file + '::\\\\CodecTest::' + test[2];
    console.log(teamcity('testStarted', { name: test[2], locationHint: location }));
    if (test[1] === 'FAIL') { console.log(teamcity('testFailed', { name: test[2], message: 'Failed asserting', details: 'at ' + file })); exit = 1; }
    console.log(teamcity('testFinished', { name: test[2], duration: '1' }));
  }
  if (line.startsWith('##teamcity[')) console.log(line);
  const status = /^EXIT (\\d+)$/.exec(line);
  if (status) exit = Number(status[1]);
}
process.exit(exit);
`;

// The stub of Python (`python3 <args> -m unittest -v <test>`), which writes its verbose results to standard error: a line
// `<method> (<module>.<class>.<method>) ... ok` for each `PASS <method>` line of the test file, `FAIL` for a `FAIL` line.
// With REQUIRE_PYTHONPATH it reports nothing and exits with 3 unless PYTHONPATH is python/src and -B is its first argument.
const PY_STUB = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const file = args[args.length - 1];
if (process.env.REQUIRE_PYTHONPATH && !(process.env.PYTHONPATH === 'python/src' && args[0] === '-B')) process.exit(3);
let exit = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
  const test = /^(PASS|FAIL) (\\S+)$/.exec(line);
  if (test) {
    process.stderr.write(test[2] + ' (test_codec.Codec.' + test[2] + ') ... ' + (test[1] === 'PASS' ? 'ok' : 'FAIL') + '\\n');
    if (test[1] === 'FAIL') exit = 1;
  }
  const status = /^EXIT (\\d+)$/.exec(line);
  if (status) exit = Number(status[1]);
}
process.exit(exit);
`;

const STUBS = mkdtempSync(path.join(tmpdir(), 'kit-parity-stubs-'));
for (const [name, text] of [['go', GO_STUB], ['cargo', CARGO_STUB], ['php', PHP_STUB]]) {
  writeFileSync(path.join(STUBS, name), text);
  chmodSync(path.join(STUBS, name), 0o755);
}
test.after(() => rmSync(STUBS, { recursive: true, force: true }));
const ENV = { ...process.env, PATH: `${STUBS}${path.delimiter}${process.env.PATH}` };

const snapshot = entries => `${JSON.stringify(Object.fromEntries(entries.map(([id, exported]) => [id, { exported }])), null, 2)}\n`;

// A node:test file of the codec: its two cases.
const NODE_CODEC = "import test from 'node:test';\ntest('empty', () => {});\ntest('ascii', () => {});\n";

const FILES = {
  '.gitignore': 'var/\n',
  'tests/vectors/codec.json': JSON.stringify({ vectors: [{ name: 'empty' }, { name: 'ascii' }] }),
  'tests/vectors/width.json': JSON.stringify(['narrow', 'wide']),
  'go/go.mod': 'module example.com/codec\n',
  'go/codec.go': 'package codec\n',
  'go/codec_test.go': 'PASS TestCodec/empty\nPASS TestCodec/ascii\n',
  'go/width_test.go': 'PASS TestWidth/narrow\nPASS TestWidth/wide\n',
  'tests/vectors/size.json': JSON.stringify(['small']),
  'go/size_test.go': 'PASS TestSize/small\n',
  'rust/tests/size.rs': 'PASS vectors::small\n',
  'go/codes.go': 'package codec\n\nconst (\n\tCodeConfig = "CONFIG"\n\tCodeDecode = "CODEC_DECODE"\n)\n',
  'rust/Cargo.toml': '[package]\nname = "codec"\n',
  'rust/src/lib.rs': 'PASS width::tests::vectors::narrow\nPASS width::tests::vectors::wide\n',
  'rust/src/codes.rs': 'pub const CONFIG: &str = "CONFIG";\npub const CODEC_DECODE: &str = "CODEC_DECODE";\n',
  'rust/tests/codec.rs': 'PASS vectors::empty\nPASS vectors::ascii\n',
  'ts/src/index.ts': 'export const encode = () => 1;\n',
  'ts/src/codes.ts': "export const CONFIG = 'CONFIG';\nexport const CODEC_DECODE = 'CODEC_DECODE';\n",
  'ts/tests/codec.mjs': NODE_CODEC,
  'php/src/Code.php': "<?php\nfinal class Code\n{\n    const CONFIG = 'CONFIG';\n    const CODEC_DECODE = 'CODEC_DECODE';\n}\n",
  'php/tests/codec.php': 'PASS test_empty\nPASS test_ascii\n',
  'php/composer.json': '{}\n',
  'php/vendor/bin/phpunit': '',
  'python/codes.py': 'CONFIG = "CONFIG"\nCODEC_DECODE = "CODEC_DECODE"\n',
  'python/tests/test_codec.py': 'PASS test_empty\nPASS test_ascii\n',
  'var/tools/bin/python3': PY_STUB,
  'contracts/symbols/go.json': snapshot([['go/codec.go::Encode', true], ['go/codec.go::encodeHost', false]]),
  'contracts/symbols/rust.json': snapshot([['rust/src/lib.rs::encode', true], ['rust/src/lib.rs::hex_upper', true]]),
  'contracts/symbols/ts.json': snapshot([['ts/src/index.ts::encode', true]]),
  'contracts/symbols/php.json': snapshot([['php/src/Codec.php::Codec::encode', true]]),
  'contracts/symbols/python.json': snapshot([['python/codec.py::encode', true], ['python/codec.py::_split', false]]),
  'docs/errors.yaml': '- code: CONFIG\n- code: CODEC_DECODE\n',
  'tools/languages.mjs': "export const LANGUAGES = ['go', 'rust', 'ts', 'php', 'python'];\n",
  'docs/index.md': '# Codec\n\nFive languages share the codec: Go, Rust, TS, PHP and Python.\nThe two implementations go and rust compile.\n',
  'docs/index.ko.md': '# Codec\n\n다섯 언어가 codec을 공유한다: Go, Rust, TS, PHP와 Python.\n',
};

const CONFIG = {
  schema: 1,
  implementations: [
    { name: 'go', runner: 'go', roots: ['go'], tests: ['go/**/*_test.go'], symbols: 'contracts/symbols/go.json', errors: { file: 'go/codes.go', pattern: '^\\tCode\\w+ = "(\\w+)"$' } },
    { name: 'rust', runner: 'cargo', roots: ['rust'], tests: ['rust/tests/*.rs'], symbols: 'contracts/symbols/rust.json', errors: { file: 'rust/src/codes.rs', pattern: '^pub const \\w+: &str = "(\\w+)";$' } },
    { name: 'ts', runner: 'node', roots: ['ts'], tests: ['ts/tests/*.mjs'], symbols: 'contracts/symbols/ts.json', errors: { file: 'ts/src/codes.ts', pattern: "^export const \\w+ = '(\\w+)';$" } },
    { name: 'php', runner: 'php', roots: ['php'], tests: ['php/tests/*.php'], symbols: 'contracts/symbols/php.json', errors: { file: 'php/src/Code.php', pattern: "^    const \\w+ = '(\\w+)';$" } },
    { name: 'python', runner: 'python', roots: ['python'], tests: ['python/tests/*.py'], symbols: 'contracts/symbols/python.json', errors: { file: 'python/codes.py', pattern: '^\\w+ = "(\\w+)"$' } },
  ],
  profiles: [
    { name: 'all', implementations: ['go', 'rust', 'ts', 'php', 'python'] },
    { name: 'compiled', implementations: ['go', 'rust'], reason: 'the width tables exist only in the compiled implementations' },
  ],
  suites: ['tests/vectors/*.json'],
  comparators: ['tests/compare'],
  testPatterns: [
    { runner: 'go', globs: ['**/*_test.go'] },
    { runner: 'cargo', globs: ['**/tests/**/*.rs'] },
    { runner: 'node', globs: ['**/tests/**/*.mjs'] },
    { runner: 'php', globs: ['**/tests/**/*.php'] },
    { runner: 'python', globs: ['**/tests/**/test_*.py'] },
  ],
  units: [
    {
      id: 'codec', kind: 'suite', profile: 'all', file: 'tests/vectors/codec.json', cases: '$.vectors[*].name',
      bindings: [
        { implementation: 'go', test: 'go/codec_test.go', symbol: 'TestCodec' },
        { implementation: 'rust', test: 'rust/tests/codec.rs', symbol: 'vectors' },
        { implementation: 'ts', test: 'ts/tests/codec.mjs' },
        { implementation: 'php', test: 'php/tests/codec.php' },
        { implementation: 'python', test: 'python/tests/test_codec.py' },
      ],
    },
    {
      id: 'width', kind: 'suite', profile: 'compiled', file: 'tests/vectors/width.json', cases: '$[*]',
      bindings: [
        { implementation: 'go', test: 'go/width_test.go', symbol: 'TestWidth' },
        { implementation: 'rust', test: 'rust/src/lib.rs', symbol: 'width::tests::vectors' },
      ],
    },
    {
      id: 'size', kind: 'suite', profile: 'compiled', file: 'tests/vectors/size.json', cases: '$[*]',
      bindings: [
        { implementation: 'go', test: 'go/size_test.go', symbol: 'TestSize' },
        { implementation: 'rust', test: 'rust/tests/size.rs', symbol: 'vectors' },
      ],
    },
    {
      id: 'encode', kind: 'api', profile: 'all',
      symbols: [
        { implementation: 'go', symbol: 'go/codec.go::Encode' },
        { implementation: 'rust', symbol: 'rust/src/lib.rs::encode' },
        { implementation: 'ts', symbol: 'ts/src/index.ts::encode' },
        { implementation: 'php', symbol: 'php/src/Codec.php::Codec::encode' },
        { implementation: 'python', symbol: 'python/codec.py::encode' },
      ],
    },
  ],
  nativeOnly: [{ implementation: 'rust', symbol: 'rust/src/lib.rs::hex_upper', reason: 'the hex helper of the Rust codec, which the crate exports for its benchmarks' }],
  exclusions: [],
  errors: { profile: 'all', catalog: { file: 'docs/errors.yaml', pattern: '^- code: (\\w+)$' } },
  languageLists: [{ file: 'tools/languages.mjs', pattern: 'LANGUAGES = \\[([^\\]]*)\\]', profile: 'all' }],
  documents: { globs: ['docs/**/*.md'], nouns: ['languages', 'implementations', '언어'] },
};

/** A mini repository: FILES with `files` applied (null removes) and the declaration that `edit` returns from a copy of CONFIG. */
function repository(t, { files = {}, edit = config => config } = {}) {
  const all = { ...FILES, ...files, 'config/parity.json': `${JSON.stringify(edit(structuredClone(CONFIG)), null, 2)}\n` };
  const root = tree(t, Object.fromEntries(Object.entries(all).filter(([, text]) => text !== null)));
  chmodSync(path.join(root, 'var/tools/bin/python3'), 0o755);
  return root;
}

/** The findings of the check of a mini repository; `execute` false checks the declarations only. */
function check(t, change, { execute = true } = {}) {
  return checkParity(repository(t, change), { execute, env: ENV, say: () => {} });
}

/** Each finding as `<rule> <unit> <implementation>`, the fields that a finding names. */
const keys = findings => findings.map(finding => [finding.rule, finding.unit ?? '-', finding.implementation ?? '-'].join(' '));

const binding = (config, unit, implementation) => config.units.find(entry => entry.id === unit).bindings.find(entry => entry.implementation === implementation);

test('the declaration of five implementations passes, with every case of every suite executed twice alike', TIMEOUT, (t) => {
  const { findings, ledger } = check(t);
  assert.deepEqual(findings, []);
  assert.deepEqual(ledger.runs.map(run => `${run.unit} ${run.implementation} ${run.attempt} ${run.status}`), [
    'codec go 1 0', 'codec go 2 0', 'codec rust 1 0', 'codec rust 2 0', 'codec ts 1 0', 'codec ts 2 0', 'codec php 1 0', 'codec php 2 0',
    'codec python 1 0', 'codec python 2 0', 'width go 1 0', 'width go 2 0', 'width rust 1 0', 'width rust 2 0', 'size go 1 0', 'size go 2 0',
    'size rust 1 0', 'size rust 2 0',
  ]);
  assert.deepEqual(ledger.cases.map(entry => `${entry.unit} ${entry.implementation} ${entry.case} ${entry.outcome}`), [
    'codec go empty pass', 'codec go ascii pass', 'codec rust empty pass', 'codec rust ascii pass',
    'codec ts empty pass', 'codec ts ascii pass', 'codec php empty pass', 'codec php ascii pass',
    'codec python empty pass', 'codec python ascii pass',
    'width go narrow pass', 'width go wide pass', 'width rust narrow pass', 'width rust wide pass',
    'size go small pass', 'size rust small pass',
  ]);
});

test('a profile narrower than every implementation is printed on every run with what it omits and why', TIMEOUT, (t) => {
  const lines = [];
  const { findings } = checkParity(repository(t), { execute: false, env: ENV, say: line => lines.push(line) });
  assert.deepEqual(findings, []);
  assert.ok(lines.includes('profile compiled omits ts, php, python: the width tables exist only in the compiled implementations'), lines.join('\n'));
});

test('a narrower profile without a reason or with one unit, and an implementation in no profile, fail the declaration', TIMEOUT, (t) => {
  const messages = change => check(t, change, { execute: false }).findings.map(finding => `${finding.rule}: ${finding.message}`);
  assert.deepEqual(messages({ edit: (config) => { delete config.profiles[1].reason; return config; } }), [
    'declaration: profile compiled omits ts, php, python and gives no reason; write the reason in reason',
  ]);
  assert.deepEqual(messages({ edit: (config) => { config.profiles[1].reason = ' '; return config; } }), [
    'declaration: profile compiled omits ts, php, python and gives no reason; write the reason in reason',
  ]);
  assert.deepEqual(messages({ files: { 'go/size_test.go': null, 'rust/tests/size.rs': null, 'tests/vectors/size.json': null }, edit: (config) => { config.units = config.units.filter(unit => unit.id !== 'size'); return config; } }), [
    'declaration: profile compiled omits implementations and only the unit width uses it; a profile groups the units that share its reason, so put the unit in a wider profile or exclude what it lacks',
  ]);
  assert.deepEqual(messages({ edit: (config) => { config.implementations.push({ name: 'kotlin', runner: 'node', roots: ['kotlin'], tests: ['kotlin/*.mjs'] }); config.profiles[0].reason = 'kotlin starts later'; return config; } }), [
    'declaration: the implementation kotlin is in no profile, so no unit applies to it',
  ]);
});

test('each runner runs the native test of its binding', TIMEOUT, (t) => {
  const root = repository(t);
  const { ledger } = checkParity(root, { execute: true, env: ENV, say: () => {} });
  const commands = Object.fromEntries(ledger.runs.map(run => [`${run.unit} ${run.implementation}`, { cwd: run.cwd, command: [run.command, ...run.args] }]));
  assert.deepEqual(commands['codec go'], { cwd: 'go', command: ['go', 'test', '-json', '-count=1', '-run', '^TestCodec$', './'] });
  assert.deepEqual(commands['codec rust'], { cwd: '.', command: ['cargo', 'test', '--manifest-path', 'rust/Cargo.toml', '--test', 'codec', '--', '--test-threads=1', 'vectors::'] });
  assert.deepEqual(commands['width rust'], { cwd: '.', command: ['cargo', 'test', '--manifest-path', 'rust/Cargo.toml', '--lib', '--', '--test-threads=1', 'width::tests::vectors::'] });
  assert.deepEqual(commands['codec ts'], { cwd: '.', command: [process.execPath, '--test', '--test-reporter=tap', 'ts/tests/codec.mjs'] });
  assert.deepEqual(commands['codec php'], { cwd: '.', command: ['php', 'php/vendor/bin/phpunit', '--teamcity', '--no-configuration', 'php/tests/codec.php'] });
  assert.deepEqual(commands['codec python'], { cwd: '.', command: [path.join(root, 'var/tools/bin/python3'), '-m', 'unittest', '-v', 'python/tests/test_codec.py'] });
});

test('an implementation declares the command, the arguments and the environment of its runner', TIMEOUT, (t) => {
  const declare = (withEnvironment) => (config) => {
    const implementation = name => config.implementations.find(entry => entry.name === name);
    Object.assign(implementation('python'), { command: 'python/.venv/bin/python', args: ['-B'], env: withEnvironment ? [{ name: 'PYTHONPATH', value: 'python/src' }, { name: 'REQUIRE_PYTHONPATH', value: '1' }] : [{ name: 'REQUIRE_PYTHONPATH', value: '1' }] });
    implementation('php').args = ['-d', 'extension=php/modules/codec.so'];
    implementation('go').args = ['-tags', 'parity'];
    implementation('rust').args = ['--features', 'vectors'];
    return config;
  };
  const files = { '.gitignore': 'var/\n.venv/\n', 'python/.venv/bin/python': PY_STUB };
  const root = repository(t, { files, edit: declare(true) });
  chmodSync(path.join(root, 'python/.venv/bin/python'), 0o755);
  const { findings, ledger } = checkParity(root, { execute: true, env: ENV, say: () => {} });
  assert.deepEqual(findings, []);
  const commands = Object.fromEntries(ledger.runs.map(run => [`${run.unit} ${run.implementation}`, [run.command, ...run.args]]));
  assert.deepEqual(commands['codec python'], [path.join(root, 'python/.venv/bin/python'), '-B', '-m', 'unittest', '-v', 'python/tests/test_codec.py']);
  assert.deepEqual(commands['codec php'], ['php', '-d', 'extension=php/modules/codec.so', 'php/vendor/bin/phpunit', '--teamcity', '--no-configuration', 'php/tests/codec.php']);
  assert.deepEqual(commands['codec go'], ['go', 'test', '-tags', 'parity', '-json', '-count=1', '-run', '^TestCodec$', './']);
  assert.deepEqual(commands['codec rust'], ['cargo', 'test', '--features', 'vectors', '--manifest-path', 'rust/Cargo.toml', '--test', 'codec', '--', '--test-threads=1', 'vectors::']);
  assert.equal(process.env.REQUIRE_PYTHONPATH, undefined, 'the environment of an implementation reaches only its runs');
  const other = repository(t, { files, edit: declare(false) });
  chmodSync(path.join(other, 'python/.venv/bin/python'), 0o755);
  const missing = checkParity(other, { execute: true, env: ENV, say: () => {} }).findings;
  assert.deepEqual(keys(missing), ['R3 codec python']);
  assert.match(missing[0].message, /exited with 3/);
});

test('a runner value references the invoking environment as ${NAME}, resolved when the bindings run and never printed', TIMEOUT, (t) => {
  const declare = (config) => {
    const implementation = name => config.implementations.find(entry => entry.name === name);
    Object.assign(implementation('python'), { command: '${PARITY_VENV}/bin/python', args: ['-B'], env: [{ name: 'PYTHONPATH', value: '${PARITY_PYTHON}/src' }, { name: 'REQUIRE_PYTHONPATH', value: '1' }] });
    implementation('php').args = ['-d', 'extension=${PARITY_PHP}/codec.so'];
    return config;
  };
  const files = { '.gitignore': 'var/\n.venv/\n', 'python/.venv/bin/python': PY_STUB };
  const root = repository(t, { files, edit: declare });
  chmodSync(path.join(root, 'python/.venv/bin/python'), 0o755);
  const env = { ...ENV, PARITY_VENV: path.join(root, 'python/.venv'), PARITY_PYTHON: 'python', PARITY_PHP: 'php/modules' };
  const lines = [];
  const { findings, ledger } = checkParity(root, { execute: true, env, say: line => lines.push(line) });
  assert.deepEqual(findings, []);
  const commands = Object.fromEntries(ledger.runs.map(run => [`${run.unit} ${run.implementation}`, [run.command, ...run.args]]));
  assert.deepEqual(commands['codec python'], [path.join(root, 'python/.venv/bin/python'), '-B', '-m', 'unittest', '-v', 'python/tests/test_codec.py']);
  assert.deepEqual(commands['codec php'], ['php', '-d', 'extension=php/modules/codec.so', 'php/vendor/bin/phpunit', '--teamcity', '--no-configuration', 'php/tests/codec.php']);
  assert.ok(lines.includes('run codec php (1 of 2): php -d extension=${PARITY_PHP}/codec.so php/vendor/bin/phpunit --teamcity --no-configuration php/tests/codec.php (in .)'), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('php/modules') || line.includes(env.PARITY_VENV)), lines.join('\n'));
  const messages = environment => checkParity(root, { execute: true, env: environment, say: () => {} }).findings.map(finding => `${finding.rule} ${finding.unit} ${finding.implementation}: ${finding.message}`);
  assert.deepEqual(checkParity(root, { execute: false, env: ENV, say: () => {} }).findings, [], 'the declarations do not read the environment');
  const unset = { ...env };
  delete unset.PARITY_PHP;
  assert.deepEqual(messages(unset), ['R3 codec php: cannot start: args references ${PARITY_PHP}, which the environment does not set']);
  assert.deepEqual(messages({ ...env, PARITY_VENV: '' }), ['R3 codec python: cannot start: command references ${PARITY_VENV}, which the environment sets to an empty string']);
  const other = repository(t, { files, edit: (config) => { declare(config).implementations.find(entry => entry.name === 'python').env[0].value = '${PARITY_PYTHON:-python}/src'; return config; } });
  assert.deepEqual(checkParity(other, { execute: false, env, say: () => {} }).findings.map(finding => `${finding.rule}: ${finding.message}`), [
    'declaration: implementation python: env PYTHONPATH holds ${PARITY_PYTHON:-python}, which is no reference; a reference is ${NAME} and has no default',
  ]);
  const empty = repository(t, { files, edit: (config) => { declare(config).implementations.find(entry => entry.name === 'python').command = ''; return config; } });
  assert.deepEqual(checkParity(empty, { execute: true, env, say: () => {} }).findings.map(finding => `${finding.rule}: ${finding.message}`), [
    'declaration: config/parity.json: $.implementations[4].command is "", the schema requires at least 1 characters',
  ]);
});

test('a support file of an implementation is never a test: it lies in its roots and holds no test that its runner runs', TIMEOUT, (t) => {
  const support = { go: ['go/helpers_test.go'], php: ['php/tests/cases.php'], ts: ['ts/tests/case.mjs'] };
  const declare = (extra = {}) => (config) => {
    for (const entry of config.implementations) {
      const globs = [...(support[entry.name] ?? []), ...(extra[entry.name] ?? [])];
      if (globs.length) entry.support = globs;
    }
    return config;
  };
  const helpers = 'package codec\n\nfunc testHelper() {}\nfunc (s suite) TestMethod() {}\nfunc Testing() {}\n';
  const files = { 'go/helpers_test.go': helpers, 'php/tests/cases.php': '<?php\n', 'ts/tests/case.mjs': 'export const cases = [];\n' };
  assert.deepEqual(check(t, { files, edit: declare() }).findings, []);
  const messages = change => check(t, change, { execute: false }).findings.map(finding => `${finding.rule}: ${finding.message}`);
  assert.deepEqual(messages({
    files: { ...files, 'go/helpers_test.go': 'package codec\n\nfunc TestHelper(t *testing.T) {}\nfunc Example() {}\n', 'rust/tests/support.rs': '#[tokio::test]\nasync fn helper() {}\n', 'tools/tests/case.mjs': 'export const cases = [];\n' },
    edit: (config) => { declare({ rust: ['rust/tests/support.rs'], ts: ['tools/tests/case.mjs', 'ts/tests/gone.mjs'] })(config); config.implementations.find(entry => entry.name === 'python').support = ['python/tests/test_codec.py']; return config; },
  }), [
    'declaration: implementation go: the support file go/helpers_test.go declares func TestHelper, which go test runs; a support file holds no test',
    'declaration: implementation go: the support file go/helpers_test.go declares func Example, which go test runs; a support file holds no test',
    'declaration: implementation rust: the support file rust/tests/support.rs holds #[tokio::test], which cargo test runs; a support file holds no test',
    'declaration: implementation ts: the support file tools/tests/case.mjs lies outside ts, the roots of ts',
    'declaration: implementation ts: the support glob ts/tests/gone.mjs selects no test file; remove it',
    'declaration: unit codec: the test python/tests/test_codec.py of python matches its support globs',
  ]);
  // A support file exempts a file only from the pattern of the runner of its implementation.
  assert.deepEqual(messages({ files, edit: (config) => { declare()(config); config.testPatterns.find(pattern => pattern.runner === 'node').globs.push('**/tests/**/*.php'); return config; } }), [
    'R6: a node test outside ts, the roots of the node implementations, and outside tests/compare, the comparator roots; move it into the package of its implementation',
  ]);
  // parity-check runs each node, php and python support file once; a harness line in its output is a test that no binding declares.
  const reporting = check(t, { files: { ...files, 'ts/tests/case.mjs': "import test from 'node:test';\ntest('empty', () => {});\n", 'php/tests/cases.php': 'FAIL test_ascii\n' }, edit: declare() });
  assert.deepEqual(reporting.findings.map(finding => `${finding.rule} ${finding.implementation} ${finding.place}: ${finding.message}`), [
    'R5 ts ts/tests/case.mjs: the support file reports cases (empty); declare it as the test of a binding',
    'R5 php php/tests/cases.php: the support file reports cases (ascii); declare it as the test of a binding',
  ]);
});

test('R1: an API unit whose symbol is missing, not exported or not declared in an implementation fails', TIMEOUT, (t) => {
  const { findings } = check(t, {
    files: {
      'contracts/symbols/go.json': snapshot([['go/codec.go::Encode', false], ['go/codec.go::encodeHost', false]]),
      'contracts/symbols/rust.json': snapshot([['rust/src/lib.rs::hex_upper', true]]),
    },
    edit: config => {
      const unit = config.units.find(entry => entry.id === 'encode');
      unit.symbols = unit.symbols.filter(entry => entry.implementation !== 'python');
      return config;
    },
  }, { execute: false });
  // The python symbol that the unit no longer declares is also an undeclared exported symbol (R11).
  assert.deepEqual(keys(findings), ['R1 encode go', 'R1 encode rust', 'R1 encode python', 'R11 - python']);
  assert.match(findings[0].message, /go\/codec\.go::Encode is not exported/);
  assert.match(findings[1].message, /rust\/src\/lib\.rs::encode is not in contracts\/symbols\/rust\.json/);
  assert.match(findings[2].message, /declares no symbol of python/);
});

test('R2: a suite without a binding of an implementation of its profile fails', TIMEOUT, (t) => {
  const { findings } = check(t, {
    files: { 'python/tests/test_codec.py': null },
    edit: config => {
      const unit = config.units.find(entry => entry.id === 'codec');
      unit.bindings = unit.bindings.filter(entry => entry.implementation !== 'python');
      return config;
    },
  });
  assert.deepEqual(keys(findings), ['R2 codec python']);
  assert.match(findings[0].message, /tests\/vectors\/codec\.json has no binding of python/);
});

test('R3: a binding that fails, misses a case, adds a case or exits with an error fails', TIMEOUT, (t) => {
  const { findings, ledger } = check(t, {
    files: {
      'go/codec_test.go': 'PASS TestCodec/empty\nFAIL TestCodec/ascii\nEXIT TestCodec 1\n',
      'ts/tests/codec.mjs': `${NODE_CODEC}test('latin1', () => {});\n`,
      'php/tests/codec.php': 'PASS test_empty\nPASS test_ascii\nEXIT 2\n',
      'python/tests/test_codec.py': 'PASS test_empty\n',
    },
  });
  assert.deepEqual(keys(findings), ['R3 codec go', 'R3 codec ts', 'R3 codec php', 'R3 codec python']);
  assert.match(findings[0].message, /exited with 1/);
  assert.match(findings[0].message, /failed: ascii/);
  assert.match(findings[1].message, /not in the suite: latin1/);
  assert.match(findings[2].message, /exited with 2/);
  assert.match(findings[3].message, /not executed: ascii/);
  assert.ok(ledger.cases.some(entry => entry.implementation === 'go' && entry.case === 'ascii' && entry.outcome === 'fail'));
});

test('R3: a binding whose second run executes other cases or other results than the first fails, naming the cases', TIMEOUT, (t) => {
  // The test counts its runs in var/ (ignored): the first run passes ascii, the second fails it and adds latin1.
  const flaky = [
    "import test from 'node:test';",
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    'let runs = 0;',
    "try { runs = Number(readFileSync('var/ts-runs', 'utf8')); } catch {}",
    "mkdirSync('var', { recursive: true });",
    "writeFileSync('var/ts-runs', String(runs + 1));",
    "test('empty', () => {});",
    "test('ascii', () => { if (runs) throw new Error('flaky'); });",
    "if (runs) test('latin1', () => {});",
  ].join('\n');
  const { findings, ledger } = check(t, { files: { 'ts/tests/codec.mjs': `${flaky}\n` } });
  assert.deepEqual(keys(findings), ['R3 codec ts']);
  assert.equal(findings[0].message, 'the second run differs from the first: exit 0 then 1; ascii pass then fail; latin1 only in the second run');
  assert.deepEqual(ledger.runs.filter(run => run.implementation === 'ts').map(run => run.attempt), [1, 2]);
});

test('R3: a binding whose runner cannot start fails, and a check of the declarations runs no binding', TIMEOUT, (t) => {
  const root = repository(t);
  rmSync(path.join(root, 'var/tools/bin/python3'));
  const missing = checkParity(root, { execute: true, env: ENV, say: () => {} }).findings;
  assert.deepEqual(keys(missing), ['R3 codec python']);
  assert.match(missing[0].message, /could not start/);
  const declarations = checkParity(root, { execute: false, env: ENV, say: () => {} });
  assert.deepEqual(declarations.findings, []);
  assert.deepEqual(declarations.ledger.runs, []);
});

test('R3: a Go package that does not build names the compiler output', TIMEOUT, (t) => {
  const { findings } = check(t, { files: { 'go/codec_test.go': 'BUILD ./codec_test.go:7:2: undefined: undefinedThing\n' } });
  assert.deepEqual(keys(findings), ['R3 codec go', 'R3 width go', 'R3 size go']);
  assert.equal(findings[0].message, 'exited with 1: ./codec_test.go:7:2: undefined: undefinedThing; not executed: empty, ascii');
});

test('a case name that a runner cannot report, and a Go symbol that is no test function, fail the declaration', TIMEOUT, (t) => {
  const messages = change => check(t, change, { execute: false }).findings.map(finding => `${finding.rule}: ${finding.message}`);
  assert.deepEqual(messages({ files: { 'tests/vectors/codec.json': JSON.stringify({ vectors: [{ name: 'empty' }, { name: 'two words' }, { name: 'a/b' }] }) } }), [
    'declaration: unit codec: tests/vectors/codec.json: the case "two words" holds whitespace, which no test name of the check can match',
    'declaration: unit codec: tests/vectors/codec.json: the case "a/b" holds /, which Go nests as a subtest; the unit has a go binding',
  ]);
  assert.deepEqual(messages({ files: { 'tests/vectors/width.json': JSON.stringify(['a/b']) }, edit: (config) => { binding(config, 'width', 'go').symbol = 'Width'; return config; } }), [
    'declaration: unit width: the go binding names Width, which is no test function (^Test\\w*$)',
    'declaration: unit width: tests/vectors/width.json: the case "a/b" holds /, which Go nests as a subtest; the unit has a go binding',
  ]);
  assert.deepEqual(messages({ files: { 'tests/vectors/size.json': JSON.stringify(['a/b']) }, edit: (config) => { config.units.find(unit => unit.id === 'size').bindings.shift(); config.exclusions.push({ unit: 'size', implementation: 'go', reason: 'r', item: 'T1' }); return config; } }).filter(message => message.startsWith('declaration')), [], 'without a go binding, a harness line reports a case with /');
});

test('R4: a suite file that no unit declares fails', TIMEOUT, (t) => {
  const { findings } = check(t, { files: { 'tests/vectors/events.json': '[]' } }, { execute: false });
  assert.deepEqual(keys(findings), ['R4 - -']);
  assert.equal(findings[0].place, 'tests/vectors/events.json');
});

test('R5: a test file of an implementation that no binding runs fails', TIMEOUT, (t) => {
  const { findings } = check(t, { files: { 'python/tests/test_vector.py': 'PASS codec/empty\n' } }, { execute: false });
  assert.deepEqual(keys(findings), ['R5 - python']);
  assert.equal(findings[0].place, 'python/tests/test_vector.py');
});

test('R6: a binding whose test lies outside the roots of its implementation fails', TIMEOUT, (t) => {
  const { findings } = check(t, {
    files: { 'php/tests/codec.php': null, 'tests/php/codec.php': FILES['php/tests/codec.php'], 'tests/composer.json': '{}\n', 'tests/vendor/bin/phpunit': '' },
    edit: config => { binding(config, 'codec', 'php').test = 'tests/php/codec.php'; return config; },
  });
  assert.deepEqual(keys(findings), ['R6 codec php']);
  assert.match(findings[0].message, /outside php/);
});

test('R6: a test of a runner outside the roots of every implementation of that runner and every comparator root fails', TIMEOUT, (t) => {
  const { findings } = check(t, {
    files: {
      'tools/extra_test.go': 'package tools\n',
      'php/tests/codec_test.go': 'package php\n',
      'tests/compare/all_test.go': 'package compare\n',
      'tests/compare/codec.php': FILES['php/tests/codec.php'],
      'tests/composer.json': '{}\n',
      'tests/vendor/bin/phpunit': '',
      'php/tests/codec.php': null,
    },
    edit: (config) => { binding(config, 'codec', 'php').test = 'tests/compare/codec.php'; return config; },
  });
  assert.deepEqual(findings.map(finding => `${finding.rule} ${finding.place}`), ['R6 php/tests/codec_test.go', 'R6 tools/extra_test.go']);
  assert.match(findings[1].message, /a go test outside go, the roots of the go implementations, and outside tests\/compare, the comparator roots/);
});

test('the whole repository is no root, and an implementation has test globs', TIMEOUT, (t) => {
  const messages = change => check(t, change, { execute: false }).findings.map(finding => `${finding.rule}: ${finding.message}`);
  assert.deepEqual(messages({ edit: (config) => { config.implementations[0].roots = ['.']; config.comparators = ['./']; return config; } }), [
    'declaration: implementation go: the root . is the whole repository; name the directories of the implementation',
    'declaration: comparators: the root ./ is the whole repository; name the directories of the comparators',
  ]);
  assert.deepEqual(messages({ edit: (config) => { config.implementations[0].tests = []; return config; } }), [
    'declaration: config/parity.json: $.implementations[0].tests has 0 items, the schema requires at least 1',
  ]);
});

test('R7: an implementation whose error codes differ from the catalog, or that declares none, fails', TIMEOUT, (t) => {
  const { findings } = check(t, {
    files: { 'python/codes.py': 'CONFIG = "CONFIG"\nEXTRA = "EXTRA"\n' },
    edit: config => { delete config.implementations.find(entry => entry.name === 'php').errors; return config; },
  }, { execute: false });
  assert.deepEqual(keys(findings), ['R7 - php', 'R7 - python']);
  assert.match(findings[0].message, /declares no error codes/);
  assert.match(findings[1].message, /missing CODEC_DECODE/);
  assert.match(findings[1].message, /not in the catalog: EXTRA/);
});

test('the catalog pattern reads every line of the catalog that is not blank or a comment, and reads at least one code', TIMEOUT, (t) => {
  const messages = change => check(t, change, { execute: false }).findings.map(finding => `${finding.rule} ${finding.place}: ${finding.message}`);
  assert.deepEqual(messages({ files: { 'docs/errors.yaml': '# The codes.\n\n- code: CONFIG # a missing secret\n- code: CODEC_DECODE\n' } }), [
    'declaration docs/errors.yaml:3: the catalog pattern ^- code: (\\w+)$ does not read the line "- code: CONFIG # a missing secret"; write a pattern that reads every line of the catalog',
  ]);
  assert.deepEqual(messages({ files: { 'docs/errors.yaml': '# The codes.\n// none yet\n' } }), [
    'declaration docs/errors.yaml: the catalog pattern ^- code: (\\w+)$ reads no code',
  ]);
  assert.deepEqual(messages({ files: { 'python/codes.py': '# generated\n' } }), [
    'declaration python/codes.py: the pattern ^\\w+ = "(\\w+)"$ of python reads no code',
  ]);
  assert.deepEqual(messages({
    files: { 'docs/errors.yaml': 'codes:\n  - code: CONFIG\n    meaning: a missing secret\n  - code: CODEC_DECODE\n' },
    edit: (config) => { config.errors.catalog.pattern = '^  - code: (\\w+)$|^codes:$|^    \\w+: .*$'; return config; },
  }), [], 'a line that the pattern matches without its group holds no code');
});

test('R8: an exclusion is always a finding, with its reason and item', TIMEOUT, (t) => {
  const change = {
    files: { 'python/tests/test_codec.py': null },
    edit: config => {
      const unit = config.units.find(entry => entry.id === 'codec');
      unit.bindings = unit.bindings.filter(entry => entry.implementation !== 'python');
      config.exclusions.push({ unit: 'codec', implementation: 'python', reason: 'the Python harness reports no cases yet', item: 'T76-1' });
      return config;
    },
  };
  for (const execute of [false, true]) {
    const { findings } = check(t, change, { execute });
    assert.deepEqual(keys(findings), ['R8 codec python']);
    assert.match(findings[0].message, /excluded: the Python harness reports no cases yet \(T76-1\)/);
  }
});

test('R9: a language list of another file that differs from its profile fails', TIMEOUT, (t) => {
  const { findings } = check(t, { files: { 'tools/languages.mjs': "export const LANGUAGES = ['go', 'rust', 'ts', 'php'];\n" } }, { execute: false });
  assert.deepEqual(keys(findings), ['R9 - -']);
  assert.match(findings[0].message, /missing python/);
  assert.equal(findings[0].place, 'tools/languages.mjs:1');
});

test('R10: a document that counts or lists the implementations unlike every profile fails', TIMEOUT, (t) => {
  const { findings } = check(t, {
    files: {
      'docs/index.md': '# Codec\n\nFour languages share the codec.\nGo, PHP, Rust, and TS share one contract.\n',
      'docs/index.ko.md': '# Codec\n\n네 언어가 codec을 공유한다.\n',
    },
  }, { execute: false });
  assert.deepEqual(findings.map(finding => `${finding.rule} ${finding.place}`), ['R10 docs/index.ko.md:3', 'R10 docs/index.md:3', 'R10 docs/index.md:4']);
  assert.match(findings[1].message, /Four languages/);
  assert.match(findings[2].message, /go, php, rust, ts/);
});

test('R10: a count or a list is judged with the implementations of its sentence, read from the prose of a Markdown passage', TIMEOUT, (t) => {
  // Each paragraph, and the findings that it gives: `count` or `list`, at its first line or at the line after @.
  const paragraphs = [
    ['The codec has one language.', ['count']],
    ['Both implementations, Go and Rust, compile ahead of time.', []],
    ['Both implementations, Go and PHP, compile ahead of time.', ['count']],
    ['The four-language check runs the vectors.', ['count']],
    ['Three languages share the planner: Go, Rust and TS.', ['count', 'list']],
    ['Five languages share the codec: Go, Rust, TS, PHP and Python.', []],
    ['Go `x`, PHP `y`, Rust `z`, and TS `w` share one contract.', ['list']],
    ['Go, PHP, Rust and TS share the contract. Python is planned.', ['list']],
    ['Go, PHP, Rust and TS share the contract (see `python/src`).', ['list']],
    ['Go, PHP, Rust and TS share it, as [the guide](https://x/python/guide) and <https://x/python> say.', ['list']],
    ['> Go, PHP, Rust\n> and TS share the contract.', ['list']],
    ['Python\n------\nGo, PHP, Rust and TS share the contract.', ['list@3']],
    ['Go, PHP, Rust and TS share the contract.\n<!-- python --> <span title="python">x</span>', ['list']],
    ['```markdown\n~~~\n```\nGo, PHP,\nRust and TS share the contract.', ['list@4']],
    ['Go, Rust and TS generate the methods; PHP and Python resolve them.', []],
    ['| Go, PHP, Rust and TS | shared | Python |', ['list']],
    ['1. Go, PHP,\n   Rust and TS share it.\n2. Python reads it.', ['list']],
    ['#5 names Go, PHP, Rust and TS\n# Python', ['list']],
    ['    Go, PHP, Rust and TS share it in an indented code block.', []],
  ];
  const lines = ['# Codec', ''];
  const expected = [];
  for (const [text, kinds] of paragraphs) {
    for (const kind of kinds) {
      const [name, offset] = kind.split('@');
      expected.push(`R10 docs/index.md:${lines.length + Number(offset ?? 1)} ${name}`);
    }
    lines.push(...text.split('\n'), '');
  }
  const { findings } = check(t, {
    files: {
      'docs/index.md': lines.join('\n'),
      'docs/index.ko.md': '# Codec\n\n다섯 언어가 codec을 공유한다: Go, Rust, TS, PHP와 Python.\n\n검사를 한 언어에서 실행한다.\n\norm은 6개 언어로 배포된다.\n\ncodec은 다섯 개 언어로 구현된다.\n\n세 가지 언어가 planner를 공유한다.\n',
    },
    edit: (config) => { config.documents.nouns.push('language'); return config; },
  }, { execute: false });
  const kind = finding => (finding.message.startsWith('the list') ? 'list' : 'count');
  assert.deepEqual(findings.map(finding => `${finding.rule} ${finding.place} ${kind(finding)}`), [
    'R10 docs/index.ko.md:5 count', 'R10 docs/index.ko.md:7 count', 'R10 docs/index.ko.md:11 count', ...expected,
  ]);
  const message = place => findings.filter(finding => finding.place === place).map(finding => finding.message);
  assert.deepEqual(message(`docs/index.md:${3 + 2 * 4}`), [
    '"Three languages" counts 3, and no profile of 3 implementations holds go, rust, ts, the implementations of its sentence (all 5, compiled 2)',
    'the list go, rust, ts is in a sentence that names go, rust, ts, which is no profile (all: go, rust, ts, php, python; compiled: go, rust)',
  ]);
});

test('R11: an exported symbol that no API unit and no native-only entry declares fails', TIMEOUT, (t) => {
  const { findings } = check(t, {
    files: { 'contracts/symbols/ts.json': snapshot([['ts/src/index.ts::encode', true], ['ts/src/index.ts::orderedJsonOutput', true], ['ts/src/index.ts::hidden', false]]) },
  }, { execute: false });
  assert.deepEqual(keys(findings), ['R11 - ts']);
  assert.match(findings[0].message, /ts\/src\/index\.ts::orderedJsonOutput/);
});

test('a declaration that breaks its schema fails, and no rule runs on it', TIMEOUT, (t) => {
  const { findings } = check(t, { edit: (config) => { config.extra = true; config.units[0].kind = 'vector'; return config; } });
  assert.deepEqual(findings.map(finding => `${finding.rule}: ${finding.message}`), [
    'declaration: config/parity.json: $.units[0].kind is "vector", the schema allows "suite", "api"',
    'declaration: config/parity.json: $.extra is not in the schema',
  ]);
});

test('a declaration that names what does not exist or holds a stale entry fails, and no rule runs on it', TIMEOUT, (t) => {
  const { findings, ledger } = check(t, {
    files: { 'tests/vectors/width.json': JSON.stringify(['narrow', 'narrow']) },
    edit: (config) => {
      config.profiles[1].implementations.push('swift');
      config.nativeOnly.push({ implementation: 'go', symbol: 'go/codec.go::encodeHost', reason: 'not exported, so the entry is stale' });
      binding(config, 'codec', 'php').test = 'php/tests/missing.php';
      delete binding(config, 'codec', 'go').symbol;
      config.exclusions.push({ unit: 'codec', implementation: 'ts', reason: 'bound and excluded', item: 'T1' });
      config.languageLists[0].pattern = 'LANGUAGES = [^\\]]*';
      return config;
    },
  });
  const messages = findings.map(finding => `${finding.rule}: ${finding.message}`);
  assert.ok(findings.every(finding => finding.rule === 'declaration'), messages.join('\n'));
  assert.deepEqual(ledger.runs, []);
  for (const expected of [
    /profile compiled names swift, which is no implementation/,
    /go\/codec\.go::encodeHost is not an exported symbol of go/,
    /the test php\/tests\/missing\.php of php does not exist/,
    /the binding of go needs symbol/,
    /exclusions: codec declares ts; remove the exclusion or the declaration/,
    /languageLists tools\/languages\.mjs: the pattern LANGUAGES = \[\^\\\]\]\* has no group/,
    /tests\/vectors\/width\.json repeats the case narrow/,
  ]) assert.ok(messages.some(message => expected.test(message)), `${expected} in\n${messages.join('\n')}`);
});

test('make parity-check and parity-declarations-check pass without a finding; parity.mjs exits 1 on one', TIMEOUT, (t) => {
  const root = repository(t);
  cpSync(KIT, path.join(root, 'scripts/kit'), { recursive: true });
  const make = target => spawnSync('make', ['--no-print-directory', '-f', 'scripts/kit/kit.mk', target], { cwd: root, env: ENV, encoding: 'utf8' });
  const passed = make('parity-check');
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /\[parity\] run codec go \(1 of 2\): go test -json -count=1 -run \^TestCodec\$ \.\//);
  assert.match(passed.stdout, /\[parity\] every unit holds in every implementation/);
  writeFileSync(path.join(root, 'python/tests/test_codec.py'), 'PASS test_empty\n');
  assert.equal(make('parity-declarations-check').status, 0, 'the declarations do not run the bindings');
  assert.notEqual(make('parity-check').status, 0);
  const failed = spawnSync(process.execPath, ['scripts/kit/parity.mjs'], { cwd: root, env: ENV, encoding: 'utf8' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /\[parity\] R3 not-executed codec python python\/tests\/test_codec\.py: .*not executed: ascii/);
  assert.match(failed.stderr, /\[parity\] 1 findings/);
});

test('K33 reads the TeamCity messages of a PHPUnit run through the php runner: a class is a group, a method a case (K47)', TIMEOUT, (t) => {
  // The messages of PHPUnit 11 for a class with a passing and a failing test method, as the php runner reads them.
  const teamcity = [
    "##teamcity[testSuiteStarted name='CodecTest' locationHint='php_qn://php/tests/codec.php::\\\\CodecTest' nodeId='1' parentNodeId='0']",
    "##teamcity[testStarted name='test_empty' locationHint='php_qn://php/tests/codec.php::\\\\CodecTest::test_empty' nodeId='2' parentNodeId='1']",
    "##teamcity[testFinished name='test_empty' duration='1' nodeId='2' parentNodeId='1']",
    "##teamcity[testStarted name='test_ascii' locationHint='php_qn://php/tests/codec.php::\\\\CodecTest::test_ascii' nodeId='3' parentNodeId='1']",
    "##teamcity[testFailed name='test_ascii' message='Failed asserting that false is true.' details='php/tests/codec.php:9' nodeId='3' parentNodeId='1']",
    "##teamcity[testFinished name='test_ascii' duration='2' nodeId='3' parentNodeId='1']",
    "##teamcity[testSuiteFinished name='CodecTest' nodeId='1' parentNodeId='0']",
    'EXIT 1',
  ].join('\n');
  const { findings, ledger } = check(t, { files: { 'php/tests/codec.php': `${teamcity}\n` } });
  assert.deepEqual(keys(findings), ['R3 codec php']);
  assert.equal(findings[0].message, 'exited with 1; failed: ascii');
  assert.deepEqual(ledger.cases.filter(entry => entry.implementation === 'php').map(entry => `${entry.case} ${entry.outcome}`), ['empty pass', 'ascii fail']);
});

test('R3: a case that one run reports twice fails, and the finding names the case (K47)', TIMEOUT, (t) => {
  const { findings } = check(t, { files: { 'go/codec_test.go': 'PASS TestCodec/empty\nPASS TestCodec/empty\nPASS TestCodec/ascii\n' } });
  assert.deepEqual(keys(findings), ['R3 codec go']);
  assert.equal(findings[0].message, 'reported twice in run 1: empty; reported twice in run 2: empty');
});

test('a case that the admit list of its suite does not name is not run for the implementation, and every run prints it (K47)', TIMEOUT, (t) => {
  const vectors = JSON.stringify({ vectors: [{ name: 'empty' }, { name: 'ascii', kinds: ['go', 'rust', 'ts', 'php'] }] });
  const edit = (config) => { config.units.find(unit => unit.id === 'codec').admit = 'kinds'; return config; };
  const lines = [];
  const root = repository(t, { files: { 'tests/vectors/codec.json': vectors, 'python/tests/test_codec.py': 'PASS test_empty\n' }, edit });
  const { findings, ledger } = checkParity(root, { execute: true, env: ENV, say: line => lines.push(line) });
  assert.deepEqual(findings, []);
  assert.ok(lines.includes('unit codec does not run ascii for python: kinds lists go, rust, ts, php'), lines.join('\n'));
  assert.deepEqual(ledger.cases.filter(entry => entry.implementation === 'python').map(entry => entry.case), ['empty']);
  const reported = check(t, { files: { 'tests/vectors/codec.json': vectors, 'python/tests/test_codec.py': 'PASS test_empty\nPASS test_ascii\n' }, edit });
  assert.deepEqual(keys(reported.findings), ['R3 codec python']);
  assert.match(reported.findings[0].message, /not in the suite: ascii/);
  const declared = (kinds) => check(t, { files: { 'tests/vectors/codec.json': JSON.stringify({ vectors: [{ name: 'empty' }, { name: 'ascii', kinds }] }) }, edit }, { execute: false }).findings.map(finding => `${finding.rule}: ${finding.message}`);
  assert.deepEqual(declared(['go', 'kotlin']), ['declaration: unit codec: case ascii admits kotlin, which is not an implementation of the profile all']);
  assert.deepEqual(declared('go'), ['declaration: unit codec: case ascii has kinds that is no array of implementation names']);
});

test('the PHPUnit run names the configuration of its package, phpunit.xml or phpunit.xml.dist, or none (K47)', TIMEOUT, (t) => {
  const args = files => runOf({ name: 'php', runner: 'php' }, repository(t, { files }), { implementation: 'php', test: 'php/tests/codec.php' }, 'codec', ENV).args;
  assert.deepEqual(args({}), ['php/vendor/bin/phpunit', '--teamcity', '--no-configuration', 'php/tests/codec.php']);
  assert.deepEqual(args({ 'php/phpunit.xml': '<phpunit/>\n' }), ['php/vendor/bin/phpunit', '--teamcity', '--configuration', 'php/phpunit.xml', 'php/tests/codec.php']);
  assert.deepEqual(args({ 'php/phpunit.xml.dist': '<phpunit/>\n' }), ['php/vendor/bin/phpunit', '--teamcity', '--configuration', 'php/phpunit.xml.dist', 'php/tests/codec.php']);
});

test('admit: an implementation that admits no case, a key on no case, an empty list and a repeated name are declaration findings (K47)', TIMEOUT, (t) => {
  const edit = (config) => { config.units.find(unit => unit.id === 'codec').admit = 'kinds'; return config; };
  const all = ['go', 'rust', 'ts', 'php', 'python'];
  const findings = (vectors, change = {}) => check(t, { files: { 'tests/vectors/codec.json': JSON.stringify({ vectors }), ...change.files }, edit: change.edit ?? edit }, { execute: false }).findings.map(finding => `${finding.rule} ${finding.message}`);
  // python admits no case of the suite: the finding names the implementation and the way out.
  const none = findings([{ name: 'empty', kinds: ['go', 'rust', 'ts', 'php'] }, { name: 'ascii', kinds: ['go', 'rust', 'ts', 'php'] }]);
  assert.equal(none.length, 1, none.join('\n'));
  assert.match(none[0], /^declaration unit codec: no case of .* admits python, so the suite runs nothing.*R8/);
  // An excluded implementation is reported by R8 only.
  const excluded = findings([{ name: 'empty', kinds: ['go', 'rust', 'ts', 'php'] }, { name: 'ascii', kinds: ['go', 'rust', 'ts', 'php'] }], {
    files: { 'python/tests/test_codec.py': null },
    edit: (config) => {
      edit(config);
      config.units.find(unit => unit.id === 'codec').bindings = config.units.find(unit => unit.id === 'codec').bindings.filter(entry => entry.implementation !== 'python');
      config.exclusions.push({ unit: 'codec', implementation: 'python', reason: 'the Python harness reports no cases yet', item: 'T76-1' });
      return config;
    },
  });
  assert.deepEqual(excluded.map(line => line.split(' ')[0]), ['R8']);
  // A key that no case has, an empty list and a repeated name.
  assert.match(findings([{ name: 'empty' }, { name: 'ascii' }]).join('\n'), /^declaration unit codec: .*no case of .* has kinds/m);
  assert.match(findings([{ name: 'empty', kinds: [] }, { name: 'ascii', kinds: all }]).join('\n'), /declaration unit codec: .*case empty has kinds that is empty/);
  assert.match(findings([{ name: 'empty', kinds: ['go', 'go', 'rust', 'ts', 'php', 'python'] }, { name: 'ascii', kinds: all }]).join('\n'), /declaration unit codec: .*case empty lists go twice/);
});

