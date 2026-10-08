// Tests of scripts/kit/check-commits.mjs: each rule of a commit message has a passing and a failing case, and the command
// reads a range, a message file and the configuration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fileMessage, messageFindings, rangeFindings } from '../../scripts/kit/check-commits.mjs';
import { put, tree } from './tree.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/kit');
const CONFIG = { schema: 1, types: ['feat', 'fix', 'docs'], subjectMax: 50, bodyMax: 72 };
const rules = message => messageFindings(message, CONFIG).map(found => found.rule);

test('a message with a subject, a blank line and a wrapped body passes', () => {
  assert.deepEqual(rules('feat(docs): Merge the document checks (#K7.1)\n\nReplace the checks of the\nrepositories.\n\nCo-Authored-By: Name <a@b.c>\n'), []);
  assert.deepEqual(rules('fix(ci): Run every target (#T22.4-19-1)'), []);
});

test('commit-subject: the type, the scope and the id are required', () => {
  for (const subject of ['Merge the checks', 'chore(docs): Merge the checks (#K1)', 'feat: Merge the checks (#K1)', 'feat(Docs): Merge the checks (#K1)', 'feat(docs): Merge the checks', 'feat(docs): Merge the checks (K1)', 'feat(docs):  (#K1)']) {
    assert.deepEqual(rules(subject), ['commit-subject'], subject);
  }
  const [found] = messageFindings('chore(docs): Merge the checks (#K1)', CONFIG);
  assert.equal(found.message, 'the subject is "chore(docs): Merge the checks (#K1)"; expected "type(scope): Subject (#id)" with a type of feat, fix, docs');
});

test('commit-capital, commit-period and commit-length: the Subject', () => {
  assert.deepEqual(rules('feat(docs): merge the checks (#K1)'), ['commit-capital']);
  assert.deepEqual(rules('feat(docs): Merge the checks. (#K1)'), ['commit-period']);
  assert.deepEqual(rules(`feat(docs): ${'A'.repeat(50)} (#K1)`), []);
  const long = messageFindings(`feat(docs): ${'A'.repeat(51)} (#K1)`, CONFIG);
  assert.deepEqual(long.map(found => [found.rule, found.message]), [['commit-length', 'the Subject has 51 characters; expected at most 50']]);
});

test('commit-blank and commit-width: the body', () => {
  assert.deepEqual(rules('feat(docs): Merge the checks (#K1)\nbody without a blank line'), ['commit-blank']);
  const wide = `feat(docs): Merge the checks (#K1)\n\n${'word '.repeat(15)}\nshort\n${'x'.repeat(100)}\n`;
  const found = messageFindings(wide, CONFIG);
  assert.deepEqual(found.map(entry => entry.rule), ['commit-width']);
  assert.match(found[0].message, /^line 3 of the message has 75 characters; expected at most 72; wrap the body$/);
  assert.deepEqual(rules(`feat(docs): Merge the checks (#K1)\n\n${'word '.repeat(14)}ab`), []);
});

test('a message file loses its comment lines, and a merge commit is not checked', () => {
  assert.equal(fileMessage('# comment\nfeat(docs): Merge the checks (#K1)\n# more\n'), 'feat(docs): Merge the checks (#K1)\n');
  assert.equal(fileMessage('Merge branch x\n'), null);
});

function repository(t, messages) {
  const root = tree(t, { 'config/commits.json': JSON.stringify(CONFIG) });
  cpSync(KIT, path.join(root, 'scripts/kit'), { recursive: true });
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });
  messages.forEach((message, index) => {
    put(root, { [`f${index}.txt`]: String(index) });
    git('add', '-A');
    const result = git('commit', '-q', '-m', message);
    assert.equal(result.status, 0, result.stderr);
  });
  return { root, git };
}

test('the commits of a range are checked and each finding names the commit', (t) => {
  const { root, git } = repository(t, ['feat(docs): Start (#K1)', 'bad subject', 'fix(ci): Fine (#K2)']);
  const findings = rangeFindings(root, 'HEAD~2..HEAD', CONFIG);
  const bad = git('rev-parse', '--short', 'HEAD~1').stdout.trim();
  assert.equal(findings.length, 1);
  assert.match(findings[0], new RegExp(`^${bad}\\w*: commit-subject: the subject is "bad subject"`));
  assert.deepEqual(rangeFindings(root, 'HEAD', CONFIG), [], 'HEAD alone is the last commit');
  assert.throws(() => rangeFindings(root, 'nonsense', CONFIG), /the range "nonsense" is not <base>\.\.<head>/);
  assert.throws(() => rangeFindings(root, 'nothere..HEAD', CONFIG), /the range nothere\.\.HEAD does not resolve in this checkout: .*; fetch its commits/);
});

test('a merge commit in the range is not checked', (t) => {
  const { root, git } = repository(t, ['feat(docs): Start (#K1)']);
  git('checkout', '-q', '-b', 'side');
  put(root, { 'side.txt': 'x' });
  git('add', '-A');
  git('commit', '-q', '-m', 'fix(ci): Side (#K2)');
  git('checkout', '-q', '-');
  put(root, { 'main.txt': 'x' });
  git('add', '-A');
  git('commit', '-q', '-m', 'fix(ci): Main (#K3)');
  const merged = git('merge', '--no-ff', '-m', 'Merge branch side', 'side');
  assert.equal(merged.status, 0, merged.stderr);
  assert.deepEqual(rangeFindings(root, 'HEAD~2..HEAD', CONFIG), []);
});

test('the command checks a range or a message file and exits with the findings', (t) => {
  const { root } = repository(t, ['feat(docs): Start (#K1)', 'bad subject']);
  const command = (...args) => spawnSync(process.execPath, ['scripts/kit/check-commits.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const range = command('--range', 'HEAD~1..HEAD');
  assert.equal(range.status, 1, range.stdout + range.stderr);
  assert.match(range.stderr, /\[check-commits\] \w+: commit-subject: the subject is "bad subject"/);
  assert.match(range.stderr, /1 findings in the commits of HEAD~1\.\.HEAD \(config\/commits\.json\)/);
  const file = path.join(root, 'MSG');
  writeFileSync(file, '# comment\nfix(ci): Fine (#K2)\n');
  const good = command('--message', file);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /the message being committed passed/);
  writeFileSync(file, 'wip\n');
  const refused = command('--message', file);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /\[check-commits\] commit-subject: the subject is "wip"/);
  assert.equal(command('--range', 'bogus').status, 1);
  put(root, { 'config/commits.json': null });
  const missing = command();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /config\/commits\.json does not exist; declare the commit rules there/);
});

test('config/commits.json is validated against its schema', async () => {
  const { validate } = await import('../../scripts/kit/schema-validate.mjs');
  const { readFileSync } = await import('node:fs');
  const schema = JSON.parse(readFileSync(path.join(KIT, 'schema/commits.schema.json'), 'utf8'));
  assert.deepEqual(validate(CONFIG, schema), []);
  assert.deepEqual(validate({ schema: 1, types: ['Feat'], subjectMax: 0, bodyMax: 72 }, schema), [
    '$.types[0] is "Feat", the schema requires a match of ^[a-z]+$',
    '$.subjectMax is 0, the schema requires at least 1',
  ]);
});
