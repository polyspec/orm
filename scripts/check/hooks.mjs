// hooks는 checkout에 pre-push hook이 설치되었는지 읽는다. git은 core.hooksPath가 `.githooks`일 때만 추적하는
// hook `.githooks/pre-push`를 push마다 실행한다. 그 설정은 clone마다 따로 있으므로 make가 parse 때 그것을
// 둔다(Makefile). push gate(scripts/check/push-gate.mjs hooks-check)와 전체 suite의 guard(full-run.mjs)가 이것을 쓴다.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const HOOKS_PATH = '.githooks';
export const HOOK = '.githooks/pre-push';

// hooksProblem은 root의 hook이 push마다 실행되지 않는 이유를, 실행되면 null을 돌려준다.
export function hooksProblem(root) {
  const config = spawnSync('git', ['config', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
  if (config.error) throw config.error;
  const value = config.stdout.trim();
  if (value !== HOOKS_PATH)
    return `core.hooksPath is ${value ? `'${value}'` : 'unset'}, not ${HOOKS_PATH}: the pre-push hook ${HOOK} does not run; run make hooks`;
  const hook = resolve(root, HOOK);
  if (!existsSync(hook)) return `${HOOK} does not exist; run make hooks in a checkout that has it`;
  try {
    accessSync(hook, constants.X_OK);
  } catch {
    return `${HOOK} is not executable; git does not run it; restore its mode 100755 (git checkout -- ${HOOK}) and run make hooks`;
  }
  return null;
}
