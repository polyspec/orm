// CI가 생성 model 검사(go-model-check, ts-model-check)와 공통 interface 검사를 실행하는지 확인한다. CI는 CI group마다 job
// 하나로 make check-run GROUP=<group>을 실행하고, CHECK_TARGETS의 모든 target은 어느 CI group(CI_TARGETS_<group>)의 target이다.
// interface 검사는 make check의 feature-check가 contracts/features.json의 검증 명령으로 실행한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../testcase.mts';

const root = resolve(import.meta.dirname, '../../..');

// GROUP_CHECK는 CI group job의 make check step이다.
const GROUP_CHECK = 'run: make check-run GROUP=${{ matrix.group }}';
// INTERFACE_COMMAND는 make interface-check의 명령이며 feature-check가 검증 명령으로 실행한다.
const INTERFACE_COMMAND = 'node tests/interfaces/check/main.mts --self-test';

// makeVariable은 Makefile의 한 줄 정의 `NAME = value`의 값을 필드로 돌려준다.
function makeVariable(makefile: string, name: string): string[] {
  for (const line of makefile.split('\n')) {
    if (line.startsWith(`${name} = `)) return line.slice(name.length + 3).split(/\s+/).filter(Boolean);
  }
  return [];
}

function withoutTarget(makefile: string, prefix: string, target: string): string {
  return makefile.split('\n').map(line => {
    const at = line.indexOf(' = ');
    if (at < 0 || !line.startsWith(prefix)) return line;
    return `${line.slice(0, at)} = ${line.slice(at + 3).split(/\s+/).filter(field => field !== '' && field !== target).join(' ')}`;
  }).join('\n');
}

function validateGeneratedCI(workflow: string, makefile: string, features: string): void {
  if (!workflow.split('\n').some(line => line.trim() === GROUP_CHECK)) throw new Error(`CI must run make check for each CI group: ${GROUP_CHECK}`);
  const targets = new Set(makeVariable(makefile, 'CHECK_TARGETS'));
  for (const target of ['go-model-check', 'ts-model-check']) {
    if (!targets.has(target)) throw new Error(`CHECK_TARGETS must include ${target}`);
  }
  // 모든 CHECK_TARGETS target은 어느 CI group의 target이다: 그 group의 job이 make check-run GROUP=<group>으로 실행한다.
  const grouped = new Set(makeVariable(makefile, 'CI_GROUPS').flatMap(group => makeVariable(makefile, `CI_TARGETS_${group}`)));
  for (const target of targets) {
    if (!grouped.has(target)) throw new Error(`no CI group of CI_GROUPS runs ${target} of CHECK_TARGETS`);
  }
  if (!features.includes(INTERFACE_COMMAND)) throw new Error(`contracts/features.json must verify ${INTERFACE_COMMAND}`);
}

caseTest('CI requires the generated checks', COMPUTE, () => {
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
  const workflow = read('.github/workflows/ci.yml'), makefile = read('Makefile'), features = read('contracts/features.json');
  validateGeneratedCI(workflow, makefile, features);
  for (const [name, w, mk, f] of [
    ['make check', workflow.replace('run: make check', 'run: true'), makefile, features],
    ['make check-run GROUP', workflow.replace(GROUP_CHECK, 'run: make check'), makefile, features],
    ['go-model-check', workflow, withoutTarget(makefile, 'CHECK_TARGETS = ', 'go-model-check'), features],
    ['ts-model-check', workflow, withoutTarget(makefile, 'CHECK_TARGETS = ', 'ts-model-check'), features],
    ['go-model-check in a CI group', workflow, withoutTarget(makefile, 'CI_TARGETS_', 'go-model-check'), features],
    ['ts-model-check in a CI group', workflow, withoutTarget(makefile, 'CI_TARGETS_', 'ts-model-check'), features],
    ['interface-check', workflow, makefile, features.replace(INTERFACE_COMMAND, 'true')],
  ] as const) {
    assert.ok(w !== workflow || mk !== makefile || f !== features, `missing mutation target ${name}`);
    assert.throws(() => validateGeneratedCI(w, mk, f), `CI without ${name} passed`);
  }
});
