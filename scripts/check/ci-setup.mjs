// ci-setup은 CI workflow가 make check 앞에서 실행하는 setup step과 그것이 마련하는 것(need)이다. make check의
// runner(scripts/check/run.mjs)는 workflow가 ORM_CI_SETUP으로 준 step 결과(`${{ toJSON(steps) }}`)를 읽고, 실패한
// step이 마련하는 need를 선언한 target(contracts/check-inputs.json의 `needs`)을 실행하지 않고 그 step과 함께
// not-run으로 기록한다. 나머지 target은 모두 실행한다. repository check(scripts/repo/ci.mjs)는 workflow의 setup step이
// 모두 여기에 있는지 확인한다.

// CI_SETUP은 setup step의 id마다 그 step이 마련하는 need다. null인 step(rust-cache)은 실패해도 target이 그 step 없이
// 실행된다: build cache를 되살릴 뿐이다.
export const CI_SETUP = {
  go: 'go',
  'node-modules': 'node-modules',
  rust: 'rust',
  'rust-cache': null,
  'php-min': 'php-min',
  'php-min-release': 'php-min',
  php: 'php',
  'php-sqlite': 'php',
  composer: 'composer',
  'server-programs': 'server-programs',
  servers: 'databases',
};

// RUNNER_STEPS는 runner 자신이 필요한 step이다: repository와 Node가 없으면 make check도 summary도 실행되지 않으므로,
// 그 실패는 job의 실패이고 그 step의 log가 원인이다.
export const RUNNER_STEPS = ['checkout', 'node'];

// NEEDS는 target이 선언할 수 있는 need다. databases는 runner의 setup 단계(servers, databases/create)가 마련하고, 나머지는
// CI setup step이 마련한다. 로컬 실행에는 CI setup step이 없으므로 그 need는 언제나 마련된 것으로 본다.
export const NEEDS = ['databases', ...new Set(Object.values(CI_SETUP).filter(Boolean).filter(need => need !== 'databases'))];

// failedCiSetup은 ORM_CI_SETUP의 text에서 성공하지 않은(실패했거나 건너뛴) setup step을 [{ id, need }]로 돌려준다. step이 마련하는 need가 없거나
// (rust-cache) 성공한 step은 들지 않는다. server-programs가 실패하면 server를 시작할 수 없으므로 databases도 실패한다.
// 모르는 step id는 그 step을 workflow와 이 표에 함께 선언하라는 오류다.
export function failedCiSetup(text) {
  if (!text) return [];
  const steps = JSON.parse(text);
  const failed = [];
  for (const [id, step] of Object.entries(steps)) {
    // 실패하거나 건너뛴 step은 그것이 마련하는 것을 마련하지 않았다.
    if (step?.outcome === 'success' || RUNNER_STEPS.includes(id)) continue;
    if (!Object.hasOwn(CI_SETUP, id)) throw new Error(`CI step ${id} failed and declares no need; declare it in scripts/check/ci-setup.mjs`);
    const need = CI_SETUP[id];
    if (need) failed.push({ id, need });
    if (need === 'server-programs') failed.push({ id, need: 'databases' });
  }
  return failed;
}
