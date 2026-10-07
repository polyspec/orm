// 개발 Node version 검사. 검사와 build를 실행하는 Node는 `.node-version`이 한 번 선언한 version
// 하나이고, 로컬 검사와 모든 workflow가 그 version으로 실행한다. package.json의 engines.node
// (">=x.y.z")는 TypeScript client가 지원하는 최저 version이며 make ts-min-check가 실행한다.

import { actionSteps, workflowSteps } from './ci.mjs';

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
    const steps = actionSteps(workflow, 'actions/setup-node');
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

// npm의 git source 검사. polyspec package는 GitHub tag의 release archive URL로 받고, npm은 git으로
// 받는 package가 없어야 git을 쓸 수 없는 `npm ci`에서도 설치한다.
const GIT_SOURCE = /^(?:git\+|git:|ssh:|github:)/;
// GITHUB_SHORTHAND는 npm이 GitHub 저장소로 읽는 `owner/repo` 또는 `owner/repo#ref` spec이다.
const GITHUB_SHORTHAND = /^[^@\s/:.][^\s/:]*\/[^\s/:]+$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// npmGitSourceErrors는 files({path: text}, 추적된 package.json과 package-lock.json)에서 git으로 받는
// dependency마다 오류 하나를 돌려준다.
//   - package.json의 dependency spec은 `git+`, `git:`, `ssh:`, `github:`로 시작하지 않고 GitHub
//     shorthand(`owner/repo#ref`)가 아니다.
//   - package-lock.json의 모든 `resolved`는 `git+`, `git:`, `ssh:`, `github:`로 시작하지 않는다.
export function npmGitSourceErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    const data = JSON.parse(text);
    if (/(?:^|\/)package\.json$/.test(path)) {
      for (const field of DEPENDENCY_FIELDS)
        for (const [name, spec] of Object.entries(data[field] ?? {}))
          if (GIT_SOURCE.test(spec) || GITHUB_SHORTHAND.test(spec))
            errors.push(`${path} ${field} ${name} is ${spec}, a git source; use the release archive URL of the GitHub tag`);
    } else if (/(?:^|\/)package-lock\.json$/.test(path)) {
      for (const [entry, record] of Object.entries(data.packages ?? {}))
        if (typeof record.resolved === 'string' && GIT_SOURCE.test(record.resolved))
          errors.push(`${path} resolves ${entry} from ${record.resolved}, a git source; use the release archive URL of the GitHub tag`);
    }
  }
  return errors;
}
