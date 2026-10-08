// Tests of the push gate (scripts/kit/push-gate.mjs). The pre-push hook that `git-hooks install` writes refuses a push while
// an item of a tracker is in the active state in a pushed commit or in the working tree, naming each item with its file and
// ID, and while it cannot read a tracker; the states that do not block pass. The command `commit <rev>` applies the same
// check to one commit and requires the hooks to be tracked with mode 100755. Each case pushes from a temporary checkout to
// a temporary bare repository.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CHECKLIST, TRANSLATION, commitAll, commitIndex, git, prepared, run } from './gates-checkout.mjs';

const push = (work, ...refspecs) => run(work, 'git', ['push', '--quiet', 'origin', ...(refspecs.length ? refspecs : ['HEAD:refs/heads/main'])]);
const remoteHead = remote => run(remote, 'git', ['rev-parse', '--verify', '--quiet', 'refs/heads/main']).stdout.trim();
const gate = (work, args, env = {}, input) => run(work, process.execPath, ['scripts/kit/push-gate.mjs', ...args], { env: { ...process.env, ...env }, input });
const edit = (work, file, change) => writeFileSync(path.join(work, file), change(readFileSync(path.join(work, file), 'utf8')));
const start = (work, id = 'T1-1') => {
  for (const file of [CHECKLIST, TRANSLATION]) edit(work, file, text => text.replace(new RegExp(`(\\| ${id} \\|[^\\n]*)\\| \\[ \\] \\|`), '$1| [~] |'));
};

test('a push whose trackers hold waiting, done and bypassed items reaches the remote', (t) => {
  const { work, remote } = prepared(t);
  const pushed = push(work);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(remoteHead(remote), git(work, 'rev-parse', 'HEAD'));
});

test('a push whose commit has an item in progress is refused and names the file, the ID and what blocks', (t) => {
  const { work, remote } = prepared(t);
  assert.equal(push(work).status, 0);
  const before = remoteHead(remote);
  start(work);
  const active = commitAll(work, 'start T1-1');
  const pushed = push(work);
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stderr, /push refused: 2 items are in the active state \(docs\/plans\/execution-checklist\.md: only the state \[~\] blocks; \[ \], \[o\], \[!\] do not block\)/);
  assert.match(pushed.stderr, new RegExp(`  HEAD ${active.slice(0, 12)}: docs/plans/execution-checklist\\.md T1-1 Print \`a \\\\\\| b\` for a union`));
  assert.match(pushed.stderr, /A push happens only when no item of a tracker is in its active state/);
  assert.match(pushed.stderr, /  working tree: docs\/plans\/execution-checklist\.md T1-1 /);
  assert.equal(remoteHead(remote), before);
});

test('a push is refused while the working tree has an item in progress and the pushed commit has none', (t) => {
  const { work, remote } = prepared(t);
  start(work);
  const pushed = push(work);
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stderr, /  working tree: docs\/plans\/execution-checklist\.md T1-1 /);
  assert.doesNotMatch(pushed.stderr, /HEAD [0-9a-f]{12}:/);
  assert.equal(remoteHead(remote), '');
});

test('every item in progress is named, in each pushed commit and in the working tree', (t) => {
  const { work } = prepared(t);
  edit(work, CHECKLIST, text => text.replace('| T1 | Write the parser | `make test` | [o] |', '| T1 | Write the parser | `make test` | [~] |').replace(/(\| T1-1 \|[^\n]*)\| \[ \] \|/, '$1| [~] |'));
  edit(work, TRANSLATION, text => text.replace('| T1 | parser를 작성한다 | `make test` | [o] |', '| T1 | parser를 작성한다 | `make test` | [~] |').replace(/(\| T1-1 \|[^\n]*)\| \[ \] \|/, '$1| [~] |'));
  const pushed = push(work);
  assert.match(pushed.stderr, /2 items are in the active state/);
  assert.match(pushed.stderr, /working tree: docs\/plans\/execution-checklist\.md T1 Write the parser/);
  assert.match(pushed.stderr, /working tree: docs\/plans\/execution-checklist\.md T1-1 /);
});

test('a push is refused when a pushed commit has no tracker file', (t) => {
  const { work, remote } = prepared(t);
  git(work, 'rm', '--quiet', '--cached', CHECKLIST);
  const removed = commitIndex(work, 'remove the checklist');
  const pushed = push(work);
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stderr, /push refused: the push gate cannot read the trackers/);
  assert.match(pushed.stderr, new RegExp(`HEAD ${removed.slice(0, 12)}: docs/plans/execution-checklist\\.md: the commit has no docs/plans/execution-checklist\\.md`));
  assert.equal(remoteHead(remote), '');
});

test('a document without an item or with an unknown state is unreadable and refuses the push', (t) => {
  const { work } = prepared(t);
  edit(work, CHECKLIST, () => '# Execution checklist\n');
  assert.match(push(work).stderr, /working tree: docs\/plans\/execution-checklist\.md: it has no item/);
  edit(work, CHECKLIST, () => '| ID | Task | State |\n|---|---|---|\n| T1 | A | [x] |\n');
  assert.match(push(work).stderr, /line 3: T1 has the state "\[x\]"/);
});

test('a translation with another state than its document refuses the push', (t) => {
  const { work, remote } = prepared(t);
  edit(work, TRANSLATION, text => text.replace(/(\| T1-1 \|[^\n]*)\| \[ \] \|/, '$1| [o] |'));
  commitAll(work, 'translation differs');
  const pushed = push(work);
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stderr, /push refused: the push gate cannot read the trackers/);
  assert.match(pushed.stderr, /T1-1 is \[ \] in docs\/plans\/execution-checklist\.md and \[o\] in docs\/plans\/execution-checklist\.ko\.md/);
  assert.equal(remoteHead(remote), '');
});

test('a list tracker declared in the configuration is read by its items', (t) => {
  const config = { schema: 1, hooks: ['pre-push'], trackers: [{ path: 'docs/checklist.md', format: 'list', states: ['[ ]', '[~]', '[o]', '[!]'], active: '[~]' }] };
  const list = state => `# Checklist\n\n- [o] T1 Write the parser.\n- ${state} T2 Print a union. More text.\n  - [ ] T2.1 Name the members.\n`;
  const { work, remote } = prepared(t, { config, files: { 'docs/checklist.md': list('[ ]') } });
  assert.equal(push(work).status, 0);
  edit(work, 'docs/checklist.md', () => list('[~]'));
  const pushed = push(work, 'HEAD:refs/heads/other');
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stderr, /  working tree: docs\/checklist\.md T2 Print a union\./);
  assert.equal(remoteHead(remote), git(work, 'rev-parse', 'HEAD'));
});

test('a state word of another column is read as the configuration says', (t) => {
  const config = { schema: 1, hooks: ['pre-push'], trackers: [{ path: 'docs/features.md', format: 'table', column: 2, active: 'partial' }] };
  const features = state => `| ID | Feature | Implementation |\n|---|---|---|\n| F-A | Parse | implemented |\n| F-B | Print | ${state} |\n`;
  const { work } = prepared(t, { config, files: { 'docs/features.md': features('planned') } });
  assert.equal(push(work).status, 0);
  edit(work, 'docs/features.md', () => features('partial'));
  assert.match(push(work).stderr, /working tree: docs\/features\.md F-B Print/);
});

test('the deletion of a remote branch reads only the working tree', (t) => {
  const { work, remote } = prepared(t);
  assert.equal(push(work, 'HEAD:refs/heads/main', 'HEAD:refs/heads/other').status, 0);
  const deleted = push(work, ':refs/heads/other');
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(run(remote, 'git', ['rev-parse', '--verify', '--quiet', 'refs/heads/other']).stdout.trim(), '');
  start(work);
  const refused = push(work, ':refs/heads/main');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /working tree: docs\/plans\/execution-checklist\.md T1-1/);
  assert.notEqual(remoteHead(remote), '');
});

test('a gate that cannot understand its input does not allow the push', (t) => {
  const { work } = prepared(t);
  const refused = gate(work, ['hook'], {}, 'refs/heads/main abc\n');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /push refused: the push gate failed: the pre-push input line "refs\/heads\/main abc" is not "<local ref> <local sha> <remote ref> <remote sha>"/);
  const sha = git(work, 'rev-parse', 'HEAD');
  assert.equal(gate(work, ['hook'], {}, `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`).status, 0);
  assert.equal(gate(work, ['hook'], {}, '').status, 0);
  assert.equal(gate(work, ['other']).status, 2);
  assert.match(gate(work, ['commit']).stderr, /Usage: node scripts\/kit\/push-gate\.mjs hook \| commit <rev>/);
});

test('a gate without configuration refuses the push', (t) => {
  const { work } = prepared(t);
  git(work, 'rm', '--quiet', '-f', 'config/checklist.json');
  const refused = gate(work, ['hook'], {}, '');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /push refused: the push gate failed: config\/checklist\.json does not exist/);
});

test('the commit command passes for a commit without an item in progress and tracked hooks', (t) => {
  const { work } = prepared(t);
  const summary = path.join(work, '..', 'summary.md');
  const clean = gate(work, ['commit', 'HEAD'], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /\[push-gate\] commit [0-9a-f]{12}: no item is in an active state and every hook of config\/checklist\.json is tracked with mode 100755/);
  assert.equal(clean.stderr, '');
});

test('the commit command fails for an item in progress with an annotation for each line and a summary', (t) => {
  const { work } = prepared(t);
  const summary = path.join(work, '..', 'summary.md');
  start(work);
  edit(work, CHECKLIST, text => text.replace('Print `a \\| b` for a union', '100% done\\|'));
  edit(work, TRANSLATION, text => text.replace('union을 `a \\| b`로 출력한다', '100% 끝'));
  commitAll(work, 'start T1-1');
  const failed = gate(work, ['commit', 'HEAD'], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^::error::push refused: 1 item is in the active state/m);
  assert.match(failed.stdout, /^::error::  commit [0-9a-f]{12}: docs\/plans\/execution-checklist\.md T1-1 100%25 done\\\|$/m);
  assert.match(failed.stderr, /T1-1 100% done/);
  assert.match(readFileSync(summary, 'utf8'), /^## Push gate\n\n```\npush refused: 1 item is in the active state[\s\S]*T1-1 100% done/);
});

test('the commit command fails for a commit whose hook is missing or not executable', (t) => {
  const { work } = prepared(t);
  git(work, 'update-index', '--chmod=-x', '.githooks/pre-push');
  commitIndex(work, 'hook without mode');
  const mode = gate(work, ['commit', 'HEAD']);
  assert.equal(mode.status, 1);
  assert.match(mode.stdout, /^::error::push refused: \.githooks\/pre-push is tracked with mode 100644, not 100755, in commit [0-9a-f]{12}/m);

  git(work, 'rm', '--quiet', '--cached', '.githooks/pre-push');
  commitIndex(work, 'no hook');
  const missing = gate(work, ['commit', 'HEAD']);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^::error::push refused: \.githooks\/pre-push is not tracked in commit [0-9a-f]{12}/m);
});

test('the commit command checks every hook that the configuration lists', (t) => {
  const config = { schema: 1, hooks: ['pre-push', 'pre-commit'], trackers: [{ path: 'docs/plans/execution-checklist.md', format: 'table', active: '[~]' }] };
  const { work } = prepared(t);
  writeFileSync(path.join(work, 'config/checklist.json'), JSON.stringify(config));
  commitAll(work, 'list pre-commit');
  const missing = gate(work, ['commit', 'HEAD']);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^::error::push refused: \.githooks\/pre-commit is not tracked in commit /m);
  assert.doesNotMatch(missing.stdout, /pre-push is not tracked/);
});

test('the commit command refuses a revision that is not a commit', (t) => {
  const { work } = prepared(t);
  const refused = gate(work, ['commit', 'no-such-revision']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /^::error::push refused: no-such-revision is not a commit of this repository$/m);
});
