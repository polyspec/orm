// CI's summary step (.github/workflows/ci.yml, runs after make check-run with `if: always()`). It finds the run record of ORM_CHECK_RUN_ID
// (.runtime/check/<id>/record.json) and writes that summary to GITHUB_STEP_SUMMARY and to the report's summary.md. If the runner
// did not finish (the process died or stopped with an error), it writes that fact and the step the runner last recorded, and, in the record,
// if there is no run at all, it writes that make check stopped before the runner's record. So the upload step always carries this run's report
// directory and the partial record.
//
// Usage: ORM_CHECK_RUN_ID=<id> node scripts/check/summary.mts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecord, recordPath } from './record.mts';
import { keepLogs, publish, reportDirectory, runName, summary } from './report.mts';

// runSummary writes the summary of the run id. The report also includes the record (record.json) and the test server logs (servers/): the upload
// step uploads only that run's report directory, so files left by earlier runs are not included.
export function runSummary(root: string, id: string, servers = resolve(root, '.runtime/servers')) {
  const name = runName(id);
  const report = reportDirectory(root, name);
  const path = recordPath(root, name);
  const record = existsSync(path) ? readRecord(path) : null;
  mkdirSync(report, { recursive: true });
  if (record) writeFileSync(resolve(report, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  keepLogs(servers, resolve(report, 'servers'));
  if (!record) {
    const text = `# make check ${name}\n\n**make check-run recorded no run ${name}** in ${path}: it stopped before the runner recorded the run (a command before the runner failed). The log of the make check step shows why.\n`;
    publish(text, report, { step: true });
    return { text, passed: false };
  }
  // crashed is either a run stopped by an error the runner could not handle (the reason is in the record), or a run that disappeared without recording its end.
  if (record.result === 'crashed' && record.reason === undefined) throw new Error(`${path} records a crashed run without its reason`);
  const crashed = record.result === 'crashed' ? record.reason ?? null
    : record.result === 'incomplete' ? `the runner process ended without recording the end of run ${name}` : null;
  const text = summary(record, { run: record, report: relative(root, report), crashed });
  publish(text, report, { step: true });
  return { text, passed: record.result === 'passed' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.env.ORM_CHECK_RUN_ID;
  if (!id) {
    console.error('ORM_CHECK_RUN_ID is unset: the summary names the run of make check by it; set it to the run id that make check used (CI sets it from the run id and attempt)');
    process.exit(2);
  }
  const { text } = runSummary(resolve(fileURLToPath(new URL('../..', import.meta.url))), id);
  process.stdout.write(text);
}
