// Requirements: FCV-16.
// The check of the database branches of the recipes: each rule of FCV-16 has an accepted case and a refused one.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { branchFaults, caseBranches, vectorBranches, type BranchedCase } from './recipe-branches.mts';

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

caseTest('a step that names a vector case takes its dialect branches, and a plan_physical step those of plans-physical.json', COMPUTE, () => {
  const files: Record<string, unknown> = {
    '/r/tests/v/ddl.json': { cases: [{ id: 'd', behavior: [{ sql: 'S' }, { sql: 'T', dialects: ['sqlite'] }] }] },
    '/r/tests/v/introspect.json': { cases: [{ id: 'i', dialect: 'mysql', statements: [] }, { id: 'every', statements: [] }] },
    '/r/tests/v/plan-cases.json': { cases: [{ id: 'p', steps: [{ op: 'dbspec.plan_steps', dialect: 'mysql' }] }] },
    '/r/tests/v/plans-physical.json': { cases: { p: { before: [{ sql: 'A', dialects: ['postgres'] }], after: [] } } },
  };
  const read = (path: string): unknown => files[path];
  const step = (op: string, vectors: string, name: string) => ({ id: 'c', steps: [{ op, vectors, case: name }] });
  assert.deepEqual(vectorBranches('/r', 'tests/v/render.json', step('dbspec.ddl_behavior', 'ddl.json', 'd'), read), [
    { path: 'tests/v/ddl.json#d/behavior/1/dialects', kind: 'vector', databases: ['sqlite'] },
  ]);
  assert.deepEqual(vectorBranches('/r', 'tests/v/render.json', step('dbspec.introspect', 'introspect.json', 'i'), read), [
    { path: 'tests/v/introspect.json#i/dialect', kind: 'vector', databases: ['mysql'] },
  ]);
  assert.deepEqual(vectorBranches('/r', 'tests/v/render.json', step('dbspec.introspect', 'introspect.json', 'every'), read), []);
  // The dialect of a plan step is the argument of a call on no database; the physical record of the case holds the branch.
  assert.deepEqual(vectorBranches('/r', 'tests/v/render.json', step('dbspec.plan_physical', 'plan-cases.json', 'p'), read), [
    { path: 'tests/v/plans-physical.json#p/before/0/dialects', kind: 'vector', databases: ['postgres'] },
  ]);
  assert.throws(() => vectorBranches('/r', 'tests/v/render.json', step('dbspec.introspect', 'introspect.json', 'gone'), read), /names the vector case gone/);
});
