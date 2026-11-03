// Requirements: FCV-15.
// The check of one recipe runner per runtime: each rule of FCV-15 has an accepting tree and a refused one.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { findings, readTree, stepOps, type Tree } from './recipe-runners.mts';

const RUNNER_SOURCES: [string, string][] = [
  ['packages/go/internal/recipe/recipe.go', 'OP_UNKNOWN'],
  ['packages/php/tests/Recipe.php', 'OP_UNKNOWN'],
  ['packages/ts/tests/recipe.mjs', 'OP_UNKNOWN'],
  ['packages/python/tests/recipe.py', 'OP_UNKNOWN'],
  ['packages/rust/tests/src/recipe.rs', 'OP_UNKNOWN'],
];

function tree(overrides: Partial<Tree> & { extra?: [string, string][] } = {}): Tree {
  return {
    units: [{ id: 'unit', kind: 'suite', recipe: true, bindings: [{ implementation: 'typescript', test: 'packages/ts/tests/unit.test.mjs' }] }],
    ops: ['model.count'],
    sources: new Map([...RUNNER_SOURCES, ['packages/ts/tests/unit.test.mjs', "runRecipe('unit.json', NONE);"], ...(overrides.extra ?? [])]),
    steps: new Set(['model.count']),
    ...overrides,
  };
}

caseTest('a tree of one runner per runtime has no finding', COMPUTE, () => {
  assert.deepEqual(findings(tree()), []);
});

caseTest('a binding that hands its recipe to no runner is a finding', COMPUTE, () => {
  const refused = tree({ extra: [['packages/ts/tests/unit.test.mjs', 'run the cases here;']] });
  assert.match(findings(refused).join('\n'), /hands no recipe to the runner/);
});

caseTest('a binding that implements an op is a finding', COMPUTE, () => {
  const refused = tree({ extra: [['packages/ts/tests/unit.test.mjs', "runRecipe('unit.json', NONE); const op = 'model.count';"]] });
  assert.match(findings(refused).join('\n'), /implements the op model\.count/);
});

caseTest('a runner that dispatches by a prefix is a finding', COMPUTE, () => {
  const refused = tree({ extra: [['packages/php/tests/Recipe.php', "OP_UNKNOWN; if (str_starts_with($s['op'], 'model.')) {}"]] });
  assert.match(findings(refused).join('\n'), /dispatches an op by a prefix/);
});

caseTest('a runner that refuses no op is a finding', COMPUTE, () => {
  const refused = tree({ extra: [['packages/python/tests/recipe.py', 'pass']] });
  assert.match(findings(refused).join('\n'), /python: the runner refuses no op/);
});

caseTest('a second runner is a finding', COMPUTE, () => {
  const refused = tree({ extra: [['packages/rust/orm/src/second.rs', 'OP_UNKNOWN']] });
  assert.match(findings(refused).join('\n'), /second\.rs: refuses an op outside the runner/);
});

caseTest('a schema op with no step is a finding', COMPUTE, () => {
  assert.match(findings(tree({ ops: ['model.count', 'utils.local'] })).join('\n'), /schema op utils\.local is the op of no step/);
});

caseTest('the ops of nested steps count, and a predicate op does not', COMPUTE, () => {
  const ops = stepOps({ cases: [{ steps: [{ op: 'transaction', steps: [{ op: 'model.count', where: { op: 'eq' } }] }] }] });
  assert.deepEqual([...ops].sort(), ['model.count', 'transaction']);
});

caseTest('the tree of this checkout has no finding', COMPUTE, () => {
  assert.deepEqual(findings(readTree()), []);
});
