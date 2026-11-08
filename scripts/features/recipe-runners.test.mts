// Requirements: FCV-15.
// The check of one recipe runner per runtime: each rule of FCV-15 has an accepting tree and a refused one.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { findings, READERS, readTree, recipeBindings, stepOps, type Tree } from './recipe-runners.mts';

const RUNNER_SOURCES: [string, string][] = [
  ['packages/go/internal/recipe/recipe.go', 'OP_UNKNOWN'],
  ['packages/php/tests/Recipe.php', 'OP_UNKNOWN'],
  ['packages/ts/tests/recipe.mjs', 'OP_UNKNOWN'],
  ['packages/python/tests/recipe.py', 'OP_UNKNOWN'],
  ['packages/rust/tests/src/recipe.rs', 'OP_UNKNOWN'],
];

function tree(overrides: Partial<Tree> & { extra?: [string, string][] } = {}): Tree {
  return {
    bindings: [{ implementation: 'typescript', test: 'packages/ts/tests/unit.test.mjs', recipes: ['tests/unit/unit.json'] }],
    readers: Object.keys(READERS),
    ops: ['model.count'],
    sources: new Map([...RUNNER_SOURCES, ['packages/ts/tests/unit.test.mjs', "runRecipe('unit.json', NONE);"], ...(overrides.extra ?? [])]),
    steps: new Set(['model.count']),
    ...overrides,
  };
}

caseTest('a tree of one runner per runtime has no finding', COMPUTE, () => {
  assert.deepEqual(findings(tree()), []);
});

caseTest('a PHP binding that extends a recipe test class of PHP hands its recipe to the runner', COMPUTE, () => {
  for (const base of ['DatabaseRecipeTestCase', 'SqliteRecipeTestCase']) {
    const php = tree({
      bindings: [{ implementation: 'php', test: 'packages/php/tests/UnitRecipeTest.php', recipes: ['tests/unit/unit.json'] }],
      extra: [['packages/php/tests/UnitRecipeTest.php', `final class UnitRecipeTest extends ${base}\n{\n}`]],
    });
    assert.deepEqual(findings(php), [], base);
  }
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

caseTest('a test that names a recipe, or a PHP extension test that extends one, is a recipe test', COMPUTE, () => {
  const sources = new Map([
    ['packages/ts/tests/unit.test.mjs', "runRecipe('tests/unit/unit.json', NONE);"],
    ['packages/ts/tests/other.test.mjs', '// the cases of tests/unit/unit.json run elsewhere\ntest(() => {});'],
    ['packages/php/tests/UnitRecipeTest.php', "class UnitRecipeTest { const FILE = 'unit/unit.json'; }"],
    ['packages/php-ext/tests/UnitRecipeExtensionTest.php', 'final class UnitRecipeExtensionTest extends \\Polyspec\\Orm\\Tests\\UnitRecipeTest {}'],
    ['packages/php-ext/tests/OtherExtensionTest.php', 'final class OtherExtensionTest extends TestCase {}'],
  ]);
  const tests = { typescript: ['packages/ts/tests/unit.test.mjs', 'packages/ts/tests/other.test.mjs'], php: ['packages/php/tests/UnitRecipeTest.php'],
    'php-extension': ['packages/php-ext/tests/UnitRecipeExtensionTest.php', 'packages/php-ext/tests/OtherExtensionTest.php'] };
  assert.deepEqual(recipeBindings(tests, ['tests/unit/unit.json'], sources), [
    { implementation: 'typescript', test: 'packages/ts/tests/unit.test.mjs', recipes: ['tests/unit/unit.json'] },
    { implementation: 'php', test: 'packages/php/tests/UnitRecipeTest.php', recipes: ['tests/unit/unit.json'] },
    { implementation: 'php-extension', test: 'packages/php-ext/tests/UnitRecipeExtensionTest.php', recipes: ['tests/unit/unit.json'] },
  ]);
});

caseTest('a reader that names no recipe is a finding', COMPUTE, () => {
  const [reader] = Object.keys(READERS);
  assert.ok(reader);
  assert.match(findings(tree({ readers: Object.keys(READERS).filter(name => name !== reader) })).join('\n'), /a reader of READERS that names no recipe/);
});

caseTest('the tree of this checkout has no finding', COMPUTE, () => {
  assert.deepEqual(findings(readTree()), []);
});
