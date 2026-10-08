#!/usr/bin/env node
// The result of the last job of a CI workflow (`make ci-passed RESULTS='<json>'`): the job runs after every other job
// (`if: ${{ always() }}`) and needs them all. RESULTS is the JSON of `toJSON(needs)`
// (`{"<job>": {"result": "success", "outputs": {}}}`). The command prints the result of each job and exits with status 0 only
// when every needed job has the result `success`: a failed, cancelled or skipped job fails it (status 1), and so does RESULTS
// that is unset, is not JSON or names no job (status 2, because nothing was judged). On GitHub Actions each finding is also
// written as an `::error::` annotation.
import { isMain } from './paths.mjs';

/** Judges `text`, the JSON of `needs`: `{ status, lines }`, where `lines` are the lines to print and `errors` the failures. */
export function passed(text) {
  const refuse = message => ({ status: 2, lines: [`[ci-passed] failed: ${message}`], errors: [message] });
  if (text === undefined || text === '') return refuse('RESULTS is not set; the step passes the JSON of needs: make ci-passed RESULTS=<json>');
  let needs;
  try {
    needs = JSON.parse(text);
  } catch (error) {
    return refuse(`RESULTS is not JSON: ${error.message}: ${JSON.stringify(text)}`);
  }
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) return refuse(`RESULTS is not a JSON object of jobs: ${JSON.stringify(text)}`);
  if (Object.keys(needs).length === 0) return refuse(`RESULTS names no job: ${JSON.stringify(text)}; list every other job of the workflow under needs`);
  const lines = [];
  const errors = [];
  for (const [job, value] of Object.entries(needs)) {
    const result = value !== null && typeof value === 'object' && typeof value.result === 'string' ? value.result : 'no result';
    lines.push(`[ci-passed] ${job}: ${result}`);
    if (result !== 'success') errors.push(`the job ${job} ended with ${result}; expected success`);
  }
  if (errors.length) return { status: 1, lines: [...lines, `[ci-passed] failed: ${errors.length} of ${Object.keys(needs).length} needed jobs did not succeed`], errors };
  return { status: 0, lines: [...lines, `[ci-passed] every needed job passed: ${Object.keys(needs).join(', ')}`], errors: [] };
}

if (isMain(import.meta.url)) {
  const result = passed(process.env.RESULTS);
  for (const line of result.lines) console.log(line);
  if (process.env.GITHUB_ACTIONS === 'true') for (const error of result.errors) console.log(`::error title=ci-passed::${error}`);
  process.exitCode = result.status;
}
