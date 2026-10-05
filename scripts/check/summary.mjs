// CI의 summary 단계다(.github/workflows/ci.yml, make check 뒤에 `if: always()`로 실행한다). ORM_CHECK_RUN_ID의
// 실행을 .runtime/full-run.json에서 찾아 그 summary를 GITHUB_STEP_SUMMARY와 보고서의 summary.md에 쓴다. runner가
// 끝나지 않았으면(process가 죽었거나 오류로 멈췄다) 그 사실과 runner가 마지막으로 기록한 단계를 쓰고, 기록에 그
// 실행이 없으면 make check가 runner의 기록 전에 멈췄다고 쓴다. 그래서 upload 단계는 언제나 이 실행의 보고서
// directory와 부분 기록을 싣는다.
//
// Usage: ORM_CHECK_RUN_ID=<id> node scripts/check/summary.mjs
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish, reportDirectory, runName, summary } from './report.mjs';

export function runSummary(root, id) {
  const name = runName(id);
  const report = reportDirectory(root, name);
  const path = resolve(root, '.runtime/full-run.json');
  const record = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const run = record?.id === name ? record : record?.reruns?.find(entry => entry.id === name);
  if (!run) {
    const text = `# make check ${name}\n\n**make check recorded no run ${name}** in ${path}: it stopped before the runner recorded the run (the guard refused, or a command before the runner failed). The log of the make check step shows why.\n`;
    publish(text, report, { step: true });
    return { text, passed: false };
  }
  const crashed = run.result === 'incomplete' ? `the runner process ${record.runner?.pid ?? ''} ended without recording the end of run ${name}` : null;
  const text = summary(record, { run, report: relative(root, report), crashed });
  publish(text, report, { step: true });
  return { text, passed: run.result === 'passed' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.env.ORM_CHECK_RUN_ID;
  if (!id) {
    console.error('ORM_CHECK_RUN_ID is unset: the summary names the run of make check by it');
    process.exit(2);
  }
  const { text } = runSummary(resolve(fileURLToPath(new URL('../..', import.meta.url))), id);
  process.stdout.write(text);
}
