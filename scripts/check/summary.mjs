// CI의 summary 단계다(.github/workflows/ci.yml, make check-run 뒤에 `if: always()`로 실행한다). ORM_CHECK_RUN_ID의
// 실행 기록(.runtime/check/<id>/record.json)을 찾아 그 summary를 GITHUB_STEP_SUMMARY와 보고서의 summary.md에 쓴다. runner가
// 끝나지 않았으면(process가 죽었거나 오류로 멈췄다) 그 사실과 runner가 마지막으로 기록한 단계를 쓰고, 기록에 그
// 실행이 없으면 make check가 runner의 기록 전에 멈췄다고 쓴다. 그래서 upload 단계는 언제나 이 실행의 보고서
// directory와 부분 기록을 싣는다.
//
// Usage: ORM_CHECK_RUN_ID=<id> node scripts/check/summary.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordPath } from './record.mjs';
import { keepLogs, publish, reportDirectory, runName, summary } from './report.mjs';

// runSummary는 실행 id의 summary를 쓴다. 보고서에는 기록(record.json)과 test server의 log(servers/)도 둔다: upload
// 단계는 그 실행의 보고서 directory만 올리므로, 이전 실행이 남긴 file은 들어가지 않는다.
export function runSummary(root, id, servers = resolve(root, '.runtime/servers')) {
  const name = runName(id);
  const report = reportDirectory(root, name);
  const path = recordPath(root, name);
  const record = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  mkdirSync(report, { recursive: true });
  if (record) writeFileSync(resolve(report, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  keepLogs(servers, resolve(report, 'servers'));
  if (!record) {
    const text = `# make check ${name}\n\n**make check-run recorded no run ${name}** in ${path}: it stopped before the runner recorded the run (a command before the runner failed). The log of the make check step shows why.\n`;
    publish(text, report, { step: true });
    return { text, passed: false };
  }
  // crashed는 runner가 처리하지 못한 오류로 멈춘 실행(그 이유가 기록에 있다)이거나, 끝을 기록하지 못하고 사라진 실행이다.
  const crashed = record.result === 'crashed' ? record.reason
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
