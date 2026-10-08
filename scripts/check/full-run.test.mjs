// 전체 suite의 guard(scripts/check/full-run.mjs)와 그것을 쓰는 runner(scripts/check/run.mjs)를 stub
// 단계로 검사한다. 각 case는 임시 git checkout에 checklist를 두고, database 만들기와 지우기, make
// target 대신 자기 이름을 log에 적는 stub 명령으로 runChecks를 별도 process에서 실행한다. 실제
// target과 database는 실행하지 않는다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../tests/environment.mjs';
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
//
// STUB_SUITE=failing는 setup 실패 case의 suite다: target a, b, c, d 가운데 a와 c는 database가 필요하고, database
// 만들기는 실패하며, b는 실패한 case 하나와 끝나지 않은 case 하나를 출력하고 실행 directory를 남기며, d는 통과한다.
const STUB = `import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { handleCrashes, runChecks } from ${JSON.stringify(resolve(repo, 'scripts/check/run.mjs'))};
import { preflight } from ${JSON.stringify(resolve(repo, 'scripts/check/full-run.mjs'))};
const [root, action, mode, log, kill, servers] = process.argv.slice(2);
if (action === 'decide') process.exit(preflight(root, mode));
const failing = process.env.STUB_SUITE === 'failing';
// STUB_SUITE=lost는 target b가 실행 도중 보고서 directory를 지우고 출력을 더 쓰는 suite, STUB_SUITE=throws는 target b가
// runner의 콜백 밖에서 처리되지 않는 오류를 던지는 suite다(G5.43-1).
const lost = process.env.STUB_SUITE === 'lost';
const throws = process.env.STUB_SUITE === 'throws';
// STUB_SUITE=drop은 database 지우기가 databases.sh처럼 받은 directory를 통째로 지우는 suite, STUB_SUITE=verbose는 target b가
// 3 MiB를 출력하는 suite다(G5.43-2).
const drop = process.env.STUB_SUITE === 'drop';
const verbose = process.env.STUB_SUITE === 'verbose';
// STUB_SUITE=space는 target b가 /tmp의 quota 초과로 실패하는 suite다(G5.43-4).
const space = process.env.STUB_SUITE === 'space';
// STUB_SUITE=diskio-full와 diskio-free는 target b가 SQLite의 disk I/O error로 실패하는 suite다. full은 그 순간 /tmp의
// 남은 공간이 0이고 지웠지만 열린 큰 file이 있는 기록, free는 공간이 남은 기록이다. STUB_SUITE=npm은 target b가 npm처럼
// 보고서 밖의 debug log(STUB_NPM_LOG)만 가리키고 실패하는 suite다(G5.44).
const diskio = process.env.STUB_SUITE?.startsWith('diskio-');
const npm = process.env.STUB_SUITE === 'npm';
// STUB_SUITE=cisetup은 CI setup step rust가 실패한 실행이다(G5.52): a는 rust가, c는 go가 필요하고 b는 아무것도 필요하지 않다.
const cisetup = process.env.STUB_SUITE === 'cisetup';
// STUB_SUITE=composer는 CI group이 setup step composer를 건너뛴 실행이다(G5.127): a와 c는 databases만 선언하고, databases/create가
// decimal database를 Composer autoload로 설치하므로 그것도 composer가 필요하다.
const composer = process.env.STUB_SUITE === 'composer';
// STUB_SUITE=group과 group-rust는 CI group의 job이다(G5.111): group-needs가 rust, php와 server의 setup step을 건너뛰게
// 했고, 어느 target도 database가 필요하지 않다. group에서는 c만 go가 필요하고, group-rust에서는 a가 건너뛴 rust도 필요하다.
const group = process.env.STUB_SUITE === 'group';
const groupRust = process.env.STUB_SUITE === 'group-rust';
const skipped = { checkout: { outcome: 'success' }, node: { outcome: 'success' }, 'group-needs': { outcome: 'success' }, go: { outcome: 'success' },
  rust: { outcome: 'skipped' }, 'rust-cache': { outcome: 'skipped' }, php: { outcome: 'skipped' }, composer: { outcome: 'skipped' },
  'server-programs': { outcome: 'skipped' }, servers: { outcome: 'skipped' } };
handleCrashes();
const run = async (program, args, step, spawned = () => {}) => {
  const name = program === 'sh' ? \`sh \${args[1]}\` : args.at(-1);
  appendFileSync(log, name + '\\n');
  if (kill && name === kill) process.kill(process.pid, 'SIGKILL');
  if (failing && name === 'sh create') {
    step('databases: CREATE DATABASE orm_check_x_bench failed: ERROR 1045 (28000): Access denied for user');
    throw new Error('sh scripts/check/databases.sh create exited with 1');
  }
  if (failing && name === 'b') {
    spawned(4242);
    const dir = root + '/.runtime/run/b-4242';
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/out.json', '{"rows": 5}\\n');
    writeFileSync(dir + '/big.log', 'x'.repeat(2 * 1024 * 1024) + 'END\\n');
    for (const line of ['RUN b/count deadline=1m0s', 'STEP b/count elapsed=1ms: SELECT COUNT(*) FROM t', 'FAIL b/count elapsed=2ms: rows of t: expected 3, actual 5',
      'RUN b/pending deadline=1m0s', 'STEP b/pending elapsed=1ms: waiting for the lock of t'])
      step(line);
    throw new Error('make --no-print-directory -k b exited with 2');
  }
  if (drop && name === 'sh drop') rmSync(args[3], { recursive: true, force: true });
  if (space && name === 'b') {
    step('STEP fuzz/engine-ir elapsed=33ms: write /tmp/go-build3971832083/b001/_testmain.go: disk quota exceeded');
    throw new Error('make --no-print-directory -k b exited with 2');
  }
  if (diskio && name === 'b') {
    step('[rust] FAIL audit_record_transaction elapsed=29ms: install: DRIVER: disk I/O error');
    throw new Error('make --no-print-directory -k b exited with 2');
  }
  if (npm && name === 'b') {
    writeFileSync(process.env.STUB_NPM_LOG, '0 verbose cli /usr/bin/node /usr/bin/npm\\n12 error code E404\\n13 error 404 Not Found - GET https://registry.npmjs.org/x - Not found\\n14 verbose exit 1\\n');
    step('STEP package elapsed=679ms: npm error A complete log of this run can be found in: ' + process.env.STUB_NPM_LOG);
    throw new Error('make --no-print-directory -k b exited with 2');
  }
  if (verbose && name === 'b') {
    for (let i = 0; i < 3 * 1024; i++) step(\`line \${i} \${'v'.repeat(1000)}\`);
    return;
  }
  if (lost && name === 'b') {
    rmSync(root + '/.runtime/check/' + process.env.STUB_REPORT_RUN + '/report', { recursive: true, force: true });
    step('a line after the report directory is gone');
    return;
  }
  if (throws && name === 'b') {
    await new Promise(() => setImmediate(() => { throw new Error('boom outside the runner'); }));
  }
  if (!failing && !lost && !throws && !verbose && !space && !diskio && !npm && !cisetup && !composer && !group && !groupRust && name === 'b' && !existsSync(root + '/pass-b')) throw new Error('make b exited with 2');
};
const targets = mode !== 'check' ? [] : failing ? ['a', 'b', 'c', 'd'] : ['a', 'b', 'c'];
const needs = cisetup || groupRust ? { a: ['rust'], b: [], c: ['go'] } : group ? { a: [], b: [], c: ['go'] } : { a: ['databases'], b: [], c: ['databases'], d: [] };
// 공간 기록은 공간 case에서만 실제 diskSnapshot이다. 다른 case는 /tmp를 읽지 않는 고정 기록을 쓴다.
const removed = '## files under /tmp that were removed but are still open (lsof +L1)\\nCOMMAND PID USER FD TYPE DEVICE SIZE/OFF NLINK NODE NAME\\nmysqld 10079 runner 2w REG 0,38 6493765632 0 3807 /tmp/orm-binlog-AHN00Q/mysqld.log (deleted)\\n';
const snapshot = space ? undefined
  : process.env.STUB_SUITE === 'diskio-full' ? () => ({ text: '## df -k / /tmp\\nstub\\n' + removed, places: { '/': 1, '/tmp': 0 } })
  : () => ({ text: '## df -k / /tmp\\nstub\\n', places: { '/': 1, '/tmp': 1 } });
process.exitCode = await runChecks({ root, mode, servers, targets, run, needs, snapshot, downloads: () => [], ciSetup: composer ? JSON.stringify({ checkout: { outcome: 'success' }, go: { outcome: 'success' }, php: { outcome: 'success' }, composer: { outcome: 'skipped' } }) : cisetup ? JSON.stringify({ checkout: { outcome: 'success' }, go: { outcome: 'success' }, rust: { outcome: 'failure' }, 'rust-cache': { outcome: 'failure' } }) : group || groupRust ? JSON.stringify(skipped) : '' });
`;

function checkout(t, checklist) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'full-run-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'checkout');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/checklist.md'), checklist);
  writeFileSync(join(root, '.gitignore'), '/.runtime/\npass-b\n');
  writeFileSync(join(base, 'stub.mjs'), STUB);
  const servers = join(base, 'servers.env');
  writeFileSync(servers, "export ORM_TEST_MYSQL_DSN='mysql://root@127.0.0.1:1/orm_test'\n");
  // guard는 pre-push hook이 설치된 checkout만 허용하므로 checkout은 실행 가능한 hook과 core.hooksPath를 갖는다.
  mkdirSync(join(root, '.githooks'));
  writeFileSync(join(root, '.githooks/pre-push'), '#!/bin/sh\n', { mode: 0o755 });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
  git('init', '-q');
  git('config', 'core.hooksPath', '.githooks');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init');
  const log = join(base, 'ran.log');
  return {
    root,
    git,
    servers,
    run: (action, mode, kill = '', env = {}) => spawnSync(process.execPath, [join(base, 'stub.mjs'), root, action, mode, log, kill, servers], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: isolatedEnvironment(env) }),
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
  for (const line of lines.slice(lines.findIndex(line => line.startsWith(`${target}:`) && !line.startsWith(`${target}:=`)) + 1)) {
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

caseTest('the decision refuses a checkout whose pre-push hook is not installed', COMPUTE, () => {
  const hooks = 'core.hooksPath is unset, not .githooks: the pre-push hook .githooks/pre-push does not run; run make hooks';
  for (const mode of ['check', 'rerun-failed']) {
    const refused = decide(mode, { items: [], changes: [], hooks, tree: 't1', commit: 'c1', record: null, targets: ['a'] });
    assert.equal(refused.allowed, false);
    assert.ok(refused.reasons.includes(`pre-push hook: ${hooks}`), refused.reasons.join('\n'));
  }
});

// make check의 첫 두 줄은 GROUP을 확인하는 make 함수이고 명령이 없다: GROUP이 없으면 빈 줄로 펼쳐지고, 맞지 않는 GROUP과
// GitHub Actions 밖의 GROUP은 명령 전에 make를 멈춘다(G5.111). 첫 명령은 guard다. `make -n check`는 case가 주는 변수만 가진
// 환경으로 실행하므로(tests/environment.mjs) CI group의 job이 이 case를 실행해도 그 GROUP과 GITHUB_ACTIONS는 닿지 않는다
// (G5.119).
caseTest('make check and make rerun-failed start with the guard', COMPUTE, () => {
  const check = recipe('check');
  assert.ok(check.slice(0, 2).every(line => line.startsWith('$(if $(GROUP),') && line.endsWith(')')), check.join('\n'));
  assert.deepEqual(check.slice(2), [
    'node scripts/check/full-run.mjs decide check',
    '$(BUILD_LEASE) && node scripts/check/run.mjs --full-run $(abspath $(TEST_ENV)) $(CHECK_RUN_TARGETS)',
  ]);
  const dry = variables => spawnSync('make', ['-n', '--no-print-directory', 'check'], { cwd: repo, encoding: 'utf8', env: isolatedEnvironment(variables) });
  for (const variables of [{}, { GROUP: 'static', GITHUB_ACTIONS: 'true' }]) {
    const result = dry(variables);
    assert.equal(result.stdout.split('\n')[0], 'node scripts/check/full-run.mjs decide check', `${JSON.stringify(variables)}: ${result.stdout}${result.stderr}`);
  }
  const local = dry({ GROUP: 'static' });
  assert.notEqual(local.status, 0, local.stdout);
  assert.match(local.stderr, /GROUP runs one CI group of make check on GitHub Actions only; run make check without GROUP/);
  const unknown = dry({ GROUP: 'nope', GITHUB_ACTIONS: 'true' });
  assert.notEqual(unknown.status, 0, unknown.stdout);
  assert.match(unknown.stderr, /GROUP nope names no CI group; give one of CI_GROUPS:/);
  assert.deepEqual(recipe('rerun-failed'), [
    'node scripts/check/full-run.mjs decide rerun-failed',
    '$(BUILD_LEASE) && node scripts/check/run.mjs --rerun-failed $(abspath $(TEST_ENV))',
  ]);
});

caseTest('a checkout without the pre-push hook setting refuses before any step', PROCESS, ({ step }) => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    c.git('config', '--unset', 'core.hooksPath');
    const result = c.run('decide', 'check');
    step(`decide: exit ${result.status}`);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /full-run: pre-push hook: core\.hooksPath is unset, not \.githooks: the pre-push hook \.githooks\/pre-push does not run; run make hooks/);
    assert.deepEqual(c.ran(), []);
  } finally {
    cleanup();
  }
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
    assert.deepEqual(record.setup.map(step => [step.name, step.status]), [['downloads', 'passed'], ['servers', 'passed'], ['databases/create', 'passed'], ['databases/drop', 'passed']]);
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
    // b는 database가 필요하지 않으므로 재실행은 database를 만들지 않는다(G5.111).
    assert.deepEqual(c.ran(), ['b']);
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
    assert.deepEqual(record.targets.map(target => [target.name, target.status]), [['a', 'running'], ['b', 'pending'], ['c', 'pending']]);
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
  const record = summarize({ targets: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'running' }, { name: 'd', status: 'pending' }] });
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
  assert.deepEqual(allowed.owners, [{ target: 'c', reasons: ['src/x.mjs'], tested: ['src/x.mjs'] }]);
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
    assert.deepEqual(c.record().targets.map(target => [target.name, target.status]), [['a', 'passed'], ['b', 'running'], ['c', 'pending']]);
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

// setup 실패 case(G5.38-1)는 database 만들기가 실패한 4개 target의 suite다: database가 필요한 a와 c는 그 단계와 첫
// 실패 줄을 이유로 not-run이고, 필요 없는 b와 d는 실행된다. b는 실패하며 보고서는 그 정확한 명령과 출력, 실패한 case의
// 기대값과 실제값, 끝나지 않은 case와 그 마지막 단계, b가 남긴 실행 directory(LIMIT_BYTES를 넘는 file은 끝만)를
// 담고, 실행은 1로 끝난다. CI의 summary 단계는 같은 실행 id의 summary를 GITHUB_STEP_SUMMARY에 쓴다.
caseTest('a failed setup step blocks only the targets that need it, and the report explains every failure', PROCESS, async ({ step }) => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const stepSummary = join(c.root, '..', 'step-summary.md');
    const env = { STUB_SUITE: 'failing', ORM_CHECK_RUN_ID: '1234-1', GITHUB_STEP_SUMMARY: stepSummary };
    const result = c.run('run', 'check', '', env);
    step(`exit ${result.status}`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(c.ran(), ['sh create', 'b', 'd', 'sh drop']);
    const record = c.record();
    const status = Object.fromEntries(record.targets.map(target => [target.name, target]));
    assert.deepEqual(record.targets.map(target => [target.name, target.status]), [['a', 'not-run'], ['b', 'failed'], ['c', 'not-run'], ['d', 'passed']]);
    for (const name of ['a', 'c'])
      assert.match(status[name].reason, /^the setup step databases\/create failed: .*Access denied for user/);
    assert.deepEqual(status.b.failures.slice(0, 2), [
      'FAIL b/count elapsed=2ms: rows of t: expected 3, actual 5',
      'case b/pending did not finish; its last step: STEP b/pending elapsed=1ms: waiting for the lock of t',
    ]);
    const report = join(c.root, '.runtime/check/ci_1234_1/report');
    assert.equal(record.id, 'ci_1234_1');
    const log = readFileSync(join(report, 'targets/b.log'), 'utf8');
    assert.match(log, /^target b\ncommand: make --no-print-directory -k TEST_ENV=\S+ DECIMAL_ENV=\S+ b\n/);
    assert.match(log, /FAIL b\/count elapsed=2ms: rows of t: expected 3, actual 5/);
    assert.match(readFileSync(join(report, 'environment.txt'), 'utf8'), /^commit [0-9a-f]{40}\ntree [0-9a-f]{40}\nos .*\nnode v/);
    const kept = join(report, 'targets/b/run/b-4242');
    // 실행 directory는 보고서로 복사된 뒤 지워진다.
    assert.equal(existsSync(join(c.root, '.runtime/run/b-4242')), false);
    assert.equal(readFileSync(join(kept, 'out.json'), 'utf8'), '{"rows": 5}\n');
    assert.match(readFileSync(join(kept, 'big.log'), 'utf8'), /^\[the last 262144 of 2097156 bytes of .*big\.log\]\nx+END\n$/);
    assert.match(readFileSync(join(kept, 'MANIFEST.txt'), 'utf8'), /big\.log kept as its last 262144 of 2097156 bytes/);
    const summaryText = readFileSync(join(report, 'summary.md'), 'utf8');
    for (const row of [/\| servers \| passed \|/, /\| databases\/create \| failed \|/, /\| a \| not-run \| {2}\| the setup step databases\/create failed/, /\| b \| failed \|/, /\| d \| passed \|/])
      assert.match(summaryText, row);
    assert.match(summaryText, /keeps only its last 262144 bytes/);
    // CI의 summary 단계는 같은 실행 id의 summary를 GITHUB_STEP_SUMMARY에 쓴다.
    process.env.GITHUB_STEP_SUMMARY = stepSummary;
    const { runSummary } = await import(resolve(repo, 'scripts/check/summary.mjs'));
    const published = runSummary(c.root, '1234-1');
    delete process.env.GITHUB_STEP_SUMMARY;
    assert.equal(published.passed, false);
    assert.match(readFileSync(stepSummary, 'utf8'), /\| b \| failed \|/);
  } finally {
    cleanup();
  }
});

// crash case(G5.38-1)는 runner가 target c에서 죽은 실행이다. summary 단계는 runner가 끝나지 않았다고 쓰고, 보고서
// directory는 그때까지의 기록과 target log를 담는다.
caseTest('the summary step reports a runner that did not finish, with the partial record', PROCESS, async () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const stepSummary = join(c.root, '..', 'step-summary.md');
    const result = c.run('run', 'check', 'c', { ORM_CHECK_RUN_ID: '99-2', GITHUB_STEP_SUMMARY: stepSummary });
    assert.equal(result.signal, 'SIGKILL');
    process.env.GITHUB_STEP_SUMMARY = stepSummary;
    const { runSummary } = await import(resolve(repo, 'scripts/check/summary.mjs'));
    const { text, passed } = runSummary(c.root, '99-2');
    delete process.env.GITHUB_STEP_SUMMARY;
    assert.equal(passed, false);
    assert.match(text, /result \*\*crashed\*\*/);
    assert.match(text, /The runner did not finish: the runner process \d+ ended without recording the end of run ci_99_2/);
    assert.match(text, /\| b \| failed \|/);
    assert.match(text, /\| c \| running \|/);
    assert.equal(readFileSync(stepSummary, 'utf8'), text);
    assert.equal(readFileSync(join(c.root, '.runtime/check/ci_99_2/report/summary.md'), 'utf8'), text);
    assert.ok(existsSync(join(c.root, '.runtime/check/ci_99_2/report/targets/b.log')));
    const missing = runSummary(c.root, '77-1');
    assert.match(missing.text, /make check recorded no run ci_77_1/);
  } finally {
    cleanup();
  }
});

// recipe 부분 case(G5.38-2)는 서로의 결과를 읽지 않는 명령을 가진 target이 그 명령마다 하위 target(부분)을 두는지
// 확인한다. runner는 target을 `make -k`로 실행하므로 앞 부분이 실패해도 뒤 부분이 실행된다. setup 부분(lease, build)에
// 기대는 부분은 그 setup 부분을 prerequisite으로 가진다.
const PARTS = {
  'checklist-check': ['unit', 'run'], 'version-check': ['unit', 'run'], 'repo-check': ['unit', 'run'], 'git-check': ['unit', 'run'],
  'testcase-check': ['go', 'node', 'runners', 'php', 'rust'], 'ts-check': ['hold', 'types', 'test'],
  'rust-check': ['check', 'clippy', 'clippy-live-db', 'clippy-test-faults'], 'rust-fmt-check': ['clients', 'bench', 'interfaces'],
  'fuzz-check': ['engine-ir', 'clients-go-orm'], 'dialect-facts-check': ['probes', 'facts'], 'feature-unit-check': ['docs', 'coverage', 'owners', 'select'],
  'client-unit-check': ['dsn', 'relation-keys', 'hostcodec', 'engine', 'runtime-model', 'orm-gen', 'perf-extensions'],
};

caseTest('a target of independent commands runs each as a part of its own', COMPUTE, () => {
  const lines = readFileSync(resolve(repo, 'Makefile'), 'utf8').split('\n');
  const problems = [];
  for (const [target, parts] of Object.entries(PARTS)) {
    const head = lines.find(line => line.startsWith(`${target}:`));
    const want = parts.map(part => `${target}/${part}`);
    if (head?.slice(target.length + 1).trim().split(/\s+/).join(' ') !== want.join(' ')) problems.push(`${target}: prerequisites ${head} instead of ${want.join(' ')}`);
    for (const part of want) if (!recipe(part).length) problems.push(`${part}: no recipe`);
    if (recipe(target).length) problems.push(`${target}: commands of its own besides its parts: ${recipe(target).join(' | ')}`);
  }
  assert.deepEqual(problems, []);
});

// make -k case는 checklist-check의 실제 정의를 임시 Makefile에 두고, 첫 부분의 node가 실패하는 PATH에서 runner의
// command로 `make -k checklist-check`를 실행한다. 둘째 부분이 실행되고 make는 실패로 끝난다.
caseTest('the parts of a target after a failed part still run under make -k', PROCESS, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'parts-')));
  try {
    const lines = readFileSync(resolve(repo, 'Makefile'), 'utf8').split('\n');
    const definition = [];
    for (const target of ['checklist-check', 'checklist-check/unit', 'checklist-check/run']) {
      const at = lines.findIndex(line => line.startsWith(`${target}:`));
      if (at < 0) continue;
      definition.push(lines[at], ...recipe(target).map(line => `\t${line}`));
    }
    writeFileSync(join(base, 'Makefile'), `${definition.join('\n')}\n`);
    mkdirSync(join(base, 'bin'));
    const log = join(base, 'ran.log');
    writeFileSync(join(base, 'bin/node'), `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in *check.test.mjs*) echo 'FAIL checklist unit: expected 0, actual 1'; exit 1;; esac\n`, { mode: 0o755 });
    const { command } = await import(resolve(repo, 'scripts/check/run.mjs'));
    const lines2 = [];
    const previous = process.env.PATH;
    process.env.PATH = `${join(base, 'bin')}:${previous}`;
    let failure = null;
    try {
      await command(base)('make', ['--no-print-directory', '-k', 'checklist-check'], line => lines2.push(line));
    } catch (error) {
      failure = error;
    } finally {
      process.env.PATH = previous;
    }
    assert.match(String(failure?.message), /make --no-print-directory -k checklist-check exited with 2/);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['--test scripts/checklist/check.test.mjs', 'scripts/checklist/check.mjs']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 보고서 case(G5.38-4)는 CI의 summary 단계가 그 실행의 보고서에 기록과 test server의 log를 두는지 확인한다. upload
// 단계는 그 보고서 directory만 올리므로 이것이 artifact다. 1 MiB보다 큰 log는 끝만 남고 data directory는 들어가지 않는다.
caseTest('the summary step keeps the record and the server logs in the report of the run', PROCESS, async () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    assert.equal(c.run('run', 'check', '', { STUB_SUITE: 'failing', ORM_CHECK_RUN_ID: '555-1' }).status, 1);
    const servers = join(c.root, '..', 'servers');
    mkdirSync(join(servers, 'mysql'), { recursive: true });
    writeFileSync(join(servers, 'mysql', 'ibdata1'), 'data');
    writeFileSync(join(servers, 'postgres.log'), 'FATAL:  role "orm" does not exist\n');
    writeFileSync(join(servers, 'mysql.log'), `${'y'.repeat(2 * 1024 * 1024)}[ERROR] Aborting\n`);
    const { runSummary } = await import(resolve(repo, 'scripts/check/summary.mjs'));
    runSummary(c.root, '555-1', servers);
    const report = join(c.root, '.runtime/check/ci_555_1/report');
    assert.deepEqual(JSON.parse(readFileSync(join(report, 'record.json'), 'utf8')), c.record());
    assert.equal(readFileSync(join(report, 'servers/postgres.log'), 'utf8'), 'FATAL:  role "orm" does not exist\n');
    assert.match(readFileSync(join(report, 'servers/mysql.log'), 'utf8'), /^\[the last 262144 of 2097169 bytes of .*mysql\.log\]\ny+\[ERROR\] Aborting\n$/);
    assert.equal(existsSync(join(report, 'servers/mysql')), false);
  } finally {
    cleanup();
  }
});

// 보고서 쓰기 case(G5.43-1)는 target b가 실행 도중 보고서 directory를 지우는 실행이다. runner는 죽지 않고 끝까지
// 실행하며, b의 기록에 `report write failed`를 남기고 1로 끝난다.
caseTest('a report write that fails is recorded and does not stop the runner', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const result = c.run('run', 'check', '', { STUB_SUITE: 'lost', ORM_CHECK_RUN_ID: '7-1', STUB_REPORT_RUN: 'ci_7_1' });
    assert.equal(result.signal, null, result.stdout + result.stderr);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(c.ran(), ['sh create', 'a', 'b', 'c', 'sh drop']);
    const record = c.record();
    assert.equal(record.result, 'failed');
    const b = record.targets.find(target => target.name === 'b');
    assert.equal(b.status, 'passed');
    assert.match(b.reportErrors[0], /^report write failed: .*\/report\/targets\/b\.log: ENOENT: /);
    assert.equal(record.targets.find(target => target.name === 'c').status, 'passed');
    assert.match(result.stdout, /report or record write\(s\) failed:\nreport write failed: .*b\.log: ENOENT/);
  } finally {
    cleanup();
  }
});

// crash case(G5.43-1)는 target b가 runner 밖에서 처리되지 않는 오류를 던지는 실행이다. runner는 그 오류를 `runner
// error: <stack>`으로 기록하고 실행을 crashed로 적고 1로 끝난다.
caseTest('an unhandled error of the runner is recorded as the reason of a crashed run', PROCESS, async () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const result = c.run('run', 'check', '', { STUB_SUITE: 'throws', ORM_CHECK_RUN_ID: '8-1' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const record = c.record();
    assert.equal(record.result, 'crashed');
    assert.match(record.reason, /^runner error: Error: boom outside the runner\n {4}at /);
    assert.equal(record.runner, null);
    const { runSummary } = await import(resolve(repo, 'scripts/check/summary.mjs'));
    const { text } = runSummary(c.root, '8-1');
    assert.match(text, /The runner did not finish: runner error: Error: boom outside the runner/);
  } finally {
    cleanup();
  }
});

// 보고서 위치 case(G5.43-2)는 database 지우기가 databases.sh drop처럼 받은 directory를 통째로 지우는 실행이다. 보고서는
// 그 directory 밖에 있으므로 environment.txt와 모든 단계의 log가 남고, 쓰기 실패는 없다.
caseTest('removing the run databases leaves the report of the run', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    writeFileSync(join(c.root, 'pass-b'), '');
    const result = c.run('run', 'check', '', { STUB_SUITE: 'drop', ORM_CHECK_RUN_ID: '9-1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const run = join(c.root, '.runtime/check/ci_9_1');
    assert.equal(existsSync(join(run, 'databases')), false);
    for (const file of ['environment.txt', 'summary.md', 'targets/servers.log', 'targets/databases-create.log', 'targets/a.log', 'targets/b.log', 'targets/c.log', 'targets/databases-drop.log'])
      assert.ok(existsSync(join(run, 'report', file)), `report/${file} is missing`);
    const record = c.record();
    assert.deepEqual([record.result, record.reportErrors, record.targets.filter(target => target.reportErrors)], ['passed', undefined, []]);
  } finally {
    cleanup();
  }
});

// log 크기 case(G5.43-2)는 target b가 3 MiB를 출력하는 실행이다. log는 실행 중에도 처음 1 MiB와 마지막 256 KiB만
// 담고, 머리(명령)와 마지막 줄, 생략한 byte 수를 가진다.
caseTest('a target log keeps its head and its tail within the size limit', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    assert.equal(c.run('run', 'check', '', { STUB_SUITE: 'verbose', ORM_CHECK_RUN_ID: '10-1' }).status, 0);
    const log = readFileSync(join(c.root, '.runtime/check/ci_10_1/report/targets/b.log'), 'utf8');
    assert.match(log, /^target b\ncommand: make --no-print-directory -k /);
    assert.match(log, /\nline 0 v+\n/);
    assert.match(log, /\n\[\.\.\. \d+ bytes of output omitted; the last \d+ bytes follow \.\.\.\]\n/);
    assert.match(log, /\nline 3071 v+\nfree space after the step \(KiB\): \{[^\n]*\}\n$/);
    assert.ok(Buffer.byteLength(log) <= 1024 * 1024 + 256 * 1024 + 2048, `the log has ${Buffer.byteLength(log)} bytes`);
    assert.equal(c.record().targets.find(target => target.name === 'b').truncated > 0, true);
  } finally {
    cleanup();
  }
});

// 첫 실패 줄 case(G5.43-3)는 G5.41-1의 CI run이 낸 client-db-check 출력 끝(scripts/check/fixtures/client-db-check-lanes.txt,
// job log에서 runner의 STEP 접두사를 뗀 그대로)을 읽는다. lane 접두사가 붙은 실패와 오류 줄이 나온 순서대로 첫 실패 줄이
// 되고, PASS와 STEP 줄은 들어가지 않는다.
caseTest('the first failure lines of a target are its failure and error lines', COMPUTE, async () => {
  const { failures } = await import(resolve(repo, 'scripts/check/report.mjs'));
  const found = failures();
  for (const line of readFileSync(resolve(repo, 'scripts/check/fixtures/client-db-check-lanes.txt'), 'utf8').split('\n').filter(Boolean)) found.line(line);
  found.exit('make --no-print-directory -k client-db-check exited with 2');
  assert.deepEqual(found.lines(), [
    "[rust] thread 'main' (33354) panicked at tests/src/integration.rs:110:80:",
    '[rust] sqlite: schema().install: DRIVER: disk I/O error',
    '[rust] FAIL columns_and_subqueries/sqlite elapsed=5ms: sqlite: schema().install: DRIVER: disk I/O error',
    '[rust] client-db-test: the rust lane failed:',
    '[rust]   /home/runner/work/orm/orm/.runtime/run/client-db-rust-20422/debug/integration /home/runner/work/orm/orm/schema/bench.dbs (exit 101)',
    './scripts/client-db-test.sh: 107: echo: echo: I/O error',
    'client-db-test: failed lanes: rust',
    'make: *** [Makefile:549: client-db-check] Error 1',
    'make --no-print-directory -k client-db-check exited with 2',
  ]);
});

// 보고된 오류 case(G5.57)는 G5.53의 CI run이 낸 feature-check 줄이다. Go testcase는 실패를 `stress_test.go:80: ...`로
// 적은 뒤 `FAIL <case> ...: the errors reported above`만 쓴다. 그 앞의 보고 줄이 FAIL 줄 앞의 첫 실패 줄이 되므로, log가
// 가운데를 줄여도 이유가 남는다. 앞서 통과한 case의 줄은 들어가지 않는다.
caseTest('a FAIL that points at the errors reported above keeps those errors as first failure lines', COMPUTE, async () => {
  const { failures } = await import(resolve(repo, 'scripts/check/report.mjs'));
  const found = failures();
  const step = 'STEP features/performance_gate/preempted-timing elapsed=1m15.37s: ';
  for (const line of [
    `${step}=== RUN   TestOther`,
    `${step}    other_test.go:12: a log line of a case that passed`,
    `${step}--- PASS: TestOther (0.01s)`,
    `${step}=== RUN   TestStressDocument`,
    `${step}RUN TestStressDocument deadline=5m0s`,
    `${step}    stress_test.go:80: stress median parse used 131ms of CPU, over the 100ms budget (docs/dbspec.md, Verification)`,
    `${step}FAIL TestStressDocument elapsed=10.25s: the errors reported above`,
    `${step}--- FAIL: TestStressDocument (10.25s)`,
  ]) found.line(line);
  assert.deepEqual(found.lines().slice(0, 2), [
    `${step}    stress_test.go:80: stress median parse used 131ms of CPU, over the 100ms budget (docs/dbspec.md, Verification)`,
    `${step}FAIL TestStressDocument elapsed=10.25s: the errors reported above`,
  ]);
});

// 통과한 case case(G5.71)는 CI run이 낸 feature-unit-check 줄이다. coverage test의 case는 검사하는 대상의 sample이
// 일부러 실패하는 출력(`FAIL sample/...`)을 보이고 PASS로 끝난다. 그 줄은 target의 실패가 아니므로 첫 실패 줄에서 빠지고,
// 그 뒤의 진짜 실패가 첫 실패 줄이 된다.
caseTest('the failure lines of a case that passed are not the first failure lines of the target', COMPUTE, async () => {
  const { failures } = await import(resolve(repo, 'scripts/check/report.mjs'));
  const found = failures();
  const sample = Array.from({ length: 25 }, (_, i) => `FAIL sample/owner/typescript/none run ${i} elapsed=31ms: unexpected test output: {"success":true}`);
  for (const line of [
    'RUN a sample of every client runs through its owning file deadline=5m0s',
    ...sample,
    'PASS a sample of every client runs through its owning file elapsed=2.1s',
    'RUN every tracked file selects a behaviour test or declares its scope deadline=1m0s',
    "FAIL every tracked file selects a behaviour test or declares its scope elapsed=75ms: packages/orm-rust/orm-build/tests/unit/row_insert_lock.rs selects no behaviour test",
  ]) found.line(line);
  assert.deepEqual(found.lines(), [
    "FAIL every tracked file selects a behaviour test or declares its scope elapsed=75ms: packages/orm-rust/orm-build/tests/unit/row_insert_lock.rs selects no behaviour test",
  ]);
});

// 경고 case(G5.73)는 성능 측정이 기준값을 넘은 `WARNING` 줄이 실패가 아니라 경고로 모이고, summary가 그것을 따로
// 적는지 본다.
caseTest('a WARNING line is kept as a warning, not a failure, and the summary lists it', COMPUTE, async () => {
  const { failureLine, failures, summary } = await import(resolve(repo, 'scripts/check/report.mjs'));
  const found = failures();
  const warned = 'dbspec_stress median parse CPU of 401.000 ms is 11.50 times the reference CPU of 34.870 ms, above the reference ratio 11.0 (docs/dbspec.md, Verification); machine Linux aarch64, PHP 8.5.4';
  for (const line of ['RUN dbspec_stress deadline=10m0s', `STEP features/helpers/dbspec-stress elapsed=2s: WARNING ${warned}`, 'PASS dbspec_stress elapsed=2.5s']) found.line(line);
  assert.equal(failureLine(`STEP features/helpers/dbspec-stress elapsed=2s: WARNING ${warned}`), false, 'a warning is no failure line');
  assert.deepEqual(found.warnings(), [warned]);
  const text = summary({ commit: 'c', tree: 't', started: 's', ended: 'e', result: 'passed', setup: [], targets: [{ name: 'feature-check', status: 'passed', warnings: [warned] }] });
  assert.match(text, /\| feature-check \| passed \|/);
  assert.ok(text.includes(`## warnings\n\nA warning is no failure: a measurement exceeded its documented reference value (AGENTS.md).\n\n- feature-check: ${warned}`), text);
});

// 공간 case(G5.43-4)는 target b가 /tmp의 quota 초과(EDQUOT)로 실패하는 실행이다. 보고서는 시작할 때와 단계마다 공간을
// 기록하고, b의 첫 실패 줄은 공간이 없어 실패했다는 것과 그 순간의 `/`와 `/tmp`의 남은 공간이다.
caseTest('a target that runs out of space says so with the free space of / and /tmp', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    assert.equal(c.run('run', 'check', '', { STUB_SUITE: 'space', ORM_CHECK_RUN_ID: '11-1' }).status, 1);
    const record = c.record();
    const b = record.targets.find(target => target.name === 'b');
    assert.match(b.failures[0], /^out of space: the target failed with ENOSPC or EDQUOT; \/ \d+\.\d\d GiB free, \/tmp \d+\.\d\d GiB free.*; the largest under \/tmp: /);
    assert.match(b.failures[1], /disk quota exceeded$/);
    assert.ok(record.disk['/'] > 0 && b.disk['/tmp'] > 0, JSON.stringify([record.disk, b.disk]));
    const disk = join(c.root, '.runtime/check/ci_11_1/report/disk');
    assert.deepEqual(readdirSync(disk), ['00-start.txt', '01-downloads.txt', '02-servers.txt', '03-databases-create.txt', '04-a.txt', '05-b.txt', '06-c.txt', '07-databases-drop.txt']);
    assert.match(readFileSync(join(disk, '05-b.txt'), 'utf8'), /^## df -k \/ \/tmp[^\n]*\n[^]*## the largest entries of \/tmp \(KiB\)\n[^]*## files under \/tmp that were removed but are still open \(lsof \+L1\)/);
  } finally {
    cleanup();
  }
});

// case 이름 case(G5.44-2)는 G5.43-4의 CI run이 낸 client-db-check 출력이다. TypeScript lane의 case 이름
// `driver-error/...`는 오류 낱말을 담지만 그 단계 줄은 database를 만들고 지운 것일 뿐이므로 첫 실패 줄이 아니고, 첫 실패
// 줄은 Rust lane의 실패다.
caseTest('a case name that holds an error word does not make its step lines failures', COMPUTE, async () => {
  const { failures } = await import(resolve(repo, 'scripts/check/report.mjs'));
  const found = failures();
  for (const line of [
    '[typescript] RUN driver-error/trigger_refused/sqlite deadline=30s',
    '[typescript] STEP driver-error/trigger_refused/sqlite elapsed=5ms: database file /tmp/orm-case-27838-1.sqlite created',
    '[typescript] STEP driver-error/trigger_refused/sqlite elapsed=42ms: database file /tmp/orm-case-27838-1.sqlite removed',
    '[typescript] PASS driver-error/trigger_refused/sqlite elapsed=43ms',
    '[typescript] RUN driver-error/check_refused/mysql deadline=30s',
    '[typescript] STEP driver-error/check_refused/mysql elapsed=14ms: database orm_case_27838_5 created',
    '[typescript] STEP driver-error/check_refused/mysql elapsed=106ms: database orm_case_27838_5 dropped',
    '[typescript] PASS driver-error/check_refused/mysql elapsed=107ms',
    '[rust] STEP invalid/every-error-in-order elapsed=77µs: cpu=79.824µs wall=80.636µs',
    '[rust] FAIL audit_record_transaction elapsed=29ms: install: DRIVER: disk I/O error',
    "[rust] thread 'audit_record_transaction' (29159) panicked at orm/tests/common/audit_rows.rs:87:67:",
    '[rust] STEP plan elapsed=3ms: write /tmp/go-build1/b001/_testmain.go: disk quota exceeded',
    'error: could not compile `polyspec-orm-build` (test "row_mutation")',
  ]) found.line(line);
  assert.deepEqual(found.lines(), [
    '[rust] FAIL audit_record_transaction elapsed=29ms: install: DRIVER: disk I/O error',
    "[rust] thread 'audit_record_transaction' (29159) panicked at orm/tests/common/audit_rows.rs:87:67:",
    '[rust] STEP plan elapsed=3ms: write /tmp/go-build1/b001/_testmain.go: disk quota exceeded',
    'error: could not compile `polyspec-orm-build` (test "row_mutation")',
  ]);
});

// disk I/O error case(G5.44-2)는 SQLite의 disk I/O error로 실패한 target b다. 그 순간 /tmp의 남은 공간이 0이면 첫 실패 줄은
// 공간 부족과 지웠지만 열린 가장 큰 file이고, 공간이 남아 있으면 그 오류만으로 공간 부족이라 적지 않는다.
caseTest('a disk I/O error is out of space only while a file system has no free space', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    assert.equal(c.run('run', 'check', '', { STUB_SUITE: 'diskio-full', ORM_CHECK_RUN_ID: '12-1' }).status, 1);
    const full = c.record().targets.find(target => target.name === 'b');
    assert.equal(full.failures[0], 'out of space: the target failed with a disk I/O error while /tmp had no free space; / 0.00 GiB free, /tmp 0.00 GiB free; the largest under /tmp: none listed; the largest removed but open file: 6192.9 MiB by lsof SIZE/OFF, /tmp/orm-binlog-AHN00Q/mysqld.log (mysqld 10079)');
    assert.match(full.failures[1], /disk I\/O error$/);
    const d = checkout({ after: f => after.push(f) }, DONE);
    assert.equal(d.run('run', 'check', '', { STUB_SUITE: 'diskio-free', ORM_CHECK_RUN_ID: '12-2' }).status, 1);
    const free = d.record().targets.find(target => target.name === 'b');
    assert.equal(free.failures[0], '[rust] FAIL audit_record_transaction elapsed=29ms: install: DRIVER: disk I/O error');
  } finally {
    cleanup();
  }
});

// npm case(G5.44-3)는 npm처럼 보고서 밖의 debug log만 가리키고 실패한 target b다. 보고서는 그 log를 targets/b/에 옮기고,
// 첫 실패 줄은 그 log의 오류 줄이다.
caseTest('a failed npm command keeps its debug log and its error lines in the report', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const debug = join(c.root, '..', '2026-10-05T11_42_43_213Z-debug-0.log');
    assert.equal(c.run('run', 'check', '', { STUB_SUITE: 'npm', STUB_NPM_LOG: debug, ORM_CHECK_RUN_ID: '13-1' }).status, 1);
    const b = c.record().targets.find(target => target.name === 'b');
    assert.deepEqual(b.failures.slice(0, 2), [
      'npm debug log .runtime/check/ci_13_1/report/targets/b/2026-10-05T11_42_43_213Z-debug-0.log: code E404',
      'npm debug log .runtime/check/ci_13_1/report/targets/b/2026-10-05T11_42_43_213Z-debug-0.log: 404 Not Found - GET https://registry.npmjs.org/x - Not found',
    ]);
    assert.equal(readFileSync(join(c.root, '.runtime/check/ci_13_1/report/targets/b/2026-10-05T11_42_43_213Z-debug-0.log'), 'utf8'), readFileSync(debug, 'utf8'));
  } finally {
    cleanup();
  }
});

// CI setup case(G5.52)는 CI setup step rust가 실패한 실행이다. runner는 setup 단계 ci/rust를 실패로 기록하고, rust가
// 필요한 a를 그 step과 함께 not-run으로 기록하며, 나머지 b와 c는 실행한다. 실패해도 target에 필요 없는 step(rust-cache)은
// 기록하지 않는다.
caseTest('a failed CI setup step marks the targets that need it not-run and runs every other target', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    assert.equal(c.run('run', 'check', '', { STUB_SUITE: 'cisetup', ORM_CHECK_RUN_ID: '14-1' }).status, 1);
    const record = c.record();
    assert.deepEqual(record.setup.map(({ name, status }) => [name, status]).filter(([name]) => name.startsWith('ci/')), [['ci/rust', 'failed']]);
    const a = record.targets.find(target => target.name === 'a');
    assert.equal(a.status, 'not-run');
    assert.match(a.reason, /^the CI setup step rust failed; its output is in the job log of that step/);
    assert.deepEqual(record.targets.filter(target => target.name !== 'a').map(({ name, status }) => [name, status]), [['b', 'passed'], ['c', 'passed']]);
    const ran = c.ran();
    assert.ok(ran.includes('b') && ran.includes('c') && !ran.includes('a'), ran.join(' '));
  } finally {
    cleanup();
  }
});


// databases setup need case(G5.127)는 databases/create가 필요로 하는 setup step(composer)이 마련되지 않은 실행이다. runner는
// server를 읽거나 database를 만들지 않고, databases를 선언한 target을 그 step과 함께 not-run으로 기록하며, 나머지 target은 실행한다.
caseTest('a run without the setup step that databases/create needs records the database targets as not-run', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    assert.equal(c.run('run', 'check', '', { STUB_SUITE: 'composer', ORM_CHECK_RUN_ID: '17-1-stress' }).status, 1);
    const record = c.record();
    assert.deepEqual(record.setup.map(({ name, status }) => [name, status]).filter(([name]) => name.startsWith('ci/') || name.startsWith('databases') || name === 'servers'), [['ci/composer', 'failed']]);
    for (const name of ['a', 'c']) {
      const target = record.targets.find(item => item.name === name);
      assert.equal(target.status, 'not-run', name);
      assert.match(target.reason, /^the setup steps servers and databases\/create need composer: the CI setup step composer was skipped, and a target of this run needs composer/);
    }
    assert.equal(record.targets.find(item => item.name === 'b').status, 'passed');
    assert.deepEqual(c.ran(), ['b']);
  } finally {
    cleanup();
  }
});

// CI group case(G5.111)는 group-needs가 setup step을 건너뛴 job의 실행이다. 건너뛴 step의 need를 이 실행의 어느 target도
// 선언하지 않으면 그 step은 setup 단계로 기록하지 않고, database가 필요한 target이 없으므로 servers와 databases 단계도
// 없으며, 모든 target이 실행되어 통과한다. 건너뛴 rust가 필요한 target은 그 step과 이유와 함께 not-run이다.
caseTest('a CI group job ignores the setup steps it skipped for needs of no target and starts no databases without a database target', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    const result = c.run('run', 'check', '', { STUB_SUITE: 'group', ORM_CHECK_RUN_ID: '15-1-static' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const record = c.record();
    assert.deepEqual(record.setup.map(({ name, status }) => [name, status]), [['downloads', 'passed']]);
    assert.deepEqual(record.targets.map(({ name, status }) => [name, status]), [['a', 'passed'], ['b', 'passed'], ['c', 'passed']]);
    assert.deepEqual(c.ran(), ['a', 'b', 'c']);
    assert.match(result.stdout, /check: the CI setup step rust was skipped; no target of this run needs rust/);
    assert.match(result.stdout, /check: no target of this run needs databases; the run reads no servers and creates no databases/);
  } finally {
    cleanup();
  }
});

caseTest('a CI group job records a target not-run when it needs a setup step that the job skipped', PROCESS, () => {
  const c = checkout({ after: f => after.push(f) }, DONE);
  try {
    assert.equal(c.run('run', 'check', '', { STUB_SUITE: 'group-rust', ORM_CHECK_RUN_ID: '16-1-static' }).status, 1);
    const record = c.record();
    assert.deepEqual(record.setup.map(({ name, status }) => [name, status]).filter(([name]) => name.startsWith('ci/')), [['ci/rust', 'failed']]);
    const a = record.targets.find(target => target.name === 'a');
    assert.equal(a.status, 'not-run');
    assert.match(a.reason, /^the CI setup step rust was skipped, and a target of this run needs rust; make ci-group-needs runs the setup steps/);
    assert.deepEqual(record.targets.filter(target => target.name !== 'a').map(({ name, status }) => [name, status]), [['b', 'passed'], ['c', 'passed']]);
  } finally {
    cleanup();
  }
});

// server 없는 실행 case(G5.67)는 문서 workflow의 make docs-ci처럼 servers 없이 runner를 실행한다. server와 database
// 단계가 없고, database가 필요한 target은 not-run이며, 나머지 target은 실행되고, summary와 target log가 그 실행의
// 보고서에 남는다.
caseTest('a run without servers runs the targets that need no database and reports them', PROCESS, async () => {
  const { runChecks } = await import(resolve(repo, 'scripts/check/run.mjs'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'full-run-')));
  try {
    const ran = [];
    const run = async (program, args, step) => { ran.push(args.at(-1)); step(`ran ${args.at(-1)}`); };
    const code = await runChecks({ root, servers: null, targets: ['docs-a', 'db-b'], run, needs: { 'docs-a': [], 'db-b': ['databases'] },
      id: '77-1-docs', snapshot: () => ({ text: 'stub\n', places: { '/': 1 } }), ciSetup: '',
      // 빠진 crate는 이 실행의 target이 필요로 하지 않으므로 downloads 단계를 실패시키지 않는다.
      downloads: () => [{ need: 'rust', message: 'the crates of packages/orm-rust/Cargo.lock are not downloaded; run make install, which downloads it' }] });
    assert.equal(code, 1);
    assert.deepEqual(ran, ['docs-a']);
    const report = join(root, '.runtime/check/ci_77_1_docs/report');
    const text = readFileSync(join(report, 'summary.md'), 'utf8');
    assert.match(text, /\| downloads \| passed \|/);
    assert.match(text, /\| docs-a \| passed \|/);
    assert.match(text, /\| db-b \| not-run \| [0-9.]+ s \| this run has no database servers \|/);
    assert.doesNotMatch(text, /\| servers \||databases\/create/);
    assert.match(readFileSync(join(report, 'targets/docs-a.log'), 'utf8'), /ran docs-a/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
