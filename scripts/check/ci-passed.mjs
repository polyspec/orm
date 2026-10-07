// ci-passed는 CI workflow(.github/workflows/ci.yml)의 마지막 job ci-passed가 실행하는 판정이다. 그 job은 `if: always()`로
// 다른 모든 job 뒤에 실행되고 `needs`의 결과(`${{ toJSON(needs) }}`)를 CI_NEEDS로 받는다. 모든 job의 결과가 success일 때만
// 통과한다: 실패, 취소, 건너뛴 job은 그 job과 결과를 적고 실패한다. ruleset이 요구하는 check는 push-gate와 이 job이다.
//
// Usage: CI_NEEDS='<toJSON(needs)>' node scripts/check/ci-passed.mjs
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// neededFailures는 needs(job id마다 { result })에서 success가 아닌 job마다 줄 하나를 돌려준다. job이 하나도 없으면 그것도
// 실패다: ci-passed는 다른 job을 needs로 받아야 판정할 것이 있다.
export function neededFailures(needs) {
  const jobs = Object.entries(needs ?? {});
  if (jobs.length === 0) return ['ci-passed received no needed job; list every other job of ci.yml under needs'];
  return jobs.filter(([, job]) => job?.result !== 'success').map(([id, job]) => `job ${id} ended with ${job?.result ?? 'no result'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = process.env.CI_NEEDS;
  if (!text) {
    console.error('CI_NEEDS is unset; give the job results as CI_NEEDS: ${{ toJSON(needs) }}, which the job ci-passed of ci.yml does');
    process.exit(2);
  }
  const needs = JSON.parse(text);
  for (const [id, job] of Object.entries(needs)) console.log(`ci-passed: job ${id}: ${job?.result}`);
  const failures = neededFailures(needs);
  for (const failure of failures) console.log(`::error title=ci-passed::${failure}`);
  if (failures.length) {
    console.error(`ci-passed: ${failures.length} of ${Object.keys(needs).length} needed job(s) did not succeed`);
    process.exit(1);
  }
  console.log(`ci-passed: every one of ${Object.keys(needs).length} needed jobs succeeded`);
}
