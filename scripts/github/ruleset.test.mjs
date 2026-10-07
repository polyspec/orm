// Tests the GitHub ruleset of main and the repository settings of the pull request flow (scripts/github/ruleset.mjs,
// G5.91). Each case copies the script and a declaration into a temporary directory and runs it with a fake
// `gh`, which `--gh` names. The fake keeps its state in a JSON file, answers as the REST API does and logs every call, so
// a case asserts the requests that apply sends and the result of check without reaching GitHub. A case runs the script as
// a child that it awaits, so the timeout of the case fails a script that never ends.
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The command lines of `make -n <target> <variables>`, without the variables of a calling make, which print the lines
// Entering directory and Leaving directory around the commands .
function dryRun(target, { variables = [] } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES'].includes(name)));
  const result = spawnSync('make', ['--no-print-directory', '-n', target, ...variables], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(result.status, 0, `make -n ${target}: ${result.stderr}`);
  return result.stdout.split('\n').filter(Boolean);
}
// A case body with the cleanup steps of node:test's `t.after`, run when the body ends, also after a failure.
function withCleanup(body) {
  return async () => {
    const steps = [];
    try {
      return await body({ after: step => steps.push(step) });
    } finally {
      for (const step of steps.reverse()) await step();
    }
  };
}

const SCRIPT = 'scripts/github/ruleset.mjs';
const DECLARATION = JSON.parse(readFileSync(path.join(ROOT, '.github/ruleset.json'), 'utf8'));
const REPOSITORY = DECLARATION.repository;

const FAKE_GH = String.raw`
const fs = require('node:fs');
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const apiPath = args[args.indexOf('--include') + 1];
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8') || 'null') : undefined;
state.calls.push(['gh', method, apiPath, ...(body === undefined ? [] : [body])]);
const repo = 'repos/' + state.repository;

function answer(status, payload) {
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write('HTTP/2.0 ' + status + ' X\r\nContent-Type: application/json\r\n\r\n' + (payload === undefined ? '' : JSON.stringify(payload)));
  process.exit(status >= 400 ? 1 : 0);
}

const stored = (ruleset, id) => ({ ...ruleset, id, source: state.repository, source_type: 'Repository', node_id: 'RRS_' + id,
  _links: { self: { href: 'https://api.github.com/' + repo + '/rulesets/' + id } }, created_at: '2026-10-06T00:00:00Z',
  updated_at: '2026-10-06T00:00:00Z', current_user_can_bypass: 'never' });

if (apiPath === repo && method === 'GET') answer(200, { full_name: state.repository, ...state.settings });
if (apiPath === repo && method === 'PATCH') {
  Object.assign(state.settings, body);
  answer(200, { full_name: state.repository, ...state.settings });
}
if (apiPath.startsWith(repo + '/rulesets?') && method === 'GET') answer(200, state.rulesets.map(r => ({ id: r.id, name: r.name, target: r.target })));
if (apiPath === repo + '/rulesets' && method === 'POST') {
  state.rulesets.push(stored(body, 100 + state.rulesets.length));
  answer(201, state.rulesets.at(-1));
}
if (apiPath.startsWith(repo + '/rulesets/')) {
  const id = Number(apiPath.split('/').at(-1));
  const index = state.rulesets.findIndex(r => r.id === id);
  if (method === 'PUT') state.rulesets[index] = stored(body, id);
  answer(200, state.rulesets[index]);
}
answer(404, { message: 'Not Found' });
`;



/** A live ruleset of GitHub: the declared one with the fields that GitHub adds. */
function live(ruleset, id = 7) {
  return { ...structuredClone(ruleset), id, source: REPOSITORY, source_type: 'Repository', _links: {}, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', current_user_can_bypass: 'never' };
}

/** The script, a declaration and the fake gh and git in a temporary directory. */
function sandbox(t, state = {}, declaration = DECLARATION) {
  const root = mkdtempSync(path.join(tmpdir(), 'orm-github-ruleset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts/github', '.github', 'bin']) mkdirSync(path.join(root, directory), { recursive: true });
  copyFileSync(path.join(ROOT, SCRIPT), path.join(root, SCRIPT));
  writeFileSync(path.join(root, '.github/ruleset.json'), JSON.stringify(declaration));
  for (const [name, source] of [['gh', FAKE_GH]]) {
    writeFileSync(path.join(root, 'bin', name), `#!${process.execPath}\n${source}`);
    chmodSync(path.join(root, 'bin', name), 0o755);
  }
  const statePath = path.join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify({ repository: REPOSITORY, calls: [], rulesets: [], settings: { ...DECLARATION.settings }, ...state }));
  const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const calls = kind => read().calls.filter(call => kind === undefined || call[0] === kind);
  return {
    state: read,
    calls,
    /** Runs the script to its end: { status, stdout, stderr }; `onOutput(stdout, child)` sees each chunk of its output. */
    run(mode, onOutput = () => {}) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
      Object.assign(env, { FAKE_STATE: statePath });
      const child = spawn(process.execPath, [SCRIPT, mode, '--gh', path.join(root, 'bin', 'gh')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'));
      const result = { status: null, stdout: '', stderr: '' };
      child.stdout.setEncoding('utf8').on('data', chunk => {
        result.stdout += chunk;
        onOutput(result.stdout, child);
      });
      child.stderr.setEncoding('utf8').on('data', chunk => (result.stderr += chunk));
      return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', status => resolve({ ...result, status }));
      });
    },
  };
}

// The check names of the jobs of a workflow that run on a merge group: the job ID of each job without a name.
function checkNames(file, jobs) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  assert.match(text, /^\s{2}merge_group:\s*$/m, `${file} runs on merge_group, so the merge queue receives its checks`);
  const ids = [...text.split('\njobs:\n')[1].matchAll(/^ {2}([\w-]+):\s*$/gm)].map(match => match[1]).filter(job => jobs.includes(job));
  assert.deepEqual(ids, jobs, `${file} has the jobs ${jobs.join(', ')}`);
  for (const job of ids) {
    const body = text.split(new RegExp(`\\n {2}${job}:\\n`))[1].split(/\n {2}[\w-]+:\n/)[0];
    assert.doesNotMatch(body, /^ {4}name:/m, `${file} job ${job} has a name, so its check is not its job ID`);
  }
  return ids;
}

caseTest('the declaration requires a pull request, the merge queue and every check of CI on main without a bypass actor (G5.91)', COMPUTE, () => {
  const { ruleset, settings } = DECLARATION;
  assert.equal(REPOSITORY, 'polyspec/orm');
  assert.deepEqual(settings, { allow_rebase_merge: true, allow_auto_merge: true, delete_branch_on_merge: true });
  assert.equal(ruleset.enforcement, 'active');
  assert.equal(ruleset.target, 'branch');
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/main']);
  assert.deepEqual(ruleset.rules.map(rule => rule.type).sort(), ['deletion', 'merge_queue', 'non_fast_forward', 'pull_request', 'required_linear_history', 'required_status_checks']);
  const pullRequest = ruleset.rules.find(rule => rule.type === 'pull_request').parameters;
  assert.equal(pullRequest.required_approving_review_count, 0);
  // gh pr merge --auto on a branch with a merge queue needs an allowed merge method; the queue itself merges with
  // REBASE, and required_linear_history refuses a merge commit.
  assert.deepEqual(pullRequest.allowed_merge_methods, ['merge', 'squash', 'rebase']);
  assert.equal(ruleset.rules.find(rule => rule.type === 'merge_queue').parameters.merge_method, 'REBASE');
  const checks = ruleset.rules.find(rule => rule.type === 'required_status_checks').parameters;
  // 15368 is the integration id of GitHub Actions, so a status of the same name from another integration does not satisfy the rule.
  // The required checks are the push gate and every job of ci.yml, which holds every check of the repository; the
  // Pages workflow builds and deploys the site and runs on no merge group (G5.98).
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const ciJobs = [...ci.split('\njobs:\n')[1].matchAll(/^ {2}([\w-]+):\s*$/gm)].map(match => match[1]);
  assert.deepEqual(ciJobs, ['test', 'docs']);
  assert.doesNotMatch(readFileSync(path.join(ROOT, '.github/workflows/docs-pages.yml'), 'utf8'), /^\s{2}(?:merge_group|pull_request):/m);
  const expected = [...checkNames('.github/workflows/push-gate.yml', ['push-gate']), ...checkNames('.github/workflows/ci.yml', ciJobs)];
  assert.deepEqual(checks.required_status_checks, expected.map(context => ({ context, integration_id: 15368 })));
  assert.equal(checks.strict_required_status_checks_policy, false);
});

caseTest('the Makefile runs the script for each target with the GitHub CLI of GH and has no target that pushes main (G5.91)', COMPUTE, () => {
  for (const [target, mode] of [['github-ruleset', 'apply'], ['github-ruleset-check', 'check']]) {
    assert.deepEqual(dryRun(target), [`node scripts/github/ruleset.mjs ${mode} --gh gh`]);
    assert.deepEqual(dryRun(target, { variables: ['GH=/opt/gh'] }), [`node scripts/github/ruleset.mjs ${mode} --gh /opt/gh`]);
  }
  const makefile = readFileSync(path.join(ROOT, 'Makefile'), 'utf8');
  const suite = /^CHECK_TARGETS :?= (.*)$/m.exec(makefile)[1].split(' ');
  assert.deepEqual(suite.filter(name => ['github-ruleset', 'github-ruleset-check'].includes(name)), [], 'a target of the full suite reaches the GitHub API');
  // No command of this repository pushes main: a change reaches main through a pull request and the merge queue.
  assert.doesNotMatch(makefile, /^push:/m);
});

caseTest('check fails without the ruleset and apply creates it', PROCESS, withCleanup(async t => {
  const box = sandbox(t);
  const result = await box.run('check');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\[ruleset\] differs: ruleset: live null, declared "main"/);
  assert.match(result.stderr, /run make github-ruleset/);
  assert.deepEqual(box.calls('gh').map(call => call[1]), ['GET', 'GET'], 'check only reads');
  const applied = await box.run('apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(box.calls('gh').filter(call => call[1] === 'POST'), [['gh', 'POST', `repos/${REPOSITORY}/rulesets`, DECLARATION.ruleset]]);
  const again = await box.run('check');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /the ruleset matches \.github\/ruleset\.json/);
}));

caseTest('the order and the fields that GitHub adds are not differences', PROCESS, withCleanup(async t => {
  const ruleset = live(DECLARATION.ruleset);
  ruleset.rules.reverse();
  ruleset.conditions = { ref_name: { exclude: [], include: ['refs/heads/main'] } };
  const result = await sandbox(t, { rulesets: [ruleset] }).run('check');
  assert.equal(result.status, 0, result.stderr);
}));

caseTest('a bypass actor differs, and apply replaces only the ruleset of the name', PROCESS, withCleanup(async t => {
  const ruleset = live(DECLARATION.ruleset);
  ruleset.bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
  const other = live({ ...DECLARATION.ruleset, name: 'tags', target: 'tag' }, 8);
  const box = sandbox(t, { rulesets: [other, ruleset] });
  const result = await box.run('check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[ruleset\] differs: bypass_actors: live \[\{"actor_id":5,/);
  assert.match(result.stderr, /declared \[\]/);
  const applied = await box.run('apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(box.calls('gh').filter(call => call[1] !== 'GET'), [['gh', 'PUT', `repos/${REPOSITORY}/rulesets/7`, DECLARATION.ruleset]]);
  assert.equal((await box.run('check')).status, 0);
  assert.equal(box.state().rulesets[0].name, 'tags', 'apply changes only the ruleset of the name');
}));

caseTest('a missing rule, another check and a disabled enforcement each differ', PROCESS, withCleanup(async t => {
  const ruleset = live(DECLARATION.ruleset);
  ruleset.enforcement = 'evaluate';
  ruleset.rules = ruleset.rules.filter(rule => rule.type !== 'non_fast_forward');
  ruleset.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks = [{ context: 'ci', integration_id: 15368 }];
  const result = await sandbox(t, { rulesets: [ruleset] }).run('check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[ruleset\] differs: enforcement: live "evaluate", declared "active"/);
  assert.match(result.stderr, /\[ruleset\] differs: rules: live \[\{"parameters":/);
  assert.match(result.stderr, /"context":"ci"/);
  assert.equal(result.stderr.match(/\[ruleset\] differs:/g).length, 2, result.stderr);
}));

caseTest('two rulesets of the name fail with both ids', PROCESS, withCleanup(async t => {
  const box = sandbox(t, { rulesets: [live(DECLARATION.ruleset, 7), live(DECLARATION.ruleset, 9)] });
  for (const mode of ['check', 'apply']) {
    const result = await box.run(mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${REPOSITORY} has 2 rulesets named main \\(ids 7, 9\\); delete all but one`));
  }
  assert.deepEqual(box.calls('gh').map(call => call[1]), ['GET', 'GET', 'GET', 'GET']);
}));

caseTest('a setting that differs is named by check and changed by apply', PROCESS, withCleanup(async t => {
  const box = sandbox(t, { rulesets: [live(DECLARATION.ruleset)], settings: { ...DECLARATION.settings, allow_auto_merge: false } });
  const result = await box.run('check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[ruleset\] differs: settings\.allow_auto_merge: live false, declared true/);
  const applied = await box.run('apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(box.calls('gh').filter(call => call[1] !== 'GET'), [['gh', 'PATCH', `repos/${REPOSITORY}`, DECLARATION.settings]]);
  assert.equal((await box.run('check')).status, 0);
}));
