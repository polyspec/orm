// The job runner of the CI recipes (scripts/check/ci-job.mts) and the plan of the group jobs (scripts/check/ci-plan.mts), T497: the setup steps stop at the first failure and skip the steps that no
// target of the group needs, every check runs to its end, a cleanup runs only after its preparation, and the status of the job
// is that of its steps.
import assert from 'node:assert/strict';
import { caseTest } from '../../tests/testcase.mts';
import { jobEnvironment, jobLines, jobStatus, ranSetup, recordSetup, setupDecision, startState, type JobState } from './ci-job.mts';
import { parseGroups, planLines } from './ci-plan.mts';

const other = (state: JobState, kind: 'check' | 'always', outcome: 'success' | 'failure' | 'skipped'): JobState =>
  ({ ...state, others: [...state.others, { kind, command: 'target', outcome }] });

caseTest('T497: a setup step after a failed one is skipped, and the job fails with the failed step', () => {
  let state = startState('1-1-static', { rust: true });
  assert.equal(setupDecision(state, 'go', undefined), null);
  state = recordSetup(state, 'go', 'failure');
  assert.equal(setupDecision(state, 'rust', 'rust'), 'the setup step go failed before it');
  state = recordSetup(state, 'rust', 'skipped', 'the setup step go failed before it');
  assert.deepEqual(state.steps, { go: { outcome: 'failure' }, rust: { outcome: 'skipped', reason: 'the setup step go failed before it' } });
  assert.equal(state.setupFailed, 'go');
  assert.equal(jobStatus(other(state, 'check', 'success')), 1);
  assert.match(jobLines(state).at(-1) ?? '', /failed: the setup step go failed/);
});

caseTest('T497: a setup step whose group output is false is skipped, and an unknown output or a repeated id is refused', () => {
  const state = startState('1-1-static', { rust: false, php: true });
  assert.equal(setupDecision(state, 'rust', 'rust'), 'no target of the group needs rust');
  assert.equal(setupDecision(state, 'composer', 'php'), null);
  assert.throws(() => setupDecision(state, 'flowmark', 'flowmark'), /--when flowmark, which is no output of the group/);
  assert.throws(() => setupDecision(recordSetup(state, 'go', 'success'), 'go', undefined), /runs the setup step go twice/);
  // A skipped setup step is no failure: the later steps run.
  const skipped = recordSetup(state, 'rust', 'skipped', 'no target of the group needs rust');
  assert.equal(skipped.setupFailed, null);
  assert.equal(setupDecision(skipped, 'composer', 'php'), null);
});

caseTest('T497: every check runs to its end, and a failed check or always step fails the job', () => {
  const state = recordSetup(startState('1-1-docs'), 'go', 'success');
  assert.equal(jobStatus(other(state, 'check', 'success')), 0);
  assert.equal(jobStatus(other(other(state, 'check', 'failure'), 'check', 'success')), 1);
  assert.equal(jobStatus(other(state, 'always', 'failure')), 1);
  assert.equal(jobStatus(other(state, 'always', 'skipped')), 0);
});

caseTest('T497: a cleanup runs only after its preparation ran, whatever its outcome', () => {
  const state = startState('1-1-kit-shared');
  assert.equal(ranSetup(state, 'context'), false);
  assert.equal(ranSetup(recordSetup(state, 'context', 'failure'), 'context'), true);
  assert.equal(ranSetup(recordSetup(state, 'context', 'skipped', 'the setup step tools failed before it'), 'context'), false);
});

caseTest('T497: every make call of a job gets the run id, the results file and the outputs of its group', () => {
  assert.deepEqual(jobEnvironment(startState('7-2-static', { 'php-extension-tools': true, mariadb: false }), '/r/steps.json'), {
    ORM_CHECK_RUN_ID: '7-2-static', ORM_CI_SETUP_FILE: '/r/steps.json', CI_GROUP_PHP_EXTENSION_TOOLS: 'true', CI_GROUP_MARIADB: 'false',
  });
});

caseTest('T497: the plan writes the matrix of the group jobs with PHP and Rust from the needs of their targets', () => {
  const groups = parseGroups(['preflight=repo-check', 'static=a,b', 'rust_only=c']);
  assert.deepEqual(groups, { preflight: ['repo-check'], static: ['a', 'b'], rust_only: ['c'] });
  const needs = { 'repo-check': ['php', 'rust'], a: ['composer'], b: [], c: ['rust'] };
  assert.deepEqual(planLines(groups, needs), [
    'groups=[{"group":"static","php":true,"rust":false},{"group":"rust_only","php":false,"rust":true}]',
    'preflight=[{"group":"preflight","php":true,"rust":true}]',
  ]);
  assert.throws(() => planLines({ static: ['a'] }, needs), /no group preflight/);
  assert.throws(() => parseGroups(['static']), /is no <group>=<target>/);
  assert.throws(() => parseGroups(['a=x', 'a=y']), /given twice/);
  assert.throws(() => planLines({ preflight: ['undeclared'] }, needs), /declares no needs/);
});
