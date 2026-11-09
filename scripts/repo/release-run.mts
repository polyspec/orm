// The run check of a release (make release-tag, T418): the release tags the commit of a successful push or manual run of
// .github/workflows/ci.yml and of no other workflow. documents.yml and docs-pages.yml also run on every push, and a push of
// documents alone starts no ci.yml run, so a run of either, or of any workflow other than ci.yml, would release a commit that
// no ci.yml run checked; kit's release-run reads the path of the run but takes a run of any workflow of the repository. The
// check reads the run through the GitHub API (gh api repos/<repo>/actions/runs/<id>) and refuses, with the reason, a run
// whose path is not .github/workflows/ci.yml, whose event is neither push nor workflow_dispatch, whose conclusion is not
// success, or whose head_sha is not the commit that --commit names, the commit that the release checked out to tag.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The workflow whose run a release takes. */
export const CI_WORKFLOW = '.github/workflows/ci.yml';

/** The value of `key` of the object `v`, or undefined. */
export const member = (v: unknown, key: string): unknown => (typeof v === 'object' && v !== null ? Object.entries(v).find(([name]) => name === key)?.[1] : undefined);

/** The reasons that the run `run`, the answer of the GitHub API for the run `id`, is no run a release takes; none when it is. */
export function runErrors(id: string, run: unknown, commit?: string): string[] {
  const errors: string[] = [];
  const runPath = member(run, 'path');
  const event = member(run, 'event');
  const conclusion = member(run, 'conclusion');
  const sha = member(run, 'head_sha');
  if (runPath !== CI_WORKFLOW) errors.push(`run ${id} is a run of ${String(runPath)}, not of ${CI_WORKFLOW}; a release takes a successful run of ${CI_WORKFLOW}`);
  if (event !== 'push' && event !== 'workflow_dispatch') errors.push(`run ${id} is a ${String(event)} run, not a push or workflow_dispatch run`);
  if (conclusion !== 'success') errors.push(`run ${id} has the conclusion ${String(conclusion)}, not success`);
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) errors.push(`run ${id} names no head_sha`);
  else if (commit !== undefined && sha !== commit) errors.push(`run ${id} ran on ${sha}, not on the commit ${commit} that the release tags`);
  return errors;
}

/** The owner/name of the repository of config/release.json, from its repositoryUrl https://github.com/<owner>/<name>. */
export function repositoryOf(config: unknown): string {
  const url = member(config, 'repositoryUrl');
  const match = typeof url === 'string' ? /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url) : null;
  if (!match?.[1]) throw new Error(`config/release.json has no repositoryUrl https://github.com/<owner>/<name>: ${JSON.stringify(url)}`);
  return match[1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [id, flag, commit, ...rest] = process.argv.slice(2);
  if (!id || !/^[1-9][0-9]*$/.test(id) || (flag !== undefined && (flag !== '--commit' || !commit)) || rest.length > 0) {
    console.log('release-run-check: usage: node scripts/repo/release-run.mts <run id> [--commit <sha>]; make release-tag RUN=<id> runs it');
    process.exit(2);
  }
  const repo = repositoryOf(JSON.parse(readFileSync(path.join(process.cwd(), 'config/release.json'), 'utf8')));
  const run: unknown = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/actions/runs/${id}`], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const errors = runErrors(id, run, commit);
  for (const error of errors) console.log(`release-run-check: ${error}`);
  if (errors.length > 0) process.exit(1);
  console.log(`release-run-check: run ${id} is a successful ${String(member(run, 'event'))} run of ${CI_WORKFLOW} on ${String(member(run, 'head_sha'))}`);
}
