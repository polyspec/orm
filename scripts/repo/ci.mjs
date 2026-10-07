import { segments } from './testcases.mjs';
import { CI_SETUP, stepCondition } from '../check/ci-setup.mjs';
import { parseSelection, selectChecks } from '../features/select.mjs';
import { runName } from '../check/report.mjs';

// CI workflow의 database 서버 검사. make check의 database 검사는 make test-servers
// (scripts/test-servers.sh)가 쓴 .runtime/servers/env의 변수를 읽으므로, workflow는 같은 정의로
// 서버를 시작하고 그 모든 변수를 검사 단계에 준다.

// serverVariables는 scripts/test-servers.sh가 환경 file에 쓰는 변수 이름을 돌려준다.
export function serverVariables(serversScript) {
  return [...new Set([...serversScript.matchAll(/export ([A-Z][A-Z0-9_]*)=/g)].map(match => match[1]))];
}

// workflowSteps는 workflow의 step마다 이름, id, timeout-minutes와 run text를 돌려준다. step은 `steps:` 아래 한 단계
// 깊은 `- `로 시작하고, run text는 한 줄 값이거나 그 아래 더 깊은 block이다.
export function workflowSteps(workflow) {
  const lines = workflow.split('\n');
  const steps = [];
  let inSteps = false;
  let indent = null;
  for (const line of lines) {
    if (/^\s*steps:\s*$/.test(line)) { inSteps = true; indent = null; continue; }
    if (!inSteps) continue;
    const item = line.match(/^(\s*)- (.*)$/);
    if (item && (indent === null || item[1].length === indent)) {
      indent = item[1].length;
      steps.push({ lines: [' '.repeat(indent + 2) + item[2]] });
    } else if (steps.length > 0 && (line.trim() === '' || line.match(/^\s*/)[0].length > indent)) {
      steps.at(-1).lines.push(line);
    }
  }
  return steps.map(({ lines: stepLines }) => {
    const name = stepLines.map(line => line.match(/^\s*name:\s*(.*)$/)).find(Boolean)?.[1] ?? stepLines[0].trim();
    const id = stepLines.map(line => line.match(/^\s*id:\s*(\S+)\s*$/)).find(Boolean)?.[1];
    const timeout = stepLines.map(line => line.match(/^\s*timeout-minutes:\s*(\S+)\s*$/)).find(Boolean)?.[1];
    const start = stepLines.findIndex(line => /^\s*run:/.test(line));
    if (start === -1) return { name, id, timeout, run: '' };
    const runIndent = stepLines[start].match(/^\s*/)[0].length;
    const inline = stepLines[start].replace(/^\s*run:\s*/, '');
    const block = [];
    for (const line of stepLines.slice(start + 1)) {
      if (line.trim() !== '' && line.match(/^\s*/)[0].length <= runIndent) break;
      block.push(line.trim());
    }
    return { name, id, timeout, run: /^[|>][-+]?$/.test(inline) ? block.join('\n').trim() : inline };
  });
}

// workflowJobs는 workflow의 job마다 [id, text]를 돌려준다. job은 `jobs:` 아래 두 칸 깊은 key이고, text는 그 key부터
// 다음 job 앞까지다. job마다 runner가 따로이므로 step의 순서와 setup은 job 안에서 본다. `jobs:`가 없는 text는 job
// 하나다.
export function workflowJobs(workflow) {
  const lines = workflow.split('\n');
  const start = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (start === -1) return [[null, workflow]];
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([\w-]+):\s*$/.exec(line);
    if (key) jobs.push([key[1], [line]]);
    else if (/^\S/.test(line)) break;
    else if (jobs.length) jobs.at(-1)[1].push(line);
  }
  return jobs.map(([id, body]) => [id, body.join('\n')]);
}

// actionSteps는 workflow에서 action(예: actions/setup-node)을 쓰는 step마다 그 step의 줄을 돌려준다.
export function actionSteps(workflow, action) {
  const lines = workflow.split('\n');
  const steps = [];
  for (let index = 0; index < lines.length; index++) {
    const item = lines[index].match(/^(\s*)- uses:\s*(\S+)@/);
    if (!item || item[2] !== action) continue;
    const indent = item[1].length;
    const body = [lines[index]];
    for (const line of lines.slice(index + 1)) {
      if (line.trim() !== '' && line.match(/^\s*/)[0].length <= indent) break;
      body.push(line);
    }
    steps.push(body.join('\n'));
  }
  return steps;
}

// repository의 make target은 run text의 줄 머리에서 실행한다. 다른 directory에서 build하는
// make(예: `(cd /tmp/sqlite && make)`)는 검사가 아니다.
const startsServers = run => /^make test-servers\s*$/m.test(run);
// make install과 그 부분(install-*)은 server 없이 download만 하므로 server보다 앞서도 된다.
const runsMake = run => /^make\s+(?!install(?:-[\w-]+)?(?:\s+install(?:-[\w-]+)?)*\s*$)/m.test(run) && !startsServers(run);

// ciServerErrors는 workflow가 database 검사의 서버와 변수를 test-servers.sh와 같은 정의로 주지
// 않거나 symbolic link를 만드는 곳마다 오류 하나를 돌려준다.
//   - make test-servers를 실행하는 step이 없으면 workflow가 적지 않은 각 변수가 오류다.
//   - make를 실행하는 다른 step이 그 step보다 앞서면 오류다.
//   - workflow가 그 변수를 직접 정의하거나 .runtime/servers/env를 직접 쓰면 오류다.
//   - symbolic link를 만드는 step(ln -s, symlink)은 오류다.
export function ciServerErrors(workflow, serversScript) {
  const variables = serverVariables(serversScript);
  const errors = [];
  if (variables.length === 0) return ['scripts/test-servers.sh writes no environment variable'];
  const steps = workflowSteps(workflow);
  const server = steps.findIndex(step => startsServers(step.run));
  if (server === -1) {
    for (const variable of variables) {
      if (!new RegExp(`(^|[^A-Z0-9_])${variable}([^A-Z0-9_]|$)`).test(workflow))
        errors.push(`ci.yml does not provide ${variable}, which the database checks read`);
    }
    errors.push('ci.yml does not start the database servers with make test-servers');
  } else {
    // CI setup step(scripts/check/ci-setup.mjs)은 server가 필요 없는 설치와 환경 확인이다.
    steps.slice(0, server).filter(step => runsMake(step.run) && !Object.hasOwn(CI_SETUP, step.id ?? '')).forEach(step =>
      errors.push(`ci.yml step "${step.name}" runs make before make test-servers starts the servers`));
  }
  for (const variable of variables) {
    if (new RegExp(`^\\s*${variable}\\s*:`, 'm').test(workflow))
      errors.push(`ci.yml defines ${variable}; make test-servers defines it`);
  }
  if (/>>?\s*\.runtime\/servers\/env/.test(workflow))
    errors.push('ci.yml writes .runtime/servers/env; make test-servers writes it');
  // symbolic link는 쓰지 않는다(AGENTS.md): 서버 program은 자기 package 경로에서 찾는다.
  for (const step of steps) {
    if (/(^|[\s;&|(])ln\s+(-[A-Za-z]*s[A-Za-z]*|--symbolic)(\s|$)|symlink/im.test(step.run))
      errors.push(`ci.yml step "${step.name}" creates a symbolic link`);
  }
  return errors;
}

// checkTargets는 Makefile의 CHECK_TARGETS, 곧 make check가 실행하는 target을 돌려준다.
export function checkTargets(makefile) {
  return /^CHECK_TARGETS = (.*)$/m.exec(makefile)?.[1].trim().split(/\s+/) ?? [];
}

// GROUP_CHECK는 CI group의 job이 make check를 실행하는 줄이다: matrix의 group 하나의 target(CI_TARGETS_<group>)을 실행한다.
export const GROUP_CHECK = 'make check GROUP=${{ matrix.group }}';

// runsCheck는 명령 조각이 make check를 실행하는지다: 모든 target(`make check`)이거나 CI group 하나(GROUP_CHECK)다.
export const runsCheck = segment => /^make\s+check\s*$/.test(segment.trim()) || segment.trim() === GROUP_CHECK;
const checkStep = step => step.run.split('\n').flatMap(segments).some(runsCheck);
const groupStep = step => step.run.split('\n').flatMap(segments).some(segment => segment.trim() === GROUP_CHECK);

// ciGroups는 Makefile의 CI group이다: groups는 CI_GROUPS, targets는 CI_TARGETS_<group>마다 그 target이다.
export function ciGroups(makefile) {
  const groups = /^CI_GROUPS = (.*)$/m.exec(makefile)?.[1].trim().split(/\s+/).filter(Boolean) ?? [];
  const targets = Object.fromEntries([...makefile.matchAll(/^CI_TARGETS_([a-z0-9_-]+) = (.*)$/gm)].map(match => [match[1], match[2].trim().split(/\s+/).filter(Boolean)]));
  return { groups, targets };
}

// matrixGroups는 job text의 matrix `group: [a, b]` 목록이다. 없으면 null이다.
export function matrixGroups(job) {
  const list = /^\s*group:\s*\[(.*)\]\s*$/m.exec(job)?.[1];
  return list === undefined ? null : list.split(',').map(item => item.trim()).filter(Boolean);
}

// ciGroupErrors는 CI group이 CHECK_TARGETS를 나누지 않는 곳마다 오류 하나를 돌려준다. GROUP_CHECK를 실행하는 job의
// matrix group은 CI_GROUPS와 같고, CI group마다 CI_TARGETS_<group>이 있으며, 모든 group의 target을 합하면 CHECK_TARGETS와
// 같고 어느 target도 두 group에 있지 않다. 그래서 job들이 함께 make check의 모든 target을 한 번씩 실행한다.
export function ciGroupErrors(workflow, makefile) {
  const errors = [];
  const { groups, targets } = ciGroups(makefile);
  const checks = checkTargets(makefile);
  if (groups.length === 0) return [`ci.yml runs ${GROUP_CHECK}, but the Makefile declares no CI_GROUPS`];
  for (const [id, job] of workflowJobs(workflow)) {
    if (!workflowSteps(job).some(groupStep)) continue;
    const matrix = matrixGroups(job);
    if (!matrix) { errors.push(`ci.yml job ${id} runs ${GROUP_CHECK} without a matrix group: [...] of CI_GROUPS`); continue; }
    for (const group of new Set(matrix.filter((group, index) => matrix.indexOf(group) !== index))) errors.push(`ci.yml job ${id} lists the matrix group ${group} twice`);
    for (const group of groups) if (!matrix.includes(group)) errors.push(`ci.yml job ${id} has no matrix group ${group} of CI_GROUPS, so no job runs its targets`);
    for (const group of new Set(matrix)) if (!groups.includes(group)) errors.push(`ci.yml job ${id} has the matrix group ${group}, which is not in CI_GROUPS`);
  }
  for (const group of new Set(groups.filter((group, index) => groups.indexOf(group) !== index))) errors.push(`Makefile CI_GROUPS lists ${group} twice`);
  for (const group of groups) if (!(targets[group]?.length > 0)) errors.push(`Makefile CI group ${group} declares no CI_TARGETS_${group}`);
  for (const group of Object.keys(targets)) if (!groups.includes(group)) errors.push(`Makefile declares CI_TARGETS_${group}, but ${group} is not in CI_GROUPS`);
  const owners = new Map();
  for (const group of groups) for (const target of targets[group] ?? []) owners.set(target, [...(owners.get(target) ?? []), group]);
  for (const target of checks) {
    const runs = owners.get(target) ?? [];
    if (runs.length === 0) errors.push(`no CI group runs ${target} of CHECK_TARGETS; add it to one CI_TARGETS_<group>`);
    else if (runs.length > 1) errors.push(`CI groups ${runs.join(', ')} each run ${target}; every target of CHECK_TARGETS runs in exactly one group`);
  }
  for (const [target, runs] of owners) if (!checks.includes(target)) errors.push(`CI group ${runs.join(', ')} runs ${target}, which is not a target of CHECK_TARGETS`);
  return errors;
}

// ciReportPathErrors는 CI job이 올리는 보고서 directory가 runner가 쓰는 directory가 아닌 곳마다 오류 하나를 돌려준다. job마다
// step의 `ORM_CHECK_RUN_ID`와 upload step의 `path:`에 run id 1, attempt 1과 matrix group(CI_GROUPS의 group마다)을 넣고, 그
// path가 runner의 보고서 `.runtime/check/<runName(ORM_CHECK_RUN_ID)>/report/`와 같기를 요구한다. runName은 영문 소문자와 숫자가
// 아닌 글자를 `_`로 바꾸므로, 그 밖의 글자가 있는 group 이름의 path는 runner가 쓰지 않은 directory를 가리킨다.
export function ciReportPathErrors(workflow, makefile) {
  const { groups } = ciGroups(makefile);
  const errors = [];
  for (const [id, job] of workflowJobs(workflow)) {
    const runId = /^\s*ORM_CHECK_RUN_ID:\s*(.+)$/m.exec(job)?.[1].trim();
    const path = /^\s*path:\s*(\.runtime\/check\/.+)$/m.exec(job)?.[1].trim();
    if (!runId || !path) continue;
    const fill = (text, group) => text.replaceAll('${{ github.run_id }}', '1').replaceAll('${{ github.run_attempt }}', '1').replaceAll('${{ matrix.group }}', group);
    for (const group of runId.includes('matrix.group') ? groups : ['']) {
      const want = `.runtime/check/${runName(fill(runId, group))}/report/`;
      const have = fill(path, group);
      if (have !== want) errors.push(`ci.yml job ${id}${group ? ` group ${group}` : ''} uploads ${have}, but the runner writes the report of ORM_CHECK_RUN_ID ${fill(runId, group)} to ${want}; name the group with lowercase letters, digits and _ only`);
    }
  }
  return errors;
}

// ciCheckTargetErrors는 CI workflow가 make check의 target(CHECK_TARGETS)을 빠뜨리거나 두 번
// 실행하는 곳마다 오류 하나를 돌려준다. step의 run text에서 줄 머리의 `make`가 실행하는 target을
// 읽는다. `make check`는 모든 CHECK_TARGETS를 make check의 runner(scripts/check/run.mjs)로 실행하므로
// 그 target을 따로 실행하면 두 번 실행한다. `make check GROUP=...`은 CI group 하나를 실행하므로 group들이
// CHECK_TARGETS를 정확히 나눠야 한다(ciGroupErrors). `make check`가 없으면 각 target이 어느 step에 있어야 한다.
export function ciCheckTargetErrors(workflow, makefile) {
  const targets = checkTargets(makefile);
  if (targets.length === 0) return ['Makefile declares no CHECK_TARGETS'];
  const ran = new Map();
  for (const step of workflowSteps(workflow)) {
    for (const line of step.run.split('\n')) {
      const command = /^make\s+(.*)$/.exec(line.trim())?.[1];
      if (!command) continue;
      for (const word of command.split(/\s+/)) {
        if (!/^[a-z0-9-]+$/.test(word)) break;
        ran.set(word, step.name);
      }
    }
  }
  if (ran.has('check'))
    return [...targets.filter(target => ran.has(target)).map(target =>
      `ci.yml step "${ran.get(target)}" runs ${target}, which make check runs`),
    ...(workflowSteps(workflow).some(groupStep) ? ciGroupErrors(workflow, makefile) : [])];
  return targets.filter(target => !ran.has(target)).map(target =>
    `ci.yml does not run ${target} of CHECK_TARGETS`);
}

// featureCommands는 contracts/features.json에서 repository root에서 실행하는 검증 명령(`command`
// 값, `cwd`가 없거나 `.`)을 돌려준다. make check의 feature-check가 그 명령을 모두 실행한다
// (scripts/features/check.mjs --run).
export function featureCommands(features) {
  const commands = [];
  const visit = value => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (typeof value.command === 'string' && (value.cwd ?? '.') === '.') commands.push(value.command);
      for (const [key, item] of Object.entries(value)) if (key !== 'command') visit(item);
    }
  };
  visit(features);
  return commands;
}

// recipe는 Makefile에서 target의 명령 줄을 돌려준다. target이 없으면 undefined다.
function recipe(makefile, target) {
  const lines = makefile.split('\n');
  const start = lines.findIndex(line => line.startsWith(`${target}:`));
  if (start === -1) return undefined;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) break;
    body.push(line.slice(1));
  }
  return body;
}

// shellCommand는 명령을 비교할 형태로 바꾼다: make의 `$$`는 `$`, `$(NAME)`은 `$NAME`이 되고,
// 앞의 `$WITH_TEST_ENV`(검사 서버의 환경을 읽는 make 변수)는 빠지며, 공백은 하나로 줄인다.
function shellCommand(command, fromMakefile) {
  let text = command.trim();
  if (fromMakefile) text = text.replaceAll('$$', '\0').replace(/\$\(([A-Z_][A-Z0-9_]*)\)/g, '$$$1').replaceAll('\0', '$');
  return text.replace(/^\$WITH_TEST_ENV\s+/, '').replace(/\s+/g, ' ');
}

// ciDuplicateCommandErrors는 CI workflow가 make check 안에서 feature-check가 실행하는 검증 명령을
// 다시 실행하는 step마다 오류 하나를 돌려준다. step의 줄이 그 명령과 같거나, 줄이 실행하는 make
// target(CHECK_TARGETS 밖)의 명령이 모두 그 명령이면 두 번 실행한다.
export function ciDuplicateCommandErrors(workflow, makefile, commands) {
  const known = new Set(commands.map(command => shellCommand(command, false)));
  const targets = new Set(checkTargets(makefile));
  const errors = [];
  for (const step of workflowSteps(workflow)) {
    for (const line of step.run.split('\n').map(item => item.trim()).filter(Boolean)) {
      if (known.has(shellCommand(line, false))) {
        errors.push(`ci.yml step "${step.name}" runs ${line}, which make check runs in feature-check`);
        continue;
      }
      const make = /^make\s+(.*)$/.exec(line)?.[1];
      if (!make) continue;
      for (const target of make.split(/\s+/).filter(word => /^[a-z0-9-]+$/.test(word) && !targets.has(word) && word !== 'check')) {
        const body = recipe(makefile, target);
        if (body?.length > 0 && body.every(command => known.has(shellCommand(command, true))))
          errors.push(`ci.yml step "${step.name}" runs make ${target}, whose commands make check runs in feature-check`);
      }
    }
  }
  return errors;
}

// makeRules는 Makefile의 규칙 `target: prerequisites`마다 target과 그 선행 target이다. pattern 규칙(`%`)과 target별
// 변수 정의는 뺀다.
function makeRules(makefile) {
  const rules = new Map();
  for (const match of makefile.matchAll(/^([a-z0-9][a-z0-9/-]*):(?!=)([^=\n]*)$/gm))
    rules.set(match[1], match[2].trim().split(/\s+/).filter(word => /^[a-z0-9][a-z0-9/-]*$/.test(word)));
  return rules;
}

// expandFunctions는 expand 뒤에 남은 make 함수 `$(addprefix <prefix>,<words>)`를 그 결과 단어로 바꾼다.
function expandFunctions(command) {
  return command.replace(/\$\(addprefix ([^,()]*),([^()]*)\)/g, (whole, prefix, words) => words.trim().split(/\s+/).filter(Boolean).map(word => `${prefix}${word}`).join(' '));
}

// helperRunErrors는 make check가 contracts/features.json의 helper check를 한 번이 아니게 실행하는 helper마다 오류 하나를
// 돌려준다. helper check를 실행하는 곳은 셋이다: CHECK_TARGETS의 recipe가 `node scripts/features/check.mjs --run`으로 그
// helper를 고르는 target, helper의 명령이 `make ... <target>`이고 그 target이 make check의 target이나 그 선행 target인 경우의
// 그 target, helper의 명령이 `sh <script>`이고 runner의 setup 단계 databases/create(setupScript, scripts/check/databases.sh)가
// 그 script를 실행하는 경우의 그 setup 단계다. 같은 일을 두 번 하는 실행은 시간만 쓰고, 한 번도 실행하지 않는 helper는
// make check가 검사하지 않는다.
export function helperRunErrors(manifest, makefile, setupScript) {
  const variables = makeVariables(makefile);
  const rules = makeRules(makefile);
  const reached = new Set();
  const pending = [...checkTargets(makefile)];
  while (pending.length) {
    const target = pending.pop();
    if (reached.has(target)) continue;
    reached.add(target);
    pending.push(...(rules.get(target) ?? []));
  }
  const places = new Map((manifest.helpers ?? []).map(helper => [helper.id, []]));
  for (const target of checkTargets(makefile)) {
    for (const line of recipe(makefile, target) ?? []) {
      const args = /\bnode\s+scripts\/features\/check\.mjs\s+(.*)$/.exec(expandFunctions(expand(line, variables)))?.[1].trim().split(/\s+/);
      if (!args?.includes('--run')) continue;
      for (const { feature, check } of selectChecks(manifest, parseSelection(args)))
        if (feature.id === 'helpers') places.get(check.id)?.push(`make ${target}`);
    }
  }
  for (const helper of manifest.helpers ?? []) {
    const make = /^make\s+(.*)$/.exec(helper.command.trim())?.[1];
    for (const word of make?.split(/\s+/) ?? [])
      if (!word.startsWith('-') && !word.includes('=') && reached.has(word)) places.get(helper.id).push(`make ${word}, a target of make check`);
    const script = /^sh\s+(\S+\.sh)$/.exec(helper.command.trim())?.[1];
    if (script && setupScript.includes(script)) places.get(helper.id).push(`the setup step databases/create of make check (scripts/check/databases.sh runs ${script})`);
  }
  const errors = [];
  for (const [id, runs] of places) {
    if (runs.length === 0)
      errors.push(`make check runs no check of helper ${id}: no target of CHECK_TARGETS selects it and its command is no target or setup step of make check; leave it out of FEATURE_STRESS_HELPERS and FEATURE_SUITE_HELPERS so that make feature-helper-check runs it`);
    else if (runs.length > 1)
      errors.push(`make check runs the check of helper ${id} ${runs.length} times: ${runs.join('; ')}; run it once, and add a helper whose check a target or setup step of make check runs to FEATURE_SUITE_HELPERS, which make feature-helper-check leaves out`);
  }
  return errors;
}

// runnerErrors는 workflow의 job이 .github/runner가 선언한 runner 하나가 아닌 곳마다 오류 하나를
// 돌려준다. declared는 .github/runner의 내용(runner label 하나와 줄 끝), workflows는 {path: text}다.
// 모든 job이 같은 Linux runner에서 실행한다.
export function runnerErrors(declared, workflows) {
  const runner = declared.trim();
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(runner) || declared !== `${runner}\n`)
    return [`.github/runner must hold one runner label and a newline, found ${JSON.stringify(declared)}`];
  // contracts/features.json의 environment linux-runner 검증 명령은 이 runner의 make check만 실행한다.
  if (!runner.startsWith('ubuntu-'))
    return [`.github/runner ${runner} is not a Linux runner; the linux-runner checks of contracts/features.json run only there`];
  const errors = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    const labels = [...workflow.matchAll(/^\s*runs-on:\s*(.*?)\s*$/gm)].map(match => match[1]);
    if (labels.length === 0) errors.push(`${path} declares no runs-on`);
    for (const label of labels)
      if (label !== runner) errors.push(`${path} runs on ${label}; .github/runner declares ${runner}`);
  }
  return errors;
}

// stepTimeoutErrors는 workflow의 step이나 job이 기한(timeout-minutes)을 가질 때마다 오류 하나를 돌려준다
// (AGENTS.md testing rule). CI의 step은 checkout, 설치, server 시작, 도구 실행, 전체 suite 같은 장기
// 작업이고, GitHub runner가 step마다 출력 줄을 실행하는 대로 log에 남기고 종료 코드로 결과를 정한다. 장기
// 작업은 기한 없이 그 단계 로그로 관측하며, 기한은 test case 안에만 있다. step 밖의 timeout-minutes는 job
// 전체의 기한이다.
export function stepTimeoutErrors(workflows) {
  const errors = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    const steps = workflowSteps(workflow);
    for (const step of steps)
      if (step.timeout !== undefined)
        errors.push(`${path} step "${step.name}" has timeout-minutes; a long operation gets step logs and no deadline`);
    const all = workflow.split('\n').filter(line => /^\s*timeout-minutes:/.test(line)).length;
    const inSteps = steps.filter(step => step.timeout !== undefined).length;
    if (all > inSteps) errors.push(`${path} has timeout-minutes outside its steps, a deadline for a whole job; a long operation gets step logs and no deadline`);
  }
  return errors;
}

// makeVariables는 Makefile의 한 줄 변수 정의(`NAME = value`, `NAME := value`)다.
export function makeVariables(makefile) {
  return new Map([...makefile.matchAll(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*:?=\s*(.*)$/gm)].map(match => [match[1], match[2].trim()]));
}

// expand는 명령 안의 make 변수(`$(NAME)`)를 정의로 바꾼다. 정의가 다시 변수를 쓰면 몇 번 더 바꾼다.
export function expand(command, variables) {
  let text = command;
  for (let round = 0; round < 4; round++)
    text = text.replace(/\$\(([A-Z_][A-Z0-9_]*)\)/g, (whole, name) => variables.get(name) ?? whole);
  return text;
}

// runnerIdentity는 명령 조각이 실행하는 test runner의 정체다: `go test`(fuzzing만 하는 `-fuzz`는 test
// 실행이 아니다), `go vet`, `cargo test`, `php <file>`, `node --test`나 test file을 실행하는 `node`.
// 앞의 환경 변수 대입은 정체를 바꾸지 않는다. test runner가 아니면 undefined다.
export function runnerIdentity(segment) {
  const command = segment.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  // tests/run-long.mjs는 `--` 뒤의 명령을, tests/go-test.mjs는 go test를 실행한다.
  const wrapped = /^node\s+tests\/run-long\.mjs\s.*?\s--\s+(.*)$/.exec(command);
  if (wrapped) return runnerIdentity(wrapped[1]);
  // tests/go-run.mjs는 Go program(checker)을 build해 실행한다. test runner가 아니다.
  if (/^node\s+tests\/go-run\.mjs\b/.test(command)) return undefined;
  if (/^(?:go\s+test|node\s+tests\/go-test\.mjs)\b/.test(command)) return /\s-fuzz[\s=]/.test(command) ? undefined : 'go test';
  if (/^go\s+vet\b/.test(command)) return 'go vet';
  if (/^cargo\s+(?:\+\S+\s+)?test\b/.test(command)) return 'cargo test';
  const php = /^php\s+(?:-\S+\s+)*([\w./-]+\.php)\b/.exec(command);
  if (php) return `php ${php[1]}`;
  if (/^node\s+(?:-\S+\s+)*(?:--test\b|(?:clients|tests)\/)/.test(command)) return 'node test';
  return undefined;
}

// ciRerunErrors는 make check를 실행하는 workflow가 make check 밖에서 test runner를 실행하는 곳마다 오류
// 하나를 돌려준다. make check는 모든 Go package, Rust crate, PHP와 TypeScript test를 한 번씩 실행하므로
// (go-test-check, client-db-check, feature-check와 다른 target) 그런 step은 그 일부를 다시 실행하거나,
// make check에 없는 check를 make check 밖에 둔다. 명령 text가 아니라 runner의 정체로 판단하고, step이
// 실행하는 make target(CHECK_TARGETS 밖)의 recipe도 변수를 풀어 같은 방식으로 본다.
export function ciRerunErrors(workflow, makefile) {
  const steps = workflowSteps(workflow);
  if (!steps.some(checkStep)) return [];
  const targets = new Set(checkTargets(makefile));
  const variables = makeVariables(makefile);
  const errors = [];
  const report = (step, identity, via) => errors.push(`ci.yml step "${step.name}" runs ${identity}${via} outside make check; make check runs every test once, and a check it lacks belongs in a target of CHECK_TARGETS`);
  for (const step of steps) {
    // CI setup step(scripts/check/ci-setup.mjs)은 도구를 설치하고 그 환경을 확인할 뿐 test를 실행하지 않는다.
    if (Object.hasOwn(CI_SETUP, step.id ?? '')) continue;
    for (const segment of step.run.split('\n').flatMap(segments)) {
      if (runsCheck(segment)) continue;
      const identity = runnerIdentity(segment);
      if (identity) { report(step, identity, ''); continue; }
      const make = /^make\s+(.*)$/.exec(segment)?.[1];
      if (!make) continue;
      for (const target of make.split(/\s+/).filter(word => /^[a-z0-9-]+$/.test(word) && word !== 'check' && !targets.has(word))) {
        for (const line of recipe(makefile, target) ?? [])
          for (const part of segments(expand(line, variables))) {
            const inner = runnerIdentity(part);
            if (inner) report(step, inner, ` through make ${target}`);
          }
      }
    }
  }
  return errors;
}

// LEASE_READ는 program이 lease 변수(LEASE, make가 export한다)를 환경에서 읽는 형태다: Go의 os.Getenv,
// Node의 process.env, shell의 $LEASE.
const LEASE_READ = /Getenv\("LEASE"\)|process\.env\.LEASE\b|\bLEASE\s*:\s*\w+[^\n]*\}\s*=\s*process\.env|\$\{?LEASE\b/;

// leaseProgram은 명령 조각이 실행하는 repository program의 source file을 돌려준다: `node tests/go-run.mjs
// <name> <package>`와 `go run <package>`는 그 package의 Go file(test 제외), `node <file>`과 `sh <file>`,
// `./<file>`은 그 file이다. repository program이 아니면 빈 목록이다.
function leaseProgram(segment, tracked) {
  const command = segment.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  const goPackage = /^node\s+tests\/go-run\.mjs\s+\S+\s+(\S+)/.exec(command)?.[1] ?? /^go\s+run\s+(\.\/\S+)/.exec(command)?.[1];
  if (goPackage) {
    const directory = goPackage.replace(/^\.\//, '').replace(/\/$/, '');
    return { name: goPackage, files: tracked.filter(path => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/') && path.endsWith('.go') && !path.endsWith('_test.go')) };
  }
  const file = /^node\s+(?:-\S+\s+)*([\w./-]+\.m?js)\b/.exec(command)?.[1]
    ?? /^(?:sh|bash)\s+(?:-\S+\s+)*([\w./-]+)/.exec(command)?.[1]
    ?? /^(\.\/[\w./-]+)/.exec(command)?.[1];
  if (!file) return { name: '', files: [] };
  const path = file.replace(/^\.\//, '');
  return { name: file, files: tracked.includes(path) ? [path] : [] };
}

// ciLeaseErrors는 workflow의 step이 lease 변수를 읽는 repository program을 make 밖에서 실행하는 곳마다 오류
// 하나를 돌려준다. 그런 program(예: Rust 추출기를 공유 target directory의 lease 아래에서 build하는
// tests/interfaces/check)은 make가 export하는 LEASE와 lease directory 없이 실패하므로, CI도 make check처럼
// 그것을 make target으로 실행한다. workflows는 {path: text}, tracked는 추적하는 file, read는 file의 내용을
// 돌려주는 함수다.
export function ciLeaseErrors(workflows, tracked, read) {
  const errors = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const step of workflowSteps(workflow)) {
      for (const segment of step.run.split('\n').flatMap(segments)) {
        const { name, files } = leaseProgram(segment, tracked);
        const reading = files.find(file => LEASE_READ.test(read(file) ?? ''));
        if (reading)
          errors.push(`${path} step "${step.name}" runs ${name} outside make; ${reading} reads LEASE, which make exports, so the step runs it through a make target`);
      }
    }
  }
  return errors;
}

// AFTER_CHECK은 make check 뒤에 오는 step이다. 전체 suite는 push 뒤 CI에서 실행되고 실패에서 멈추지 않으므로, 그
// 뒤에는 검사가 아니라 그 실행의 정보를 남기는 두 step만 온다: runner가 끝나지 않았어도 summary를 job summary와
// 보고서에 쓰는 summary, 그리고 그 실행 id의 보고서 directory만 올리는 report다. 둘 다 `if: ${{ !cancelled() }}`다.
// AFTER_GROUP_CHECK은 CI group job의 같은 두 step이다: 실행 id, artifact 이름과 보고서 directory가 matrix의 group을 가지므로
// group들의 보고서가 서로 겹치지 않는다.
export const RUN_ID = 'ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}';
export const GROUP_RUN_ID = 'ORM_CHECK_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.group }}';
export const AFTER_CHECK = [
  ['- name: summary', 'if: ${{ !cancelled() }}', 'env:', RUN_ID, 'run: node scripts/check/summary.mjs'],
  ['- name: report', 'if: ${{ !cancelled() }}', 'uses: actions/upload-artifact@v4', 'with:', 'name: check-${{ github.run_id }}-${{ github.run_attempt }}',
    'path: .runtime/check/ci_${{ github.run_id }}_${{ github.run_attempt }}/report/', 'if-no-files-found: error'],
];
export const AFTER_GROUP_CHECK = [
  ['- name: summary', 'if: ${{ !cancelled() }}', 'env:', GROUP_RUN_ID, 'run: node scripts/check/summary.mjs'],
  ['- name: report', 'if: ${{ !cancelled() }}', 'uses: actions/upload-artifact@v4', 'with:', 'name: check-${{ matrix.group }}-${{ github.run_id }}-${{ github.run_attempt }}',
    'path: .runtime/check/ci_${{ github.run_id }}_${{ github.run_attempt }}_${{ matrix.group }}/report/', 'if-no-files-found: error'],
];

// stepText는 workflow의 step마다 주석과 빈 줄을 뺀 줄을 앞뒤 공백 없이 돌려준다.
function stepTexts(workflow) {
  const out = [];
  let inSteps = false;
  let indent = null;
  for (const line of workflow.split('\n')) {
    if (/^\s*steps:\s*$/.test(line)) { inSteps = true; indent = null; continue; }
    if (!inSteps || line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = line.match(/^(\s*)- /);
    if (item && (indent === null || item[1].length === indent)) {
      indent = item[1].length;
      out.push([line.trim()]);
    } else if (out.length && line.match(/^\s*/)[0].length > indent) out.at(-1).push(line.trim());
  }
  return out;
}

// ciAfterCheckErrors는 make check를 실행하는 workflow의 job마다 make check step이 ORM_CHECK_RUN_ID를 주지 않거나, 그 뒤의
// step이 AFTER_CHECK의 summary와 report와 정확히 같지 않은 곳마다 오류 하나를 돌려준다. 검사는 모두 make check의
// target에 있고(CHECK_TARGETS), 그 뒤의 step은 그 실행의 summary와 보고서만 남긴다.
export function ciAfterCheckErrors(workflows) {
  const errors = [];
  for (const [path, whole] of Object.entries(workflows)) for (const [, workflow] of workflowJobs(whole)) {
    const steps = workflowSteps(workflow);
    const check = steps.findIndex(checkStep);
    if (check === -1) continue;
    const grouped = groupStep(steps[check]);
    const declared = grouped ? AFTER_GROUP_CHECK : AFTER_CHECK;
    const runId = grouped ? GROUP_RUN_ID : RUN_ID;
    const texts = stepTexts(workflow);
    if (!texts[check].includes(runId))
      errors.push(`${path} step "${steps[check].name}" gives make check no ${runId}, which names the report of the run`);
    const after = texts.slice(check + 1);
    for (const [index, step] of after.entries()) {
      const want = declared[index];
      if (want && step.join('\n') === want.join('\n')) continue;
      const name = steps[check + 1 + index].name;
      errors.push(want
        ? `${path} step "${name}" after make check is not the declared ${want[0].slice('- name: '.length)} step: ${step.join(' | ')} instead of ${want.join(' | ')}`
        : `${path} step "${name}" runs ${steps[check + 1 + index].run.split('\n')[0] || step[0]} after make check; make check runs every check, and only the summary and the report upload follow it, so a check it lacks belongs in a target of CHECK_TARGETS`);
    }
    for (const want of declared.slice(after.length))
      errors.push(`${path} has no ${want[0].slice('- name: '.length)} step after make check: ${want.join(' | ')}`);
  }
  return errors;
}

// FULL_SUITE_RULE은 AGENTS.md와 AGENTS.ko.md가 적어야 하는 전체 suite의 규칙이다: 전체 suite는 push 뒤 CI에서
// 실행되고, CI 실행 한 번은 다음 실행 전에 모든 실패를 고칠 정보를 모으며, push 전에 필요한 로컬 검사는 없다. 이전 규칙(활성 항목이 모두 완료되었을 때 로컬에서 한 번 실행한다)은 남지 않는다.
export const FULL_SUITE_RULE = {
  'AGENTS.md': {
    required: ['runs on GitHub CI after a push', 'collect enough information to fix every failure it found before the next CI run', 'no local check is required', 'do not push again to react to it'],
    removed: ['runs exactly once, when every active checklist\n  item is complete', 'then run `make check` once'],
  },
  'AGENTS.ko.md': {
    required: ['push 뒤 GitHub CI에서 실행한다', '모든 실패를 고칠 수 있을 만큼의 정보를 모아야 한다', 'push 전에 필요한 로컬 검사는 없다', '다시 push하지 않는다'],
    removed: ['완료되었을 때 정확히 한 번\n  실행한다', '`make check`를 한 번 실행한다'],
  },
};

// fullSuiteRuleErrors는 documents({path: text})가 FULL_SUITE_RULE의 문장을 적지 않거나 이전 규칙을 적는 곳마다
// 오류 하나를 돌려준다.
export function fullSuiteRuleErrors(documents) {
  const errors = [];
  for (const [path, { required, removed }] of Object.entries(FULL_SUITE_RULE)) {
    const text = documents[path] ?? '';
    for (const phrase of required) if (!text.includes(phrase)) errors.push(`${path} does not state the full-suite rule: "${phrase}"`);
    for (const phrase of removed) if (text.includes(phrase)) errors.push(`${path} still states the local full-suite rule: "${phrase.replaceAll('\n', ' ')}"`);
  }
  return errors;
}

// ciSetupErrors는 workflow의 setup step이 실패해도 그 뒤의 step이 실행되고 그 실패가 기록되지 않는 곳마다 오류 하나를
// 돌려준다. make check를 실행하는 job에서 make check 앞의 step은 모두 id를 가지고, 그 id는 runner가 필요로 하는
// step(RUNNER_STEPS)이거나 scripts/check/ci-setup.mjs의 CI_SETUP이 그 step이 마련하는 것을 적은 step이다. 표의 step은
// 모두 workflow에 있다. 첫 step 뒤의 step과 make check는 `if: ${{ !cancelled() }}`로 앞의 step이 실패해도 실행되고,
// make check는 step 결과를 ORM_CI_SETUP: ${{ toJSON(steps) }}로, git-check가 읽는 commit 범위를 pull request와 merge
// group의 ORM_GIT_RANGE로 받는다. 다른 job의 `run:` step도 같은 job의 앞 step이
// 실패해도 실행되는 조건(`if: ${{ !cancelled()`로 시작)을 가진다. continue-on-error는 실패를 job에서 지우므로 어디에도
// 없다.
// GROUP_NEEDS는 CI group job의 step group-needs가 실행하는 줄이다.
export const GROUP_NEEDS = 'make --no-print-directory ci-group-needs GROUP=${{ matrix.group }} >> "$GITHUB_OUTPUT"';

export function ciSetupErrors(workflows, { setup, runner }) {
  const errors = [];
  for (const [path, whole] of Object.entries(workflows)) {
    if (/^\s*continue-on-error:/m.test(whole)) errors.push(`${path} uses continue-on-error, which hides a failed step from the job; run later steps with if: \${{ !cancelled() }} instead`);
    for (const [, workflow] of workflowJobs(whole)) {
      const steps = workflowSteps(workflow);
      const texts = stepTexts(workflow);
      const check = steps.findIndex(checkStep);
      const guarded = index => texts[index].some(line => /^if: \$\{\{ !cancelled\(\)/.test(line));
      if (check === -1) {
        for (const [index, step] of steps.entries())
          if (index > 0 && step.run && !guarded(index)) errors.push(`${path} step "${step.name}" does not run after a failed earlier step; give it if: \${{ !cancelled() ... }}`);
        continue;
      }
      for (const [index, step] of steps.slice(0, check).entries()) {
        if (!step.id) errors.push(`${path} step "${step.name}" before make check has no id; give it the id of what it installs in scripts/check/ci-setup.mjs`);
        else if (!runner.includes(step.id) && !Object.hasOwn(setup, step.id)) errors.push(`${path} step "${step.name}" has the id ${step.id}, which scripts/check/ci-setup.mjs does not map to what it installs`);
        if (index > 0 && !guarded(index)) errors.push(`${path} step "${step.name}" does not run after a failed earlier setup step; give it if: \${{ !cancelled() }}`);
      }
      // CI group의 job에서 setup step은 그 group이 필요로 할 때만 실행한다: 조건은 scripts/check/ci-setup.mjs의
      // stepCondition이고, group-needs step이 make ci-group-needs의 output을 $GITHUB_OUTPUT에 쓴다.
      if (groupStep(steps[check])) {
        for (const [index, step] of steps.slice(0, check).entries()) {
          if (!Object.hasOwn(setup, step.id ?? '')) continue;
          const want = `if: ${stepCondition(step.id)}`;
          const have = texts[index].find(line => line.startsWith('if:'));
          if (have !== want) errors.push(`${path} step "${step.name}" of the CI group job runs under ${have ?? 'no if:'} instead of ${want}, the condition that scripts/check/ci-setup.mjs declares for the step ${step.id}`);
        }
        const needs = steps.slice(0, check).find(step => step.id === 'group-needs');
        if (needs && needs.run !== GROUP_NEEDS) errors.push(`${path} step "${needs.name}" runs ${needs.run} instead of ${GROUP_NEEDS}, which writes the setup of the CI group as step outputs`);
      }
      const ids = new Set(steps.slice(0, check).map(step => step.id));
      for (const id of [...runner, ...Object.keys(setup)]) if (!ids.has(id)) errors.push(`${path} has no setup step with the id ${id} of scripts/check/ci-setup.mjs`);
      if (!guarded(check)) errors.push(`${path} step "${steps[check].name}" does not run after a failed setup step; give it if: \${{ !cancelled() }}`);
      if (!texts[check].includes('ORM_CI_SETUP: ${{ toJSON(steps) }}')) errors.push(`${path} step "${steps[check].name}" gives make check no ORM_CI_SETUP: \${{ toJSON(steps) }}, which tells the runner the failed setup steps`);
      if (!texts[check].some(line => /^ORM_GIT_RANGE: \$\{\{ .*github\.event\.pull_request\.base\.sha.*github\.event\.merge_group\.base_sha.* \}\}$/.test(line))) errors.push(`${path} step "${steps[check].name}" gives make check no ORM_GIT_RANGE of the pull request and the merge group, the commits whose subjects git-check reads`);
    }
  }
  return errors;
}


// independentTestErrors는 make recipe 하나가 서로 다른 test 실행 줄을 둘 이상 가지는 곳마다 오류 하나를 돌려준다. recipe의
// 줄은 첫 실패에서 멈추므로(make -k도 recipe 안에서는 멈춘다), 앞의 test가 실패하면 뒤의 test는 실행되지 않고 그
// 결과도 남지 않는다. 독립된 test는 make -k가 서로의 실패 뒤에도 실행하는 하위 target(`<target>/<part>`)으로
// 나눈다. 같은 test를 다시 실행하는 줄(결과가 반복되는지 보는 두 번째 실행)은 한 test로 센다. test 실행은
// runnerIdentity로 판단하고, make 변수는 정의로 풀어 본다.
export function independentTestErrors(makefile) {
  const variables = makeVariables(makefile);
  const recipes = [];
  for (const line of makefile.split('\n')) {
    const target = /^([A-Za-z0-9_./-]+):(?!=)/.exec(line);
    if (target) recipes.push({ target: target[1], commands: [] });
    else if (line.startsWith('\t') && recipes.length) recipes.at(-1).commands.push(line.slice(1));
    else if (line.trim() !== '' && !line.startsWith('#')) recipes.push({ target: null, commands: [] });
  }
  const errors = [];
  for (const { target, commands } of recipes) {
    if (!target) continue;
    const tests = new Set(commands.filter(command => checkLine(expand(command, variables))));
    if (tests.size >= 2)
      errors.push(`Makefile ${target} runs ${tests.size} independent tests in one recipe, whose first failure stops the others; split them into parts ${target}/<part>: ${[...tests].map(test => test.slice(0, 80)).join(' | ')}`);
  }
  return errors;
}

// testRun은 명령 조각이 test나 lint 검사를 실행하는지다: runnerIdentity가 test runner로 보는 것 가운데, 실행하지 않고 compile만
// 하는 것(go test -c, cargo test --no-run), 출력을 file로 보내는 입력 생성(`> file`), 의존성의 도구(node_modules의
// tsc 같은 build)는 test 실행이 아니다.
// checkLine은 명령 줄이 test나 lint 검사를 실행하는지다. tests/cargo-test.mjs는 cargo test를 실행한다. make 함수와 shell
// 치환(`$(abspath ...)`, `$(shell ...)`)은 값 하나로 줄인 뒤 조각마다 testRun으로 본다.
function checkLine(line) {
  if (/tests\/cargo-test\.mjs/.test(line) && !/\s--no-run\b/.test(line)) return true;
  return segments(reduceMake(line)).some(segment => testRun(segment.trim()));
}

// reduceMake은 `$(` 로 시작하는 make 함수와 shell 치환을 짝이 맞는 `)`까지 값 하나(VALUE)로 바꾼다. 안의 괄호도 센다.
function reduceMake(text) {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '$' && text[index + 1] === '(') {
      let depth = 0;
      let end = index + 1;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')' && --depth === 0) break;
      }
      out += 'VALUE';
      index = end;
    } else out += text[index];
  }
  return out;
}

function testRun(segment) {
  // 앞의 환경 변수 대입은 뗀다.
  const command = segment.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S)*\s+)+/, '');
  // lint(clippy, go vet, rustfmt와 gofmt의 검사)도 실패하면 뒤의 줄을 멈추는 검사다.
  if (/(?:^|\s)cargo\s+(?:\+\S+\s+)?clippy\b|(?:^|\s)go\s+vet\b|(?:^|\s)cargo\s+(?:\+\S+\s+)?fmt\b.*--check|(?:^|\s)gofmt\s+-l\b/.test(command)) return true;
  const identity = runnerIdentity(command);
  if (!identity) return false;
  if (/\s-c(?:\s|$)|\s--no-run\b|(?:^|\s)>\s*\S|node_modules\//.test(command)) return false;
  return true;
}

// chainedCommandErrors는 contracts/features.json의 검증 명령과 helper 명령이 `&&`로 test 실행 둘 이상을 잇는 곳마다
// 오류 하나를 돌려준다. 앞의 test가 실패하면 뒤의 test는 실행되지 않는다. 각 test는 자기 명령이 된다.
export function chainedCommandErrors(features) {
  const errors = [];
  const check = (where, command) => {
    const tests = command.split('&&').filter(part => checkLine(part.trim()));
    if (tests.length >= 2) errors.push(`contracts/features.json ${where} chains ${tests.length} tests with &&, so the first failure stops the next; declare each as its own command: ${command.slice(0, 160)}`);
  };
  for (const feature of features.features ?? []) for (const verification of feature.verification ?? []) check(`${feature.id}/${verification.id}`, verification.command);
  for (const helper of features.helpers ?? []) check(`helper ${helper.id}`, helper.command);
  return errors;
}

// CI_RUN_EXCEPTIONS는 make target이 아닌 명령을 실행해도 되는 step이다: summary는 make check가 끝나지 않았어도 실행되어
// 그 실행의 summary를 쓰므로 make를 거치지 않는다.
export const CI_RUN_EXCEPTIONS = { '.github/workflows/ci.yml': { summary: 'node scripts/check/summary.mjs' } };

// ciMakeErrors는 workflow의 step이 make target이 아닌 명령을 실행하는 곳마다 오류 하나를 돌려준다. 모든 step은
// 로컬과 같은 make target을 실행하므로, CI만 아는 명령이 없다. workflows는 {path: text}다.
export function ciMakeErrors(workflows) {
  const errors = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const step of workflowSteps(workflow)) {
      if (!step.run) continue;
      if (CI_RUN_EXCEPTIONS[path]?.[step.name] === step.run) continue;
      for (const line of step.run.split('\n').map(line => line.trim()).filter(Boolean))
        if (!/^make(\s|$)/.test(line)) errors.push(`${path} step "${step.name}" runs ${line}; run it through a make target`);
    }
  }
  return errors;
}

// WORKFLOW_TRIGGERS는 workflow마다 그 `on:` block이다. ci.yml은 모든 검사 job을 pull request, merge group과 수동 실행에서,
// push-gate.yml은 push gate를 push(merge queue의 임시 branch 제외), pull request와 merge group에서 실행하고,
// docs-pages.yml은 main의 push와 수동 실행에서 공개 site를 build하고 deploy하며, release.yml은 version tag(`vX.Y.Z`,
// `<dir>/vX.Y.Z`)의 push에서 GitHub Release를 만든다. 다른 workflow는 push, pull_request, merge_group으로 실행하지 않는다.
export const WORKFLOW_TRIGGERS = {
  '.github/workflows/ci.yml': ['on:', '  pull_request:', '  merge_group:', '  workflow_dispatch:'],
  '.github/workflows/push-gate.yml': ['on:', '  push:', "    branches-ignore: ['gh-readonly-queue/**']", '  pull_request:', '  merge_group:'],
  '.github/workflows/docs-pages.yml': ['on:', '  push:', '    branches: [main]', '  workflow_dispatch:'],
  '.github/workflows/release.yml': ['on:', '  push:', "    tags: ['v*', '**/v*']"],
};

// onBlock은 workflow의 `on:` 줄부터 다음 최상위 key 앞까지의 줄을 끝의 빈 줄과 주석 없이 돌려준다.
export function onBlock(workflow) {
  const lines = workflow.split('\n');
  const start = lines.findIndex(line => /^on:/.test(line));
  if (start === -1) return [];
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block.filter(line => line.trim() !== '' && !line.trim().startsWith('#')).map(line => line.trimEnd());
}

// workflowTriggerErrors는 WORKFLOW_TRIGGERS의 workflow가 없거나 그 `on:` block이 다른 곳, 그리고 다른 workflow가 push,
// pull_request나 merge_group으로 실행하는 곳마다 오류 하나를 돌려준다. workflows는 {path: text}다.
export function workflowTriggerErrors(workflows) {
  const errors = [];
  for (const [path, want] of Object.entries(WORKFLOW_TRIGGERS)) {
    if (!Object.hasOwn(workflows, path)) { errors.push(`${path} is missing; it runs on ${want.slice(1).map(line => line.trim()).join(' ')}`); continue; }
    const have = onBlock(workflows[path]);
    if (have.join('\n') !== want.join('\n')) errors.push(`${path} has the triggers ${have.map(line => line.trim()).join(' ')} instead of ${want.map(line => line.trim()).join(' ')}`);
  }
  for (const [path, workflow] of Object.entries(workflows)) {
    if (Object.hasOwn(WORKFLOW_TRIGGERS, path)) continue;
    const events = onBlock(workflow).join('\n').match(/\b(?:push|pull_request|merge_group)\b/g) ?? [];
    if (events.length) errors.push(`${path} runs on ${[...new Set(events)].join(', ')}; only ci.yml, push-gate.yml, docs-pages.yml and release.yml run on these events`);
  }
  return errors;
}

// CONCURRENCY는 push로 실행하는 workflow가 선언하는 concurrency다. 같은 ref의 새 push는 앞 push의 실행을 끝낸다:
// runner는 적고, 의미 있는 것은 가장 새 head의 실행이다.
const CONCURRENCY = ['concurrency:', '  group: ${{ github.workflow }}-${{ github.ref }}', '  cancel-in-progress: true'];

// concurrencyErrors는 push로 실행하면서 그 concurrency를 workflow 수준에서 선언하지 않는 workflow마다 오류 하나를
// 돌려준다. workflows는 {path: text}다.
export function concurrencyErrors(workflows) {
  const errors = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    const on = /^on:\s*\n((?:[ \t].*\n|\s*\n)*)/m.exec(workflow)?.[1] ?? /^on:\s*(.*)$/m.exec(workflow)?.[1] ?? '';
    if (!/\bpush\b/.test(on)) continue;
    if (!workflow.split('\n').join('\n').includes(CONCURRENCY.join('\n')))
      errors.push(`${path} runs on push without the workflow-level concurrency group \${{ github.workflow }}-\${{ github.ref }} with cancel-in-progress: true, so a superseded run keeps a runner`);
  }
  return errors;
}

// CI_PASSED_STEPS는 ci.yml의 마지막 job ci-passed의 step이다. ruleset이 요구하는 ci.yml의 check는 이 job 하나다: `if: always()`로
// 다른 job이 실패하거나 취소되어도 실행되고, needs가 다른 모든 job이므로 그 모든 job이 success일 때만 make ci-passed가
// 통과한다. make ci-passed는 저장소의 Makefile과 scripts/check/ci-passed.mjs를 node로 실행하므로, 그 앞에 checkout과
// .node-version의 node 설치가 있다.
export const CI_PASSED_STEP = ['- name: every job passed', 'if: ${{ !cancelled() }}', 'env:', 'CI_NEEDS: ${{ toJSON(needs) }}', 'run: make ci-passed'];
export const CI_PASSED_STEPS = [
  ['- uses: actions/checkout@v5'],
  ['- uses: actions/setup-node@v7', 'with:', 'node-version-file: .node-version'],
  CI_PASSED_STEP,
];

// ciPassedErrors는 ci.yml에 job ci-passed가 없거나, 마지막 job이 아니거나, `if: ${{ always() }}`가 아니거나, needs가 다른 모든
// job과 같지 않거나, step이 CI_PASSED_STEPS가 아닌 곳마다 오류 하나를 돌려준다.
export function ciPassedErrors(workflow) {
  const jobs = workflowJobs(workflow);
  const ids = jobs.map(([id]) => id);
  const at = ids.indexOf('ci-passed');
  if (at === -1) return ['ci.yml has no job ci-passed, the check that the ruleset requires; add it as the last job with if: ${{ always() }} and needs: every other job'];
  const errors = [];
  if (at !== ids.length - 1) errors.push(`ci.yml job ci-passed is not the last job; move it after ${ids.at(-1)}`);
  const job = jobs[at][1];
  if (!/^ {4}if: \$\{\{ always\(\) \}\}$/m.test(job)) errors.push('ci.yml job ci-passed does not run with if: ${{ always() }}, so a failed or cancelled job skips it instead of failing it');
  const needs = /^ {4}needs: \[(.*)\]$/m.exec(job)?.[1].split(',').map(item => item.trim()).filter(Boolean) ?? [];
  const others = ids.filter(id => id !== 'ci-passed');
  for (const id of others) if (!needs.includes(id)) errors.push(`ci.yml job ci-passed does not need the job ${id}; list every other job under needs`);
  for (const id of needs) if (!others.includes(id)) errors.push(`ci.yml job ci-passed needs ${id}, which is no other job of ci.yml`);
  const steps = stepTexts(job);
  const text = steps => steps.map(step => step.join(' | ')).join(' || ');
  if (text(steps) !== text(CI_PASSED_STEPS))
    errors.push(`ci.yml job ci-passed has the steps ${text(steps)} instead of ${text(CI_PASSED_STEPS)}`);
  return errors;
}
