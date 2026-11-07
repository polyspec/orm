import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { readWorkflow } from '../repo/workflow.mts';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { requiredCI, selectCI, type CIAPI, type CIContext } from './ci-evidence.mts';

const context: CIContext = { event: 'push', ref: 'refs/heads/main', sha: 'a'.repeat(40), repository: 'polyspec/orm', runId: 100 };
const source = { id: 42, event: 'workflow_dispatch', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success',
  head_sha: context.sha, repository: { full_name: context.repository }, html_url: 'https://github.com/polyspec/orm/actions/runs/42' };
const finalJob = { name: 'ci-passed', status: 'completed', conclusion: 'success', run_id: source.id };
function fixture(run: unknown = source, jobs: unknown = [{ jobs: [finalJob] }]) {
  const calls: string[] = [];
  const api: CIAPI = (path, paginate) => {
    calls.push(path);
    if (path.includes('/workflows/')) {
      assert.equal(paginate, undefined);
      return { total_count: 1, workflow_runs: [run] };
    }
    if (path.endsWith('/runs/42')) return run;
    assert.ok(path.includes('/runs/42/jobs'));
    assert.equal(paginate, true);
    return jobs;
  };
  return { calls, api };
}

caseTest('a main promotion selects the completed full manual CI of its exact commit', COMPUTE, async () => {
  const f = fixture();
  assert.deepEqual(await selectCI(context, f.api), { mode: 'reuse', source: { id: 42, sha: context.sha, url: source.html_url } });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0]?.includes(`head_sha=${context.sha}&status=success&event=workflow_dispatch&per_page=1`));
});

caseTest('manual verification and other refs always run the full suite without querying prior results', COMPUTE, async () => {
  for (const input of [{ ...context, event: 'workflow_dispatch' }, { ...context, ref: 'refs/heads/ci/t388-process' }])
    assert.deepEqual(await selectCI(input, () => { throw new Error('prior results must not be queried'); }), { mode: 'full' });
});

caseTest('a fresh main commit selects full CI when no successful manual run exists', COMPUTE, async () => {
  assert.deepEqual(await selectCI(context, () => ({ total_count: 0, workflow_runs: [] })), { mode: 'full' });
});

for (const [name, mutation] of Object.entries({
  'another SHA': { head_sha: 'b'.repeat(40) }, 'another repository': { repository: { full_name: 'other/repo' } },
  'another workflow': { path: '.github/workflows/other.yml' }, 'push evidence': { event: 'push' },
  'failed evidence': { conclusion: 'failure' }, 'unfinished evidence': { status: 'in_progress' }, 'self evidence': { id: context.runId },
})) caseTest(`CI evidence rejects ${name}`, COMPUTE, async () => {
  const f = fixture({ ...source, ...mutation });
  await assert.rejects(selectCI(context, f.api), /CI evidence/);
});

caseTest('CI evidence requires exactly one successful final job across all response pages', COMPUTE, async () => {
  for (const jobs of [[{ jobs: [] }], [{ jobs: [{ ...finalJob, conclusion: 'skipped' }] }], [{ jobs: [finalJob] }, { jobs: [finalJob] }]])
    await assert.rejects(selectCI(context, fixture(source, jobs).api), /ci-passed/);
  assert.equal((await selectCI(context, fixture(source, [{ jobs: [] }, { jobs: [finalJob] }]).api)).mode, 'reuse');
});

caseTest('a GitHub API error cannot turn into a successful full or reuse decision', COMPUTE, async () => {
  await assert.rejects(selectCI(context, () => { throw new Error('HTTP 403'); }), /HTTP 403/);
});


caseTest('malformed API records cannot be silently dropped from the source proof', COMPUTE, async () => {
  for (const value of [{}, { total_count: -1, workflow_runs: [] }, { total_count: 1, workflow_runs: [] }, { total_count: NaN, workflow_runs: [source] }])
    await assert.rejects(selectCI(context, () => value), /CI evidence/);
  await assert.rejects(selectCI(context, fixture(source, [{ jobs: [null, finalJob] }]).api), /invalid job record/);
});

const decision = { result: 'success', outputs: { mode: 'reuse', source_run: '42', source_sha: context.sha, source_url: source.html_url } };
caseTest('the final judge preserves every result of a full run, including failed and skipped jobs', COMPUTE, async () => {
  const needs = { evidence: { result: 'success', outputs: { mode: 'full' } }, test: { result: 'failure' }, docs: { result: 'skipped' } };
  assert.deepEqual(await requiredCI(needs, context, () => { throw new Error('full runs do not borrow proof'); }), needs);
});

caseTest('verified reuse accounts only for skipped work and preserves every executed failure or cancellation', COMPUTE, async () => {
  const needs = { evidence: decision, test: { result: 'skipped' }, docs: { result: 'failure' }, kit: { result: 'cancelled' }, editor: { result: 'success' } };
  const f = fixture();
  assert.deepEqual(await requiredCI(needs, context, f.api), { evidence: decision, docs: needs.docs, kit: needs.kit, editor: needs.editor });
  assert.deepEqual(f.calls, ['repos/polyspec/orm/actions/runs/42', 'repos/polyspec/orm/actions/runs/42/jobs?filter=latest&per_page=100']);
});

caseTest('the final judge rechecks the source instead of trusting a reuse flag or another SHA', COMPUTE, async () => {
  const needs = { evidence: decision, test: { result: 'skipped' } };
  await assert.rejects(requiredCI(needs, context, fixture({ ...source, head_sha: 'b'.repeat(40) }).api), /CI evidence/);
  await assert.rejects(requiredCI(needs, { ...context, event: 'workflow_dispatch' }, fixture().api), /reuse decision/);
  for (const evidence of [{ result: 'failure', outputs: decision.outputs }, { result: 'success', outputs: { mode: 'unknown' } },
    { ...decision, outputs: { ...decision.outputs, source_sha: 'b'.repeat(40) } }])
    await assert.rejects(requiredCI({ ...needs, evidence }, context, fixture().api), /CI evidence/);
});

caseTest('the workflow decides evidence before independent checks and revalidates all results last', COMPUTE, () => {
  const { jobs } = readWorkflow(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'), 'ci.yml');
  assert.equal(jobs[0]?.id, 'evidence');
  for (const id of ['kit', 'test', 'docs', 'editor']) {
    const job = jobs.find(job => job.id === id);
    assert.deepEqual(job?.value.needs, ['evidence']);
    assert.equal(job?.value.if, "${{ needs.evidence.outputs.mode == 'full' }}");
  }
  const final = jobs.at(-1);
  assert.equal(final?.id, 'ci-passed');
  assert.deepEqual(final?.value.needs, ['evidence', 'kit', 'test', 'docs', 'editor']);
  assert.equal(final?.steps.at(-1)?.value.run, 'make orm-ci-passed');
  for (const id of ['evidence', 'ci-passed']) {
    assert.deepEqual(jobs.find(job => job.id === id)?.value.permissions, { contents: 'read', actions: 'read' });
  }
});

caseTest('the required CLI delegates full-run success and failure to the actual Kit judge', COMPUTE, () => {
  for (const result of ['success', 'failure']) {
    const child = spawnSync(process.execPath, ['scripts/check/ci-evidence.mts', 'required'], {
      encoding: 'utf8', env: isolatedEnvironment({
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/ci/t388-process',
        GITHUB_SHA: context.sha, GITHUB_REPOSITORY: context.repository, GITHUB_RUN_ID: String(context.runId),
        RESULTS: JSON.stringify({ evidence: { result: 'success', outputs: { mode: 'full' } }, test: { result } }),
      }),
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status === 0, result === 'success', child.stdout + child.stderr);
    assert.match(child.stdout, new RegExp('test: ' + result));
  }
});
