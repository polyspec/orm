// The dbspec-fmt command line (docs/plans/editor-stack.md T128-5): one path without a mode prints the formatted text,
// `-` and no path read standard input, several paths need --write or --check, stderr lines are
// `path:line:col: LABEL: message`, every path is processed and the highest exit code wins, and each file's document
// set comes from resolveSet. The editor fixtures of tests/editor run through --check and --write.
//
// Usage: node --test packages/dbspec-language/tests/cli.test.mjs (after the build)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, PROCESS } from '../../../tests/testcase.mts';
import { codePointIndex, parserLines, repo } from './helpers.mjs';

// Each case runs node as a child process (PROCESS).
const vector = (name, body) => caseTest(name, PROCESS, body);

const bin = fileURLToPath(new URL('../bin/dbspec-fmt.mjs', import.meta.url));
const editor = fileURLToPath(new URL('tests/editor/', repo));

/** Runs dbspec-fmt with the arguments in `cwd`, with `input` on standard input. */
function run(args, cwd, input = '') {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, input, encoding: 'utf8' });
  assert.equal(result.error, undefined, `dbspec-fmt starts: ${result.error}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs body in a new temporary directory that holds the files of `files`, and removes the directory. */
function inDir(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'dbspec-fmt-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const canonical = 'dbspec 1 shop\n\ntable item {\n  id i64 identity\n  primary key (id)\n}\n';
const unformatted = 'dbspec 1 shop\n\ntable   item {\n id i64 identity\n primary key (id)\n}\n';
const billing = 'dbspec 1 billing\n\nuse shop { item }\n\ntable invoice {\n  id i64 identity\n  item_id i64\n  primary key (id)\n  index ix_invoice_item (item_id)\n  foreign key fk_invoice_item (item_id) references item (id) on delete restrict on update restrict\n}\n';
const broken = 'dbspec 1 shop\n\ntable item {\n  id i64 identity\n  primary key (id)\n';

vector('one path without a mode prints the formatted text and changes nothing', () => inDir({ 'a.dbs': unformatted }, dir => {
  assert.deepEqual(run(['a.dbs'], dir), { status: 0, stdout: canonical, stderr: '' });
  assert.equal(readFileSync(join(dir, 'a.dbs'), 'utf8'), unformatted);
}));

vector('- reads standard input and writes standard output', () => inDir({}, dir => {
  assert.deepEqual(run(['-'], dir, unformatted), { status: 0, stdout: canonical, stderr: '' });
}));

vector('no path reads standard input', () => inDir({}, dir => {
  assert.deepEqual(run([], dir, unformatted), { status: 0, stdout: canonical, stderr: '' });
}));

vector('--check of standard input prints <stdin> when it is not formatted', () => inDir({}, dir => {
  assert.deepEqual(run(['--check', '-'], dir, unformatted), { status: 1, stdout: '<stdin>\n', stderr: '' });
  assert.deepEqual(run(['--check'], dir, canonical), { status: 0, stdout: '', stderr: '' });
}));

vector('a parse diagnostic of standard input is reported at <stdin>', () => inDir({}, dir => {
  const result = run(['-'], dir, broken);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^<stdin>:3:12: syntax: .+\n$/);
}));

vector('the arguments that are refused exit 2 with the usage', () => inDir({ 'a.dbs': canonical, 'b.dbs': canonical }, dir => {
  for (const [args, message] of [
    [['a.dbs', 'b.dbs'], 'several paths require --write or --check'],
    [['--write', '-'], '--write requires a path'],
    [['--write'], '--write requires a path'],
    [['--check', '-', 'a.dbs'], '"-" cannot be combined with other paths'],
    [['--write', '--check', 'a.dbs'], '--write and --check cannot be combined'],
    [['--indent', '4', 'a.dbs'], "Unknown option '--indent'"],
  ]) {
    const result = run(args, dir);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(`dbspec-fmt: ${message}`), result.stderr);
    assert.ok(result.stderr.includes('usage: dbspec-fmt [--write | --check] [PATH ...]'), result.stderr);
  }
}));

vector('--help prints the usage and exits 0', () => inDir({}, dir => {
  const result = run(['--help'], dir);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.startsWith('usage: dbspec-fmt [--write | --check] [PATH ...]'), result.stdout);
}));

vector('--check exits 1 for an unformatted file and prints its path; it changes nothing', () => inDir({ 'a.dbs': unformatted, 'b.dbs': canonical }, dir => {
  assert.deepEqual(run(['--check', 'a.dbs', 'b.dbs'], dir), { status: 1, stdout: 'a.dbs\n', stderr: '' });
  assert.equal(readFileSync(join(dir, 'a.dbs'), 'utf8'), unformatted);
  assert.deepEqual(run(['--check', 'b.dbs'], dir), { status: 0, stdout: '', stderr: '' });
}));

vector('--write rewrites an unformatted file, prints its path and leaves a formatted one', () => inDir({ 'a.dbs': unformatted, 'b.dbs': canonical }, dir => {
  assert.deepEqual(run(['--write', 'a.dbs', 'b.dbs'], dir), { status: 0, stdout: 'a.dbs\n', stderr: '' });
  assert.equal(readFileSync(join(dir, 'a.dbs'), 'utf8'), canonical);
  assert.deepEqual(run(['--write', 'a.dbs', 'b.dbs'], dir), { status: 0, stdout: '', stderr: '' });
}));

vector('every path is processed and the highest exit code wins', () => inDir({ 'a.dbs': unformatted, 'bad.dbs': broken, 'c.dbs': unformatted }, dir => {
  const result = run(['--check', 'a.dbs', 'bad.dbs', 'missing.dbs', 'c.dbs'], dir);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, 'a.dbs\nc.dbs\n');
  const lines = result.stderr.split('\n');
  assert.equal(lines.length, 3, result.stderr);
  assert.match(lines[0], /^bad\.dbs:3:12: syntax: /);
  assert.match(lines[1], /^dbspec-fmt: missing\.dbs: cannot be read: /);
  assert.equal(lines[2], '');
  const written = run(['--write', 'a.dbs', 'bad.dbs', 'c.dbs'], dir);
  assert.equal(written.status, 2);
  assert.equal(written.stdout, 'a.dbs\nc.dbs\n');
  assert.equal(readFileSync(join(dir, 'c.dbs'), 'utf8'), canonical);
  assert.equal(readFileSync(join(dir, 'bad.dbs'), 'utf8'), broken);
}));

vector('a file that fails the byte check is reported at its position', () => inDir({ 'a.dbs': 'shop\n' }, dir => {
  assert.deepEqual(run(['a.dbs'], dir), { status: 2, stdout: '', stderr: 'a.dbs:1:1: signature: a.dbs is not a dbspec document\n' });
}));

vector('a directory is not walked: it is a path that cannot be read', () => inDir({ 'sub/a.dbs': canonical }, dir => {
  const result = run(['--check', 'sub'], dir);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^dbspec-fmt: sub: cannot be read: .+\n$/);
}));

vector('each file takes its set from resolveSet', () => inDir({
  'app/dbspec-set.json': JSON.stringify({ schema: 1, documents: ['shop.dbs', 'billing.dbs'] }),
  'app/shop.dbs': canonical,
  'app/billing.dbs': billing,
  'alone/billing.dbs': billing,
}, dir => {
  assert.deepEqual(run(['--check', 'app/billing.dbs', 'app/shop.dbs'], dir), { status: 0, stdout: '', stderr: '' });
  const alone = run(['--check', 'alone/billing.dbs'], dir);
  assert.equal(alone.status, 2);
  assert.equal(alone.stderr, 'alone/billing.dbs:3:5: use: document shop is not in the declared document set\n');
}));

vector('a set error is reported with the set file and the file is not changed', () => inDir({
  'app/dbspec-set.json': JSON.stringify({ schema: 1, documents: ['shop.dbs', 'missing.dbs'] }),
  'app/shop.dbs': unformatted,
}, dir => {
  const result = run(['--write', 'app/shop.dbs'], dir);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^dbspec-fmt: set\.file: .*app\/missing\.dbs.*\n$/);
  assert.equal(readFileSync(join(dir, 'app/shop.dbs'), 'utf8'), unformatted);
}));

vector('a diagnostic of another file of the set is reported, and the file is still formatted', () => inDir({
  'app/dbspec-set.json': JSON.stringify({ schema: 1, documents: ['shop.dbs', 'notes.dbs'] }),
  'app/shop.dbs': unformatted,
  'app/notes.dbs': 'notes\n',
}, dir => {
  const result = run(['--write', 'app/shop.dbs'], dir);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, 'app/shop.dbs\n');
  assert.match(result.stderr, /^.*app\/notes\.dbs:1:1: signature: .*app\/notes\.dbs is not a dbspec document\n$/);
  assert.equal(readFileSync(join(dir, 'app/shop.dbs'), 'utf8'), canonical);
}));

// The editor fixtures: --check exits 0 for a formatted fixture, 1 for one that formats to other text and 2 for one with
// a diagnostic, which is printed at its line and code point column; --write leaves the formatted text.
const fixtures = readdirSync(editor).filter(f => f.endsWith('.dbs')).sort();
assert.ok(fixtures.length >= 4, 'the editor fixtures');
for (const name of fixtures) {
  vector(`editor fixture ${name} through --check and --write`, () => inDir({}, dir => {
    copyFileSync(join(editor, name), join(dir, name));
    const text = readFileSync(join(editor, name), 'utf8');
    const expected = JSON.parse(readFileSync(join(editor, name.replace(/\.dbs$/, '.json')), 'utf8'));
    const lines = parserLines(text);
    const stderr = expected.diagnostics.map(d => {
      const [line, character] = d.range[0];
      return `${name}:${line + 1}:${codePointIndex(lines[line], character) + 1}: ${d.rule}: ${d.message}\n`;
    }).join('');
    if (expected.formatted === null) {
      assert.deepEqual(run(['--check', name], dir), { status: 2, stdout: '', stderr });
      assert.deepEqual(run(['--write', name], dir), { status: 2, stdout: '', stderr });
      assert.equal(readFileSync(join(dir, name), 'utf8'), text);
      return;
    }
    const changed = expected.formatted !== text;
    assert.deepEqual(run(['--check', name], dir), { status: changed ? 1 : 0, stdout: changed ? `${name}\n` : '', stderr: '' });
    assert.deepEqual(run(['--write', name], dir), { status: 0, stdout: changed ? `${name}\n` : '', stderr: '' });
    assert.equal(readFileSync(join(dir, name), 'utf8'), expected.formatted);
    assert.deepEqual(run(['--check', name], dir), { status: 0, stdout: '', stderr: '' });
  }));
}
