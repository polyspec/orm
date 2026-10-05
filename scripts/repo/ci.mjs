import { segments } from './testcases.mjs';

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
const runsMake = run => /^make\s/m.test(run) && !startsServers(run);

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
    steps.slice(0, server).filter(step => runsMake(step.run)).forEach(step =>
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

// ciCheckTargetErrors는 CI workflow가 make check의 target(CHECK_TARGETS)을 빠뜨리거나 두 번
// 실행하는 곳마다 오류 하나를 돌려준다. step의 run text에서 줄 머리의 `make`가 실행하는 target을
// 읽는다. `make check`는 모든 CHECK_TARGETS를 make check의 runner(scripts/check/run.mjs)로 실행하므로
// 그 target을 따로 실행하면 두 번 실행한다. `make check`가 없으면 각 target이 어느 step에 있어야 한다.
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
    return targets.filter(target => ran.has(target)).map(target =>
      `ci.yml step "${ran.get(target)}" runs ${target}, which make check runs`);
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
  if (!steps.some(step => step.run.split('\n').flatMap(segments).some(segment => /^make\s+check\s*$/.test(segment)))) return [];
  const targets = new Set(checkTargets(makefile));
  const variables = makeVariables(makefile);
  const errors = [];
  const report = (step, identity, via) => errors.push(`ci.yml step "${step.name}" runs ${identity}${via} outside make check; make check runs every test once, and a check it lacks belongs in a target of CHECK_TARGETS`);
  for (const step of steps) {
    for (const segment of step.run.split('\n').flatMap(segments)) {
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

// ciAfterCheckErrors는 make check를 실행하는 workflow에서 그 step 뒤에 명령을 실행하는 step마다 오류 하나를
// 돌려준다. make check가 모든 검사를 실행하므로 로컬 실행 한 번이 CI가 실행하는 것을 모두 다룬다: CI는 준비
// (checkout, 설치, server 시작) 뒤에 make check 하나만 실행하고, make check에 없는 검사는 CHECK_TARGETS의
// target에 둔다.
export function ciAfterCheckErrors(workflows) {
  const errors = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    const steps = workflowSteps(workflow);
    const check = steps.findIndex(step => step.run.split('\n').flatMap(segments).some(segment => /^make\s+check\s*$/.test(segment)));
    if (check === -1) continue;
    for (const step of steps.slice(check + 1))
      if (step.run.trim())
        errors.push(`${path} step "${step.name}" runs ${step.run.split('\n')[0]} after make check; make check runs every check, so one local run covers CI, and a check it lacks belongs in a target of CHECK_TARGETS`);
  }
  return errors;
}
