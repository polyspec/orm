// 전체 suite의 guard(scripts/check/full-run.mjs)와 그것을 쓰는 runner(scripts/check/run.mjs)를 stub
// 단계로 검사한다. 각 case는 임시 git checkout에 checklist를 두고, database 만들기와 지우기, make
// target 대신 자기 이름을 log에 적는 stub 명령으로 runChecks를 별도 process에서 실행한다. 실제
// target과 database는 실행하지 않는다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mjs';
import { activeItems, decide, summarize } from './full-run.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CHECKLIST = `# Checklist

- [o] G1 Finish the first item. Evidence: done.
- [~] G2 Run the second item. Cause: next.
  - [o] G2-1 Close a part of the second item.
  - [~] G2-2 Keep the nested part active. Cause: open.
- [ ] G3 Wait for the third item.
`;
const DONE = CHECKLIST.replaceAll('[~]', '[o]');

// caseTest는 node:test의 context를 주지 않으므로 임시 directory는 case 끝의 cleanup이 지운다.
const after = [];
function cleanup() {
  while (after.length) after.pop()();
}

// stub은 runChecks를 stub 명령으로 실행한다. database 명령(sh)은 log에 `sh <action>`을, make target은 자기
// 이름을 적는다. `b`는 추적하지 않는 file `pass-b`가 있을 때만 통과하므로 case는 tree를 바꾸지 않고 결과를
// 바꾼다. kill에 target 이름을 주면 그 target이 runner process를 SIGKILL로 끝낸다. `decide`는 make check의 첫 줄을 실행한다.
const STUB = `import { appendFileSync, existsSync } from 'node:fs';
import { runChecks } from ${JSON.stringify(resolve(repo, 'scripts/check/run.mjs'))};
import { preflight } from ${JSON.stringify(resolve(repo, 'scripts/check/full-run.mjs'))};
const [root, action, mode, log, kill] = process.argv.slice(2);
if (action === 'decide') process.exit(preflight(root, mode));
const run = async (program, args) => {
  const name = program === 'sh' ? \`sh \${args[1]}\` : args.at(-1);
  appendFileSync(log, name + '\\n');
  if (kill && name === kill) process.kill(process.pid, 'SIGKILL');
  if (name === 'b' && !existsSync(root + '/pass-b')) throw new Error('make b exited with 2');
};
process.exitCode = await runChecks({ root, mode, servers: '/servers/env', targets: mode === 'check' ? ['a', 'b', 'c'] : [], run });
`;

function checkout(t, checklist) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'full-run-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'checkout');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/checklist.md'), checklist);
  writeFileSync(join(root, '.gitignore'), '/.runtime/\npass-b\n');
  writeFileSync(join(base, 'stub.mjs'), STUB);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init');
  const log = join(base, 'ran.log');
  return {
    root,
    git,
    run: (action, mode, kill = '') => spawnSync(process.execPath, [join(base, 'stub.mjs'), root, action, mode, log, kill], { encoding: 'utf8' }),
    ran: () => {
      const names = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
      rmSync(log, { force: true });
      return names;
    },
    record: () => JSON.parse(readFileSync(join(root, '.runtime/full-run.json'), 'utf8')),
  };
}

// recipe는 Makefile에서 target의 명령 줄을 돌려준다.
function recipe(target) {
  const lines = readFileSync(resolve(repo, 'Makefile'), 'utf8').split('\n');
  const body = [];
  for (const line of lines.slice(lines.indexOf(`${target}:`) + 1)) {
    if (!line.startsWith('\t')) break;
    body.push(line.trim());
  }
  return body;
}

caseTest('active items include nested sub-items with their titles', COMPUTE, () => {
  assert.deepEqual(activeItems(CHECKLIST), [
    { id: 'G2', title: 'Run the second item.' },
    { id: 'G2-2', title: 'Keep the nested part active.' },
  ]);
});

caseTest('the decision refuses active items and allows a committed tree without a record', COMPUTE, () => {
  const refused = decide('check', { items: activeItems(CHECKLIST), changes: [], tree: 't1', record: null, targets: ['a'] });
  assert.equal(refused.allowed, false);
  assert.match(refused.reasons.join('\n'), /G2 Run the second item\.\n {2}G2-2 Keep the nested part active\./);
  const allowed = decide('check', { items: [], changes: [], tree: 't1', record: null, targets: ['a', 'b'] });
  assert.deepEqual([allowed.allowed, allowed.targets], [true, ['a', 'b']]);
});

caseTest('make check and make rerun-failed start with the guard', COMPUTE, () => {
  assert.deepEqual(recipe('check'), [
    'node scripts/check/full-run.mjs decide check',
    '$(WITH_TEST_ENV) node scripts/check/run.mjs --full-run $(abspath $(TEST_ENV)) $(CHECK_TARGETS)',
  ]);
  assert.deepEqual(recipe('rerun-failed'), [
    'node scripts/check/full-run.mjs decide rerun-failed',
    '$(WITH_TEST_ENV) node scripts/check/run.mjs --rerun-failed $(abspath $(TEST_ENV))',
  ]);
});

caseTest('an active item refuses before any step', PROCESS, ({ step }) => {
  const c = checkout({ after: f => after.push(f) }, CHECKLIST);
  try {
    for (const action of ['decide', 'run']) {
      const result = c.run(action, 'check');
      step(`${action}: exit ${result.status}`);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout, /full-run: refused make check:/);
      assert.match(result.stdout, /G2 Run the second item\./);
      assert.match(result.stdout, /G2-2 Keep the nested part active\./);
    }
    assert.deepEqual(c.ran(), []);
    assert.equal(existsSync(join(c.root, '.runtime/full-run.json')), false);
  } finally {
    cleanup();
  }
});

caseTest('an uncommitted tracked change refuses', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    writeFileSync(join(c.root, 'docs/checklist.md'), `${DONE}\n`);
    const result = c.run('run', 'check');
    assert.equal(result.status, 2);
    assert.match(result.stdout, /uncommitted changes of tracked files:\nfull-run: {4}M docs\/checklist\.md/);
    assert.deepEqual(c.ran(), []);
  } finally {
    cleanup();
  }
});

caseTest('a second full run of the same tree is refused naming the first', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const first = c.run('run', 'check');
    assert.equal(first.status, 1, first.stdout + first.stderr);
    assert.deepEqual(c.ran(), ['sh create', 'a', 'b', 'c', 'sh drop']);
    const record = c.record();
    assert.deepEqual([record.result, record.failed, record.runner], ['failed', ['b'], null]);
    assert.deepEqual(record.setup.map(step => [step.name, step.status]), [['databases/create', 'passed'], ['databases/drop', 'passed']]);
    assert.equal(record.tree, c.git('rev-parse', 'HEAD^{tree}').trim());
    for (const action of ['decide', 'run']) {
      const second = c.run(action, 'check');
      assert.equal(second.status, 2);
      assert.ok(second.stdout.includes(`the full run of tree ${record.tree} started ${record.started}`), second.stdout);
    }
    assert.deepEqual(c.ran(), []);
  } finally {
    cleanup();
  }
});

caseTest('a rerun without a record is refused', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const result = c.run('run', 'rerun-failed');
    assert.equal(result.status, 2);
    assert.match(result.stdout, /no full run is recorded/);
    assert.deepEqual(c.ran(), []);
  } finally {
    cleanup();
  }
});

caseTest('a rerun runs only the recorded failed targets', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    c.run('run', 'check');
    c.ran();
    writeFileSync(join(c.root, 'pass-b'), '');
    const result = c.run('run', 'rerun-failed');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(c.ran(), ['sh create', 'b', 'sh drop']);
    const record = c.record();
    assert.deepEqual([record.result, record.failed, record.reruns.map(rerun => rerun.targets)], ['passed', [], [['b']]]);
    const again = c.run('run', 'rerun-failed');
    assert.equal(again.status, 2);
    assert.match(again.stdout, /nothing to rerun/);
  } finally {
    cleanup();
  }
});

caseTest('a killed run stays recorded as incomplete', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const result = c.run('run', 'check', 'a');
    assert.equal(result.signal, 'SIGKILL');
    const record = c.record();
    assert.equal(record.result, 'incomplete');
    assert.deepEqual(record.targets.map(target => [target.name, target.status]), [['a', 'running'], ['b', 'not run'], ['c', 'not run']]);
    const rerun = c.run('run', 'rerun-failed');
    assert.equal(rerun.status, 1, rerun.stdout + rerun.stderr);
    assert.deepEqual(c.ran(), ['sh create', 'a', 'sh create', 'a', 'b', 'c', 'sh drop']);
  } finally {
    cleanup();
  }
});

// 목록 case는 강제 종료된 실행의 기록이 실패한 target과 끝나지 않은 target을 나누어 담고, make rerun-failed가
// 둘을 모두 다시 실행하는지 확인한다. `a`는 통과하고 `b`는 실패하며 `c`가 runner를 끝낸다.
caseTest('a killed run records failed and unfinished targets apart', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const result = c.run('run', 'check', 'c');
    assert.equal(result.signal, 'SIGKILL');
    const record = c.record();
    assert.deepEqual([record.result, record.failed, record.incomplete], ['incomplete', ['b'], ['c']]);
    assert.deepEqual(record.targets.map(target => [target.name, target.status]), [['a', 'passed'], ['b', 'failed'], ['c', 'running']]);
    c.ran();
    writeFileSync(join(c.root, 'pass-b'), '');
    const rerun = c.run('run', 'rerun-failed');
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.deepEqual(c.ran(), ['sh create', 'b', 'c', 'sh drop']);
    const after = c.record();
    assert.deepEqual([after.result, after.failed, after.incomplete], ['passed', [], []]);
  } finally {
    cleanup();
  }
});

caseTest('summarize separates failed from unfinished targets', COMPUTE, () => {
  const record = summarize({ targets: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'running' }, { name: 'd', status: 'not run' }] });
  assert.deepEqual([record.failed, record.incomplete], [['b'], ['c', 'd']]);
});

// 후손 case의 기록은 a가 통과하고 b가 실패한 전체 실행이다. 그 뒤 commit에서 바뀐 path는 owner target c를 고른다.
const DECLARED = { a: { scope: 'suite' }, b: { scope: 'suite' }, c: { scope: 'owner', inputs: ['src/**'] } };
const RECORD = {
  tree: 't1', commit: 'c1', started: 's', ended: 'e', result: 'failed', failed: ['b'], incomplete: [], reruns: [],
  targets: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'passed' }],
};

caseTest('a rerun on a descendant commit adds the owner targets of the changed paths', COMPUTE, () => {
  const allowed = decide('rerun-failed', { items: [], changes: [], tree: 't2', commit: 'c2', record: RECORD, descends: true, changed: ['src/x.mjs', 'README.md'], declared: DECLARED });
  assert.deepEqual([allowed.allowed, allowed.targets], [true, ['b', 'c']], allowed.reasons.join('\n'));
  assert.deepEqual(allowed.owners, [{ target: 'c', reasons: ['src/x.mjs'] }]);
  const unrelated = decide('rerun-failed', { items: [], changes: [], tree: 't2', commit: 'c2', record: RECORD, descends: true, changed: ['README.md'], declared: DECLARED });
  assert.deepEqual([unrelated.allowed, unrelated.targets], [true, ['b']]);
});

caseTest('a rerun on a commit that does not descend from the recorded one is refused', COMPUTE, () => {
  const refused = decide('rerun-failed', { items: [], changes: [], tree: 't2', commit: 'c2', record: RECORD, descends: false, changed: [], declared: DECLARED });
  assert.equal(refused.allowed, false);
  assert.match(refused.reasons.join('\n'), /the recorded run is of commit c1 \(tree t1\); the current commit c2 \(tree t2\) is neither that commit nor its descendant/);
  const active = decide('rerun-failed', { items: activeItems(CHECKLIST), changes: [' M x'], tree: 't2', commit: 'c2', record: RECORD, descends: true, changed: ['src/x.mjs'], declared: DECLARED });
  assert.equal(active.allowed, false);
  assert.match(active.reasons.join('\n'), /checklist items are in progress[^]*uncommitted changes of tracked files/);
});

// 후손 실행 case는 실제 git checkout에서 전체 실행 뒤 owner target c의 입력을 바꾼 commit을 만들고 재실행한다.
// 강제 종료된 재실행이 남긴 c는 다음 재실행이 다시 고르고, 끝난 재실행 뒤에는 그 commit이 기준이 된다. 기록된
// commit의 조상으로 돌아간 checkout은 거부된다.
caseTest('a rerun on a descendant commit reruns failed and changed owner targets and moves its base', PROCESS, ({ step }) => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const commit = message => c.git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-am', message);
    mkdirSync(join(c.root, 'contracts'));
    mkdirSync(join(c.root, 'src'));
    writeFileSync(join(c.root, 'contracts/check-inputs.json'), JSON.stringify({ targets: DECLARED }));
    writeFileSync(join(c.root, 'src/x.mjs'), '1\n');
    c.git('add', '.');
    commit('contracts');
    const first = c.git('rev-parse', 'HEAD').trim();
    assert.equal(c.run('run', 'check').status, 1);
    c.ran();
    writeFileSync(join(c.root, 'src/x.mjs'), '2\n');
    commit('change c');
    const killed = c.run('run', 'rerun-failed', 'b');
    step(`killed rerun: ${killed.signal}`);
    assert.equal(killed.signal, 'SIGKILL', killed.stdout + killed.stderr);
    assert.match(killed.stdout, /owner target c is selected by paths changed since [0-9a-f]+: src\/x\.mjs/);
    assert.deepEqual(c.ran(), ['sh create', 'b']);
    assert.deepEqual(c.record().targets.map(target => [target.name, target.status]), [['a', 'passed'], ['b', 'running'], ['c', 'not run']]);
    writeFileSync(join(c.root, 'pass-b'), '');
    const rerun = c.run('run', 'rerun-failed');
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.deepEqual(c.ran(), ['sh create', 'b', 'c', 'sh drop']);
    const record = c.record();
    const head = c.git('rev-parse', 'HEAD').trim();
    assert.deepEqual([record.result, record.commit, record.reruns.map(run => [run.commit, run.since, run.targets])],
      ['passed', first, [[head, first, ['b', 'c']], [head, head, ['b', 'c']]]]);
    const again = c.run('run', 'rerun-failed');
    assert.equal(again.status, 2);
    assert.match(again.stdout, /nothing to rerun/);
    c.git('checkout', '-q', '--detach', first);
    const older = c.run('run', 'rerun-failed');
    assert.equal(older.status, 2);
    assert.match(older.stdout, /is neither that commit nor its descendant/);
    assert.deepEqual(c.ran(), []);
  } finally {
    cleanup();
  }
});
