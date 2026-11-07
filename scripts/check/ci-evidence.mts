// Select full verification or a successful full manual CI run of the exact promoted commit.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export type CIContext = { event: string; ref: string; sha: string; repository: string; runId: number };
export type CIProof = { id: number; sha: string; url: string };
export type CISelection = { mode: 'full'; source?: never } | { mode: 'reuse'; source: CIProof };
export type CIAPI = (path: string, paginate?: boolean) => unknown | Promise<unknown>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const promotable = (context: CIContext) => context.event === 'push' && context.ref === 'refs/heads/main';

function validateContext(context: CIContext): void {
  if (!/^[a-f0-9]{40}$/.test(context.sha) || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) ||
      !Number.isSafeInteger(context.runId) || context.runId < 1)
    throw new Error('CI evidence context is invalid; run the ci.yml job with its repository, exact SHA and run id');
}

function proofOf(value: unknown, context: CIContext): CIProof {
  if (!object(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1 || value.id === context.runId ||
      value.event !== 'workflow_dispatch' || value.path !== '.github/workflows/ci.yml' || value.status !== 'completed' || value.conclusion !== 'success' ||
      value.head_sha !== context.sha || !object(value.repository) || value.repository.full_name !== context.repository)
    throw new Error('CI evidence is not a completed successful manual ci.yml run of this repository and exact SHA; inspect the source run');
  const url = `https://github.com/${context.repository}/actions/runs/${value.id}`;
  if (value.html_url !== url) throw new Error('CI evidence source URL differs from its repository and run id; inspect the source run');
  return { id: value.id, sha: context.sha, url };
}

async function verifyFinal(proof: CIProof, context: CIContext, api: CIAPI): Promise<void> {
  const pages = await api(`repos/${context.repository}/actions/runs/${proof.id}/jobs?filter=latest&per_page=100`, true);
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('CI evidence has no job pages; inspect the source ci-passed job');
  const jobs = pages.flatMap((page: unknown) => {
    if (!object(page) || !Array.isArray(page.jobs)) throw new Error('CI evidence jobs response is invalid; inspect the source ci-passed job');
    return page.jobs.map((job: unknown) => {
      if (!object(job) || typeof job.name !== 'string') throw new Error('CI evidence contains an invalid job record; inspect the source ci-passed job');
      return job;
    });
  }).filter(job => job.name === 'ci-passed');
  const final = jobs[0];
  if (jobs.length !== 1 || !final || final.run_id !== proof.id || final.status !== 'completed' || final.conclusion !== 'success')
    throw new Error(`CI evidence run ${proof.id} requires exactly one successful ci-passed job; complete full manual CI for this SHA`);
}

export async function selectCI(context: CIContext, api: CIAPI): Promise<CISelection> {
  validateContext(context);
  // Manual runs never borrow proof, so a reused push cannot become the source of another reuse.
  if (!promotable(context)) return { mode: 'full' };
  const value = await api(`repos/${context.repository}/actions/workflows/ci.yml/runs?head_sha=${context.sha}&status=success&event=workflow_dispatch&per_page=1`);
  if (!object(value) || !Array.isArray(value.workflow_runs) || typeof value.total_count !== 'number' || !Number.isSafeInteger(value.total_count) || value.total_count < 0)
    throw new Error('CI evidence workflow response is invalid; inspect the GitHub Actions response');
  if (value.total_count === 0 && value.workflow_runs.length === 0) return { mode: 'full' };
  if (value.total_count < 1 || value.workflow_runs.length !== 1)
    throw new Error('CI evidence workflow response disagrees with its count; inspect the GitHub Actions response');
  const source = proofOf(value.workflow_runs[0], context);
  await verifyFinal(source, context, api);
  return { mode: 'reuse', source };
}

/** Judge every result; only verified reuse can account for intentionally skipped check jobs. */
export async function requiredCI(needs: unknown, context: CIContext, api: CIAPI): Promise<Record<string, unknown>> {
  validateContext(context);
  if (!object(needs) || !object(needs.evidence) || needs.evidence.result !== 'success' || !object(needs.evidence.outputs))
    throw new Error('CI evidence decision did not succeed; inspect the evidence job before judging the check results');
  const outputs = needs.evidence.outputs;
  if (outputs.mode === 'full') return needs;
  if (outputs.mode !== 'reuse' || !promotable(context) || outputs.source_sha !== context.sha ||
      typeof outputs.source_run !== 'string' || !/^[1-9][0-9]*$/.test(outputs.source_run))
    throw new Error('CI evidence reuse decision is invalid for this push and SHA; inspect the evidence job');
  const id = Number(outputs.source_run);
  if (!Number.isSafeInteger(id)) throw new Error('CI evidence source run id is invalid; inspect the evidence job');
  const source = proofOf(await api(`repos/${context.repository}/actions/runs/${id}`), context);
  if (source.id !== id || source.url !== outputs.source_url)
    throw new Error('CI evidence source differs from the recorded decision; inspect the evidence job');
  await verifyFinal(source, context, api);
  // Failures and cancellations stay selected for Kit's ordinary judge. Only skips have proof elsewhere.
  return Object.fromEntries(Object.entries(needs).filter(([, result]) => !object(result) || result.result !== 'skipped'));
}

function githubAPI(path: string, paginate = false): unknown {
  console.log(`[ci-evidence] GET ${path}`);
  let text: string;
  try {
    text = execFileSync('gh', ['api', '--method', 'GET', '-H', 'X-GitHub-Api-Version:2026-03-10',
      ...(paginate ? ['--paginate', '--slurp'] : []), path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`CI evidence lookup failed: ${error instanceof Error ? error.message : String(error)}; provide GH_TOKEN with actions:read and inspect gh api ${path}`);
  }
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`CI evidence response is invalid JSON: ${error instanceof Error ? error.message : String(error)}; inspect gh api ${path}`); }
}

function environment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is unset; run the ci.yml job, which supplies its GitHub context`);
  return value;
}

if (import.meta.main) {
  try {
    const context: CIContext = { event: environment('GITHUB_EVENT_NAME'), ref: environment('GITHUB_REF'), sha: environment('GITHUB_SHA'),
      repository: environment('GITHUB_REPOSITORY'), runId: Number(environment('GITHUB_RUN_ID')) };
    const mode = process.argv[2];
    if (process.argv.length !== 3 || (mode !== 'plan' && mode !== 'required')) throw new Error('usage: node scripts/check/ci-evidence.mts plan|required');
    if (mode === 'plan') {
      const selection = await selectCI(context, githubAPI);
      appendFileSync(environment('GITHUB_OUTPUT'), `mode=${selection.mode}\nsource_run=${selection.source?.id ?? ''}\nsource_sha=${selection.source?.sha ?? ''}\nsource_url=${selection.source?.url ?? ''}\n`);
      const message = selection.mode === 'full' ? `Full CI selected for ${context.sha}.` : `Full manual CI [${selection.source.id}](${selection.source.url}) verified commit ${context.sha}; this main push reuses that verification.`;
      console.log(`[ci-evidence] ${message}`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    } else {
      const needs: unknown = JSON.parse(environment('RESULTS'));
      if (object(needs)) for (const [name, result] of Object.entries(needs)) console.log(`[ci-evidence] ${name}: ${object(result) ? String(result.result) : 'invalid result'}`);
      const selected = await requiredCI(needs, context, githubAPI);
      const result = spawnSync('make', ['--no-print-directory', 'ci-passed'], { stdio: 'inherit', env: { ...process.env, RESULTS: JSON.stringify(selected) } });
      if (result.error) throw new Error(`make ci-passed could not start: ${result.error.message}; install GNU make on the runner`);
      if (result.status === null) throw new Error(`make ci-passed ended by ${result.signal}; inspect the runner process report`);
      process.exitCode = result.status;
    }
  } catch (error) {
    console.error(`[ci-evidence] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
