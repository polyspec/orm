// CI's summary step (.github/workflows/ci.yml, runs after make check-run with `if: always()`). It finds the run record of ORM_CHECK_RUN_ID
// (.runtime/check/<id>/record.json) and writes that summary to GITHUB_STEP_SUMMARY and to the report's summary.md. If the runner
// did not finish (the process died or stopped with an error), it writes that fact and the step the runner last recorded, and, in the record,
// if there is no run at all, it writes that make orm-check stopped before the runner's record. So the upload step always carries this run's report
// directory and the partial record.
//
// Usage: ORM_CHECK_RUN_ID=<id> node scripts/check/summary.mts
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecord, recordPath, type CheckRecord } from './record.mts';
import { LIMIT_BYTES, keepFile, keepLogs, publish, reportDirectory, runName, summary } from './report.mts';

function keepPerformanceObservations(root: string, report: string, record: CheckRecord): void {
  for (const name of ['feature-coverage', 'feature-performance-check']) {
    const target = record.targets.find(step => step.name === name);
    if (target?.status !== 'passed' || !target.log || !target.started || !target.ended) continue;
    const log = resolve(root, target.log);
    const expectedLog = resolve(report, 'targets', `${name}.log`);
    if (log !== expectedLog || !existsSync(log)) continue;

    const lines = readFileSync(log, 'utf8').match(/^performance_gate raw observations: (.+)$/gm) ?? [];
    if (lines.length === 0) continue;
    if (lines.length !== 1) throw new Error(`${relative(root, log)} has ${lines.length} performance observation paths, expected one`);
    const reported = lines[0]?.slice('performance_gate raw observations: '.length) ?? '';
    const evidenceDirectory = resolve(root, 'var/evidence/performance_gate');
    const source = resolve(reported);
    const sourceRelative = relative(evidenceDirectory, source);
    if (!isAbsolute(reported) || reported !== source || !sourceRelative || sourceRelative.startsWith(`..${sep}`) || sourceRelative.includes(sep) ||
        !/^observations-\d{4}-\d{2}-\d{2}T\d{9}Z-\d+\.json$/.test(basename(source)))
      throw new Error(`${relative(root, log)} reports a performance observation outside ${relative(root, evidenceDirectory)}`);

    if (!existsSync(evidenceDirectory) || realpathSync(evidenceDirectory) !== evidenceDirectory || !existsSync(source) ||
        !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink() || realpathSync(source) !== source)
      throw new Error(`${relative(root, log)} reports a missing or linked performance observation ${reported}`);

    const stamp = /^observations-(\d{4}-\d{2}-\d{2}T)(\d{2})(\d{2})(\d{2})(\d{3})Z-/.exec(basename(source));
    const created = stamp ? Date.parse(`${stamp[1]}${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`) : Number.NaN;
    const started = Date.parse(target.started);
    const ended = Date.parse(target.ended);
    if (!Number.isFinite(created) || !Number.isFinite(started) || !Number.isFinite(ended) || created < started || created > ended)
      throw new Error(`${relative(root, log)} reports an observation not created during the passed ${name} target`);

    const destination = resolve(report, 'performance_gate', basename(source));
    if (statSync(source).size > LIMIT_BYTES)
      throw new Error(`${relative(root, source)} is too large to retain byte-for-byte in the report`);
    keepFile(source, destination);
  }
}

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
    const text = `# make orm-check ${name}\n\n**make check-run recorded no run ${name}** in ${path}: it stopped before the runner recorded the run (a command before the runner failed). The log of the make orm-check step shows why.\n`;
    publish(text, report, { step: true });
    return { text, passed: false };
  }
  // crashed is either a run stopped by an error the runner could not handle (the reason is in the record), or a run that disappeared without recording its end.
  if (record.result === 'crashed' && record.reason === undefined) throw new Error(`${path} records a crashed run without its reason`);
  const crashed = record.result === 'crashed' ? record.reason ?? null
    : record.result === 'incomplete' ? `the runner process ended without recording the end of run ${name}` : null;
  const text = summary(record, { run: record, report: relative(root, report), crashed });
  publish(text, report, { step: true });
  keepPerformanceObservations(root, report, record);
  return { text, passed: record.result === 'passed' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.env.ORM_CHECK_RUN_ID;
  if (!id) {
    console.error('ORM_CHECK_RUN_ID is unset: the summary names the run of make orm-check by it; set it to the run id that make orm-check used (CI sets it from the run id and attempt)');
    process.exit(2);
  }
  const { text } = runSummary(resolve(fileURLToPath(new URL('../..', import.meta.url))), id);
  process.stdout.write(text);
}
