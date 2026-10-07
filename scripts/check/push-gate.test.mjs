// push gate(scripts/check/push-gate.mjs)와 pre-push hook(.githooks/pre-push)을 임시 git checkout과 임시 bare
// remote로 검사한다. checkout은 gate가 import하는 module과 hook, Makefile을 이 checkout에서 복사해 갖고, 실제
// `git push`가 그 hook을 실행한다. CI 명령(`commit <rev>`)과 hooks-check, make의 hook 설치도 같은 checkout에서
// 실행한다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, PROCESS } from '../../tests/testcase.mjs';
import { isolatedEnvironment } from '../../tests/environment.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GATE = 'scripts/check/push-gate.mjs';
const CHECKLIST = `# Checklist

- [o] G1 Finish the first item. Evidence: done.
- [ ] G3 Wait for the third item.
`;
const ACTIVE = `${CHECKLIST}- [~] G2 Run the second item. Cause: next.
  - [~] G2-2 Keep the nested part active. Cause: open.
`;

// modules는 entry가 상대 path로 import하는 이 checkout의 module 전부다(entry 포함, repository 상대 path).
function modules(entry, found = new Set()) {
  if (found.has(entry)) return found;
  found.add(entry);
  const text = readFileSync(join(repo, entry), 'utf8');
  for (const [, target] of text.matchAll(/^import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm))
    modules(relative(repo, resolve(repo, dirname(entry), target)), found);
  return found;
}

// checkout은 gate의 module, hook, Makefile과 rust-toolchain.toml(Makefile이 parse 때 읽는다)을 복사하고
// checklist를 commit한 임시 checkout과 비어 있는 bare remote를 만든다. hooks가 참이면 core.hooksPath를 둔다.
function checkout({ checklist = CHECKLIST, hooks = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'push-gate-')));
  const root = join(base, 'checkout');
  const remote = join(base, 'remote.git');
  const files = [...modules(GATE), '.githooks/pre-push', 'Makefile', 'rust-toolchain.toml'];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repo, file), join(root, file));
  }
  chmodSync(join(root, '.githooks/pre-push'), 0o755);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/checklist.md'), checklist);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  if (hooks) git('config', 'core.hooksPath', '.githooks');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  return {
    root,
    git,
    commit(text, message) {
      writeFileSync(join(root, 'docs/checklist.md'), text);
      git('commit', '-q', '-am', message);
      return git('rev-parse', 'HEAD').trim();
    },
    push: (...args) => spawnSync('git', ['push', remote, 'HEAD:refs/heads/main', ...args], { cwd: root, encoding: 'utf8' }),
    remoteMain: () => spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim(),
    gate: (args, env = {}) => spawnSync(process.execPath, [GATE, ...args], { cwd: root, encoding: 'utf8', env: isolatedEnvironment(env) }),
    make: (...args) => spawnSync('make', ['--no-print-directory', ...args], { cwd: root, encoding: 'utf8', env: isolatedEnvironment() }),
    remove: () => rmSync(base, { recursive: true, force: true }),
  };
}

caseTest('a push without an item in progress reaches the remote', PROCESS, ({ step }) => {
  const c = checkout();
  try {
    const head = c.git('rev-parse', 'HEAD').trim();
    const result = c.push();
    step(`push: exit ${result.status}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(c.remoteMain(), head);
  } finally {
    c.remove();
  }
});

caseTest('a push of a commit with items in progress is refused and names each item', PROCESS, ({ step }) => {
  const c = checkout();
  try {
    const before = c.git('rev-parse', 'HEAD').trim();
    assert.equal(c.push().status, 0);
    const active = c.commit(ACTIVE, 'start G2');
    const result = c.push();
    step(`push: exit ${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /push refused: checklist items are in progress \(docs\/checklist\.md\)/);
    assert.match(result.stderr, new RegExp(`HEAD ${active.slice(0, 12)}: G2 Run the second item\\.`));
    assert.match(result.stderr, new RegExp(`HEAD ${active.slice(0, 12)}: G2-2 Keep the nested part active\\.`));
    assert.match(result.stderr, /A push happens only when no checklist item is \[~\] \(AGENTS\.md\)/);
    assert.match(result.stderr, /Complete each item \(\[o\] with its changelog entry, committed\), or mark it \[!\] with Cause and Retry/);
    assert.doesNotMatch(result.stderr, /no-verify/);
    assert.equal(c.remoteMain(), before);
  } finally {
    c.remove();
  }
});

caseTest('a push is refused while the working tree has an item in progress', PROCESS, ({ step }) => {
  const c = checkout();
  try {
    writeFileSync(join(c.root, 'docs/checklist.md'), ACTIVE);
    const result = c.push();
    step(`push: exit ${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /working tree: G2 Run the second item\./);
    assert.doesNotMatch(result.stderr, /HEAD [0-9a-f]{12}: G2/);
    assert.equal(c.remoteMain(), '');
  } finally {
    c.remove();
  }
});

caseTest('a push of a commit without the checklist is refused', PROCESS, ({ step }) => {
  const c = checkout();
  try {
    c.git('rm', '-q', 'docs/checklist.md');
    c.git('commit', '-q', '-m', 'drop the checklist');
    const result = c.push();
    step(`push: exit ${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /push refused: the push gate cannot read docs\/checklist\.md of HEAD [0-9a-f]{12}/);
    assert.equal(c.remoteMain(), '');
  } finally {
    c.remove();
  }
});

caseTest('hooks-check fails without core.hooksPath and make installs the hook', PROCESS, ({ step }) => {
  const c = checkout({ hooks: false });
  try {
    const missing = c.gate(['hooks-check']);
    step(`hooks-check without the setting: exit ${missing.status}`);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /core\.hooksPath is unset, not \.githooks/);
    assert.match(missing.stderr, /run make hooks/);
    const installed = c.make('hooks');
    step(`make hooks: exit ${installed.status}`);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.equal(c.git('config', 'core.hooksPath').trim(), '.githooks');
    assert.equal(c.gate(['hooks-check']).status, 0);
    // make의 어떤 실행이든 parse 때 hook을 설치한다.
    c.git('config', '--unset', 'core.hooksPath');
    const parsed = c.make('-n', 'checklist-check');
    step(`make -n checklist-check: exit ${parsed.status}`);
    assert.equal(c.git('config', 'core.hooksPath').trim(), '.githooks');
    // 실행할 수 없는 hook file도 실패다.
    chmodSync(join(c.root, '.githooks/pre-push'), 0o644);
    const mode = c.gate(['hooks-check']);
    assert.equal(mode.status, 1);
    assert.match(mode.stderr, /\.githooks\/pre-push is not executable/);
  } finally {
    c.remove();
  }
});

caseTest('the CI command refuses a commit with items in progress or without an executable hook', PROCESS, ({ step }) => {
  const c = checkout();
  try {
    const summary = join(c.root, '..', 'summary.md');
    const clean = c.gate(['commit', 'HEAD'], { GITHUB_STEP_SUMMARY: summary });
    step(`clean commit: exit ${clean.status}`);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    const active = c.commit(ACTIVE, 'start G2');
    const refused = c.gate(['commit', 'HEAD'], { GITHUB_STEP_SUMMARY: summary });
    step(`active commit: exit ${refused.status}`);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, new RegExp(`^::error::push refused: checklist items are in progress`, 'm'));
    assert.match(refused.stdout, new RegExp(`^::error::  HEAD ${active.slice(0, 12)}: G2 Run the second item\\.$`, 'm'));
    assert.match(readFileSync(summary, 'utf8'), /G2-2 Keep the nested part active\./);
    c.commit(CHECKLIST, 'finish G2');
    c.git('update-index', '--chmod=-x', '.githooks/pre-push');
    c.git('commit', '-q', '-m', 'hook not executable');
    const mode = c.gate(['commit', 'HEAD']);
    step(`hook mode 100644: exit ${mode.status}`);
    assert.equal(mode.status, 1);
    assert.match(mode.stdout, /^::error::.*\.githooks\/pre-push is tracked with mode 100644, not 100755/m);
    c.git('rm', '-q', '-f', '.githooks/pre-push');
    c.git('commit', '-q', '-m', 'drop the hook');
    const absent = c.gate(['commit', 'HEAD']);
    assert.equal(absent.status, 1);
    assert.match(absent.stdout, /^::error::.*\.githooks\/pre-push is not tracked/m);
  } finally {
    c.remove();
  }
});
