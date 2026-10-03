// CI workflow의 database 서버 검사. make check의 database 검사는 make test-servers
// (scripts/test-servers.sh)가 쓴 .runtime/servers/env의 변수를 읽으므로, workflow는 같은 정의로
// 서버를 시작하고 그 모든 변수를 검사 단계에 준다.

// serverVariables는 scripts/test-servers.sh가 환경 file에 쓰는 변수 이름을 돌려준다.
export function serverVariables(serversScript) {
  return [...new Set([...serversScript.matchAll(/export ([A-Z][A-Z0-9_]*)=/g)].map(match => match[1]))];
}

// workflowSteps는 workflow의 step마다 이름과 run text를 돌려준다. step은 `steps:` 아래 한 단계
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
    const start = stepLines.findIndex(line => /^\s*run:/.test(line));
    if (start === -1) return { name, run: '' };
    const runIndent = stepLines[start].match(/^\s*/)[0].length;
    const inline = stepLines[start].replace(/^\s*run:\s*/, '');
    const block = [];
    for (const line of stepLines.slice(start + 1)) {
      if (line.trim() !== '' && line.match(/^\s*/)[0].length <= runIndent) break;
      block.push(line.trim());
    }
    return { name, run: /^[|>][-+]?$/.test(inline) ? block.join('\n').trim() : inline };
  });
}

// repository의 make target은 run text의 줄 머리에서 실행한다. 다른 directory에서 build하는
// make(예: `(cd /tmp/sqlite && make)`)는 검사가 아니다.
const startsServers = run => /^make test-servers\s*$/m.test(run);
const runsMake = run => /^make\s/m.test(run) && !startsServers(run);
const exportsServers = run => run.includes('.runtime/servers/env') && run.includes('GITHUB_ENV');

// ciServerErrors는 workflow가 database 검사의 서버와 변수를 test-servers.sh와 같은 정의로 주지
// 않거나 symbolic link를 만드는 곳마다 오류 하나를 돌려준다.
//   - make test-servers를 실행하는 step이 없으면 workflow가 적지 않은 각 변수가 오류다.
//   - make를 실행하는 다른 step이 그 step보다 앞서면 오류다.
//   - 그 뒤 .runtime/servers/env를 $GITHUB_ENV에 더하는 step이 다음 step이 아니면 오류다: make를
//     거치지 않는 검사(go test, cargo test, php)도 같은 변수를 process 환경에서 읽는다.
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
    if (!exportsServers(steps[server + 1]?.run ?? ''))
      errors.push('ci.yml does not add .runtime/servers/env to $GITHUB_ENV in the step after make test-servers');
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
