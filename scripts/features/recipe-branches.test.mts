// Requirements: FCV-16.
// The check of the database branches of the recipes: each rule of FCV-16 has an accepted case and a refused one.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { branchFaults, caseBranches, type BranchedCase } from './recipe-branches.mts';

const ITEMS = new Set(['DIA-1', 'PRT-72']);

function branched(overrides: Partial<BranchedCase>): BranchedCase {
  return { file: 'contracts/fixtures/unit/unit.json', line: 3, id: 'unit_case', branches: [], reason: undefined, ...overrides };
}

caseTest('an only of a case or of a step is a branch on its databases', COMPUTE, () => {
  assert.deepEqual(caseBranches({ id: 'c', only: ['mysql', 'postgres'], steps: [] }), [{ path: '/only', kind: 'only', databases: ['mysql', 'postgres'] }]);
  assert.deepEqual(caseBranches({ id: 'c', steps: [{ op: 'model.count' }, { op: 'utils.run', only: ['sqlite'] }] }), [
    { path: '/steps/1/only', kind: 'only', databases: ['sqlite'] },
  ]);
});

caseTest('a map by database is a branch only when its entries differ', COMPUTE, () => {
  const same = { mysql: { value: { int: '1' } }, postgres: { value: { int: '1' } }, sqlite: { value: { int: '1' } } };
  assert.deepEqual(caseBranches({ id: 'c', steps: [{ op: 'model.count', expect: same }] }), []);
  const differ = { mysql: 'SELECT 1', postgres: 'SELECT 1', sqlite: 'SELECT 2' };
  assert.deepEqual(caseBranches({ id: 'c', steps: [{ op: 'utils.run', statements: [{ sql: differ }] }] }), [
    { path: '/steps/0/statements/0/sql', kind: 'map', databases: ['mysql', 'postgres', 'sqlite'] },
  ]);
  // A map whose keys are not all databases, such as an expect of one outcome, is not a branch.
  assert.deepEqual(caseBranches({ id: 'c', steps: [{ op: 'model.count', expect: { value: { int: '1' }, error: 'X' } }] }), []);
});

caseTest('a branch with a reason that names a defined item has no fault', COMPUTE, () => {
  const branch = { path: '/only', kind: 'only' as const, databases: ['mysql'] };
  assert.deepEqual(branchFaults([branched({ branches: [branch], reason: 'MySQL alone has it (DIA-1).' })], ITEMS), []);
});

caseTest('a branch without a reason is a fault', COMPUTE, () => {
  const branch = { path: '/only', kind: 'only' as const, databases: ['mysql', 'postgres'] };
  assert.deepEqual(branchFaults([branched({ branches: [branch] })], ITEMS), [
    'contracts/fixtures/unit/unit.json:3 case unit_case: branches on a database (/only mysql,postgres) and states no databases_differ',
  ]);
});

caseTest('a reason without a branch is a fault', COMPUTE, () => {
  assert.deepEqual(branchFaults([branched({ reason: 'Each server keeps it (PRT-72).' })], ITEMS), [
    'contracts/fixtures/unit/unit.json:3 case unit_case: states databases_differ and holds no branch on a database',
  ]);
});

caseTest('a reason must name an item that docs/spec defines', COMPUTE, () => {
  const branch = { path: '/only', kind: 'only' as const, databases: ['sqlite'] };
  // UTF-8 has the form of an id but no prefix of docs/spec, so it is text and the reason names no item.
  assert.deepEqual(branchFaults([branched({ branches: [branch], reason: 'SQLite reads UTF-8 only.' })], ITEMS), [
    'contracts/fixtures/unit/unit.json:3 case unit_case: databases_differ names no item of docs/spec',
  ]);
  assert.deepEqual(branchFaults([branched({ branches: [branch], reason: 'SQLite lacks it (DIA-999).' })], ITEMS), [
    'contracts/fixtures/unit/unit.json:3 case unit_case: databases_differ names DIA-999, which docs/spec does not define',
  ]);
});
