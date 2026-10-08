// ci-setup은 CI workflow가 make check 앞에서 실행하는 setup step과 그것이 마련하는 것(need)이다. make check의
// runner(scripts/check/run.mjs)는 workflow가 ORM_CI_SETUP으로 준 step 결과(`${{ toJSON(steps) }}`)를 읽고, 실패한
// step이 마련하는 need를 선언한 target(contracts/check-inputs.json의 `needs`)을 실행하지 않고 그 step과 함께
// not-run으로 기록한다. 나머지 target은 모두 실행한다. repository check(scripts/repo/ci.mjs)는 workflow의 setup step이
// 모두 여기에 있는지 확인한다.
//
// CI는 make check를 CI group(Makefile의 CI_GROUPS와 CI_TARGETS_<group>)마다 job 하나로 실행한다. job의 step group-needs
// (make ci-group-needs)가 그 group의 target이 선언한 need에서 GROUP_OUTPUTS의 값을 step output으로 쓰고, setup step은
// STEP_OUTPUT이 적은 그 output이 true일 때만 실행한다. 그래서 group은 자기 target이 필요로 하는 setup만 한다.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// CI_SETUP은 setup step의 id마다 그 step이 마련하는 need다. null인 step은 실패해도 target이 그 step 없이 실행된다:
// rust-cache는 build cache를 되살릴 뿐이고, group-needs는 어느 setup step을 실행할지 정할 뿐이다(그 step이 실패하면
// 조건이 있는 setup step은 건너뛰고, 그 need를 선언한 target은 not-run이 된다).
export const CI_SETUP = {
  'group-needs': null,
  go: 'go',
  'go-modules': 'go',
  'node-modules': 'node-modules',
  'node-min': 'node-modules',
  rust: 'rust',
  'rust-cache': null,
  'php-min': 'php-min',
  'php-min-release': 'php-min',
  php: 'php',
  'php-sqlite': 'php',
  composer: 'composer',
  'php-extension-tools': 'php-extension-tools',
  'server-programs': 'server-programs',
  servers: 'databases',
  python: 'python',
  'python-install': 'python',
};

// RUNNER_STEPS는 runner 자신이 필요한 step이다: repository와 Node가 없으면 make check도 summary도 실행되지 않으므로,
// 그 실패는 job의 실패이고 그 step의 log가 원인이다.
export const RUNNER_STEPS = ['checkout', 'node'];

// NEEDS는 target이 선언할 수 있는 need다. databases는 runner의 setup 단계(servers, databases/create)가 마련하고, 나머지는
// CI setup step이 마련한다. 로컬 실행에는 CI setup step이 없으므로 그 need는 언제나 마련된 것으로 본다.
export const NEEDS = ['databases', ...new Set(Object.values(CI_SETUP).filter(Boolean).filter(need => need !== 'databases'))];

// GROUP_OUTPUTS는 step group-needs가 쓰는 output마다 그 output을 true로 만드는 need다. php는 PHP 두 release(가장 낮은
// release와 .php-version), 그 SQLite 확인과 Composer를 함께 설치한다: Composer와 PHP 확장 도구는 PATH의 PHP로 실행하고,
// ci-php-sqlite는 두 PHP를 모두 확인한다. server-programs는 make test-servers가 server를 시작하는 program이므로
// databases도 그것을 필요로 한다.
export const GROUP_OUTPUTS = {
  'node-modules': ['node-modules'],
  rust: ['rust'],
  php: ['php', 'php-min', 'composer', 'php-extension-tools'],
  'php-extension-tools': ['php-extension-tools'],
  'server-programs': ['server-programs', 'databases'],
  databases: ['databases'],
  python: ['python'],
};

// STEP_OUTPUT은 setup step마다 그 step을 실행하게 하는 group-needs의 output이다. null인 step은 모든 group에서 실행한다:
// make check는 lease program을 Go로 build하고(BUILD_LEASE), group-needs는 어느 step을 실행할지 정하는 step 자신이다.
export const STEP_OUTPUT = {
  'group-needs': null,
  go: null,
  'go-modules': null,
  'node-modules': 'node-modules',
  'node-min': 'node-modules',
  rust: 'rust',
  'rust-cache': 'rust',
  'php-min': 'php',
  'php-min-release': 'php',
  php: 'php',
  'php-sqlite': 'php',
  composer: 'php',
  'php-extension-tools': 'php-extension-tools',
  'server-programs': 'server-programs',
  servers: 'databases',
  python: 'python',
  'python-install': 'python',
};

// stepCondition은 CI group job에서 setup step id가 가지는 `if:` 조건이다.
export const stepCondition = id => STEP_OUTPUT[id]
  ? `\${{ !cancelled() && steps.group-needs.outputs.${STEP_OUTPUT[id]} == 'true' }}`
  : '${{ !cancelled() }}';

// SETUP_NEEDS는 runner의 setup 단계가 마련하는 need마다 그 단계 자신이 필요로 하는 need다. databases는 setup 단계
// servers와 databases/create(scripts/check/databases.sh)가 마련한다: server는 make test-servers가 server-programs의
// program으로 시작하고, databases.sh는 bench database를 Go program으로(scripts/bench-db.sh), decimal database를
// scripts/decimal-db-setup.php로 설치하며, 그 PHP는 clients/php의 Composer autoload(vendor)를 읽는다. 그래서 databases가
// 필요한 target은 이 need도 필요하다(expandNeeds).
export const SETUP_NEEDS = { databases: ['go', 'php', 'composer', 'server-programs'] };

// expandNeeds는 need 목록에 SETUP_NEEDS가 적는 need를 끝까지 더한 목록이다(선언한 순서, 그다음 더한 순서).
export function expandNeeds(needs) {
  const all = [...needs];
  for (let index = 0; index < all.length; index++)
    for (const need of SETUP_NEEDS[all[index]] ?? []) if (!all.includes(need)) all.push(need);
  return all;
}

// groupOutputs는 target들이 선언한 need(needs: {target: [need]})와 그 need의 setup 단계가 필요로 하는 need(expandNeeds)에서
// group-needs의 output을 {output: boolean}으로 돌려준다. 선언하지 않은 target은 그 이름과 고치는 방법과 함께 던진다.
export function groupOutputs(targets, needs) {
  const wanted = new Set();
  for (const target of targets) {
    if (!Object.hasOwn(needs, target)) throw new Error(`target ${target} declares no needs in contracts/check-inputs.json; declare its scope and needs there`);
    for (const need of expandNeeds(needs[target])) wanted.add(need);
  }
  return Object.fromEntries(Object.entries(GROUP_OUTPUTS).map(([output, from]) => [output, from.some(need => wanted.has(need))]));
}

// groupSetupErrors는 CI group의 job이 그 target에 필요한 setup step을 건너뛰는 곳마다 오류 하나를 돌려준다. groups는
// {group: [target]}, needs는 {target: [need]}이고, outputs는 group의 target에서 group-needs의 output을 만드는 함수(groupOutputs)다.
// target의 need와 그 need의 setup 단계가 필요로 하는 need(SETUP_NEEDS)마다, 그 need를 마련하는 CI setup step(CI_SETUP)은
// 언제나 실행되거나(STEP_OUTPUT이 null) 그 output이 true여야 한다.
export function groupSetupErrors(groups, needs, outputs = groupOutputs) {
  const errors = [];
  for (const [group, targets] of Object.entries(groups)) {
    const values = outputs(targets, needs);
    for (const target of targets) {
      for (const need of expandNeeds(needs[target] ?? [])) {
        const why = (needs[target] ?? []).includes(need) ? `${target} needs ${need}` : `${target} needs databases, whose setup step databases/create needs ${need}`;
        for (const [step, provided] of Object.entries(CI_SETUP)) {
          if (provided !== need || STEP_OUTPUT[step] === null || values[STEP_OUTPUT[step]]) continue;
          errors.push(`CI group ${group} skips the setup step ${step}, which installs ${need}: ${why}; scripts/check/ci-setup.mjs must set the output ${STEP_OUTPUT[step]} for it`);
        }
      }
    }
  }
  return [...new Set(errors)];
}

// failedCiSetup은 ORM_CI_SETUP의 text에서 성공하지 않은(실패했거나 건너뛴) setup step을 [{ id, need, outcome }]으로 돌려준다.
// step이 마련하는 need가 없거나(rust-cache, group-needs) 성공한 step은 들지 않는다. server-programs가 실패하면 server를
// 시작할 수 없으므로 databases도 실패한다. 모르는 step id는 그 step을 workflow와 이 표에 함께 선언하라는 오류다.
export function failedCiSetup(text) {
  if (!text) return [];
  const steps = JSON.parse(text);
  const failed = [];
  for (const [id, step] of Object.entries(steps)) {
    // 실패하거나 건너뛴 step은 그것이 마련하는 것을 마련하지 않았다.
    if (step?.outcome === 'success' || RUNNER_STEPS.includes(id)) continue;
    if (!Object.hasOwn(CI_SETUP, id)) throw new Error(`CI step ${id} failed and declares no need; declare it in scripts/check/ci-setup.mjs`);
    const need = CI_SETUP[id];
    const outcome = step?.outcome ?? 'unknown';
    if (need) failed.push({ id, need, outcome });
    if (need === 'server-programs') failed.push({ id, need: 'databases', outcome });
  }
  return failed;
}

// `node scripts/check/ci-setup.mjs outputs <target>...`는 group-needs step의 output 줄(`<output>=true|false`)을 쓴다. make
// ci-group-needs가 CI_TARGETS_<group>으로 실행하고, workflow가 그 줄을 $GITHUB_OUTPUT에 더한다.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...targets] = process.argv.slice(2);
  if (action !== 'outputs' || targets.length === 0) {
    console.error('usage: node scripts/check/ci-setup.mjs outputs <target>...; make ci-group-needs GROUP=<group> runs it with the targets of that CI group');
    process.exit(2);
  }
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const declared = JSON.parse(readFileSync(resolve(root, 'contracts/check-inputs.json'), 'utf8')).targets;
  const needs = Object.fromEntries(Object.entries(declared).map(([name, target]) => [name, target.needs ?? []]));
  for (const [output, value] of Object.entries(groupOutputs(targets, needs))) console.log(`${output}=${value}`);
}
