// The CI declaration preview reads configuration and never evaluates Make or starts a tool.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { ciDeclarationPlan } from './ci-plan.mts';

const workflow = `jobs:
  kit:
    uses: ./.github/workflows/ci-pipeline.yml
  test:
    strategy:
      matrix:
        group: [plain, python]
    steps:
      - id: checkout
        uses: actions/checkout@v5
      - id: orm-install-python
        if: \${{ !cancelled() && steps.group-needs.outputs.python == 'true' }}
        run: make orm-install-python
      - run: make check-run GROUP=\${{ matrix.group }}
  ci-passed:
    needs: [kit, test]
    steps:
      - run: make ci-passed
`;
const makefile = `CHECK_TARGETS = unit-check python-check
CI_GROUPS = plain python
CI_TARGETS_plain = unit-check
CI_TARGETS_python = python-check
unit-check: generated
\tnode tests/unit.mts
python-check:
\tpython -m tests.case
generated:
\techo 'not executed'
`;

caseTest('CI preview shows parallel jobs, ordered group targets and only their declared setup', COMPUTE, () => {
  const plan = ciDeclarationPlan(makefile, workflow, { 'unit-check': [], 'python-check': ['python'] });
  assert.equal(plan.execution, 'not-run');
  assert.deepEqual(plan.jobs.find(job => job.id === 'ci-passed')?.needs, ['kit', 'test']);
  assert.deepEqual(plan.jobs.find(job => job.id === 'test')?.needs, []);
  assert.deepEqual(plan.groups.map(group => group.targets), [['unit-check'], ['python-check']]);
  assert.equal(plan.groups[0]?.setup.find(step => step.id === 'orm-install-python')?.selected, false);
  assert.equal(plan.groups[1]?.setup.find(step => step.id === 'orm-install-python')?.selected, true);
  assert.ok(plan.recipes.some(recipe => recipe.target === 'unit-check' && recipe.prerequisites.includes('generated')));
  assert.throws(() => ciDeclarationPlan(makefile, workflow.replace("steps.group-needs.outputs.python == 'true'", 'false'),
    { 'unit-check': [], 'python-check': ['python'] }), /orm-install-python.*condition/);
});

caseTest('CI preview never evaluates a Make shell expression and labels unresolved execution details', COMPUTE, () => {
  const dir = mkdtempSync(join(tmpdir(), 'orm-ci-plan-'));
  const marker = join(dir, 'executed');
  try {
    const plan = ciDeclarationPlan(makefile + `SIDE_EFFECT := $(shell touch ${marker})\n`, workflow,
      { 'unit-check': [], 'python-check': ['python'] });
    assert.equal(existsSync(marker), false);
    assert.ok(plan.notEvaluated.includes('Make expressions and recipes'));
    assert.ok(plan.notEvaluated.includes('commands selected inside runner programs'));
    assert.throws(() => ciDeclarationPlan(makefile, workflow, { 'unit-check': [] }), /python-check.*needs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
