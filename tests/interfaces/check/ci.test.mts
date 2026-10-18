// Checks that CI runs the generated model checks (go-model-check, ts-model-check) and the common interface check. CI runs one job per CI group
// that runs make check-run GROUP=<group>, and every CHECK_TARGETS target is a target of some CI group (CI_TARGETS_<group>).
// The interface check is run by feature-check in make check as a verify command in contracts/features.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../testcase.mts';

const root = resolve(import.meta.dirname, '../../..');

// GROUP_CHECK is the make check step of a CI group job.
const GROUP_CHECK = 'run: make check-run GROUP=${{ matrix.group }}';
// INTERFACE_COMMAND is the command of make interface-check, and feature-check runs it as a verify command.
const INTERFACE_COMMAND = 'node tests/interfaces/check/main.mts --self-test';

// makeVariable returns the value of a one-line Makefile definition `NAME = value` as a field.
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
  // Every CHECK_TARGETS target is a target of some CI group: that group's job runs it with make check-run GROUP=<group>.
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
