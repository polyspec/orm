// 개발 Node version 검사. 검사와 build를 실행하는 Node는 `.node-version`이 한 번 선언한 version
// 하나이고, 로컬 검사와 모든 workflow가 그 version으로 실행한다. package.json의 engines.node
// (">=x.y.z")는 TypeScript client가 지원하는 최저 version이며 make ts-min-check가 실행한다.

import { workflowSteps } from './ci.mjs';

// setupNodeSteps는 workflow에서 actions/setup-node를 쓰는 step마다 그 step의 줄을 돌려준다.
function setupNodeSteps(workflow) {
  const lines = workflow.split('\n');
  const steps = [];
  for (let index = 0; index < lines.length; index++) {
    const item = lines[index].match(/^(\s*)- uses:\s*actions\/setup-node@/);
    if (!item) continue;
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

const version = text => /^(\d+)\.(\d+)\.(\d+)$/.exec(text)?.slice(1).map(Number);
// compare는 두 version의 major, minor, patch를 차례로 비교한다.
const compare = (a, b) => a.map((part, index) => part - b[index]).find(difference => difference !== 0) ?? 0;

// nodeVersionErrors는 Node version 선언이 하나가 아니거나 실행 중인 Node와 다른 곳마다 오류
// 하나를 돌려준다.
//   - declared(`.node-version`의 내용)는 정확한 x.y.z 하나다.
//   - minimum(package.json engines.node의 ">=x.y.z")은 declared보다 높지 않다.
//   - workflows({path: text})의 actions/setup-node step은 `node-version-file: .node-version`으로
//     version을 읽고 `node-version`을 직접 적지 않는다. Node를 쓰는 workflow는 setup-node를 쓴다.
//   - running(process.versions.node)은 declared와 같다.
export function nodeVersionErrors(declared, minimum, workflows, running) {
  const errors = [];
  const exact = version(declared.trim());
  if (declared !== `${declared.trim()}\n` || !exact)
    errors.push(`.node-version must hold one exact version x.y.z and a newline, found ${JSON.stringify(declared)}`);
  const lowest = version(/^>=(\d+\.\d+\.\d+)$/.exec(minimum ?? '')?.[1] ?? '');
  if (!lowest) errors.push(`package.json engines.node must be ">=x.y.z", found ${JSON.stringify(minimum)}`);
  if (exact && lowest && compare(exact, lowest) < 0)
    errors.push(`.node-version ${declared.trim()} is below package.json engines.node ${minimum}`);
  for (const [path, workflow] of Object.entries(workflows)) {
    const steps = setupNodeSteps(workflow);
    const usesNode = workflowSteps(workflow).some(step => /(^|[\s;&|(])(node|npm|npx)\s/m.test(step.run));
    if (usesNode && steps.length === 0) errors.push(`${path} runs Node without actions/setup-node`);
    for (const step of steps) {
      if (/^\s*node-version:/m.test(step)) errors.push(`${path} declares node-version itself; .node-version declares it`);
      if (!/^\s*node-version-file:\s*["']?\.node-version["']?\s*$/m.test(step))
        errors.push(`${path} does not read node-version-file .node-version in actions/setup-node`);
    }
  }
  if (exact && running !== declared.trim())
    errors.push(`Node ${running} runs the checks; .node-version declares ${declared.trim()}`);
  return errors;
}
