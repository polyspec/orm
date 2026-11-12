// The suite of each runtime runs every test file of contracts/implementations.json but the files another check runs with
// arguments of its own; each such file is a test file of the runtime and is named by the check that runs it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { caseTest, COMPUTE } from '../tests/testcase.mts';
import { implementationFiles, implementationTestInventory } from './features/languages.mts';
import { readTree } from './features/recipe-runners.mts';
import { MARIADB_ENTRY, OWNED_ELSEWHERE, SUITE_LANES, recipeEntries, suiteBatches, suiteCommand, suiteTests } from './suite-test.mts';

const root = resolve(import.meta.dirname, '..');
const { tests } = implementationTestInventory(implementationFiles(root));

caseTest('the suite of a runtime is its test files less the files another check runs', COMPUTE, () => {
  for (const lane of SUITE_LANES) {
    const suite = suiteTests(lane, tests);
    const owned = (tests[lane] ?? []).filter(file => Object.hasOwn(OWNED_ELSEWHERE, file) || MARIADB_ENTRY.test(file));
    assert.ok(suite.length > 0, `${lane} has a suite`);
    assert.deepEqual([...suite, ...owned].sort(), [...(tests[lane] ?? [])].sort(), `${lane} leaves no test file out but the owned ones`);
  }
  const sample = { typescript: ['legacy/packages/ts/tests/b.test.mjs', 'legacy/packages/ts/tests/decimal_model_db.mjs', 'legacy/packages/ts/tests/a.test.mjs'] };
  assert.deepEqual(suiteTests('typescript', sample), ['legacy/packages/ts/tests/a.test.mjs', 'legacy/packages/ts/tests/b.test.mjs']);
  assert.throws(() => suiteTests('php', sample), /declares no implementation php/);
});

caseTest('each file another check runs is a test file of its runtime, and that check names it', COMPUTE, () => {
  const all = new Set(Object.values(tests).flat());
  for (const [file, owner] of Object.entries(OWNED_ELSEWHERE)) {
    assert.ok(all.has(file), `${file} is no test file of contracts/implementations.json`);
    const text = readFileSync(resolve(root, owner), 'utf8');
    const module = file.replace(/\.py$/, '').replaceAll('/', '.');
    const named = text.includes(file) || text.includes(module) || (owner.endsWith('performance-reference.mts') && text.includes('performanceTest('));
    assert.ok(named, `${owner} does not name ${file}`);
  }
});

// The recipe entries of mariadb need the MariaDB servers, which the runner of a suite cannot hold (DIA-200, FCV-3).
caseTest('the suites leave the recipe entries of mariadb to make mariadb-recipes-check', COMPUTE, () => {
  const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
  for (const lane of SUITE_LANES) {
    const entries = (tests[lane] ?? []).filter(file => MARIADB_ENTRY.test(file));
    assert.ok(entries.length > 0, `${lane} has entries of mariadb`);
    assert.ok(suiteTests(lane, tests).every(file => !MARIADB_ENTRY.test(file)), `${lane} runs no entry of mariadb`);
    assert.match(makefile, new RegExp(`^mariadb-recipes-check/${lane}:`, 'm'), `make mariadb-recipes-check/${lane} runs them`);
  }
  for (const file of ['legacy/packages/ts/tests/aes_rotation-mysql.test.mjs', 'legacy/packages/python/tests/test_aes_rotation_mysql.py', 'legacy/packages/php/tests/AesRotationMysqlTest.php'])
    assert.ok(!MARIADB_ENTRY.test(file), `${file} is no entry of mariadb`);
});

// The recipe runs of every database run one case at a time (docs/spec/dialects.md DIA-212).
caseTest('a suite runs its recipe entries one at a time, after the other files', COMPUTE, () => {
  const { bindings } = readTree();
  const entries = { php: 'legacy/packages/php/tests/AuditTriggersRecipeTest.php', typescript: 'legacy/packages/ts/tests/aes_rotation-mysql.test.mjs', python: 'legacy/packages/python/tests/test_aes_rotation_sqlite.py' };
  const others = { php: 'legacy/packages/php/tests/RuntimeDbTest.php', typescript: 'legacy/packages/ts/tests/aggregate_numeric.mjs', python: 'legacy/packages/python/tests/mysql_session.py' };
  for (const lane of SUITE_LANES) {
    const suite = suiteTests(lane, tests);
    const { together, inTurn } = suiteBatches(suite, recipeEntries(lane, bindings));
    assert.deepEqual([...together, ...inTurn].sort(), suite, `${lane} runs every file of its suite once`);
    assert.ok(inTurn.includes(entries[lane]), `${lane} runs ${entries[lane]} in turn`);
    assert.ok(!together.includes(entries[lane]), `${lane} runs ${entries[lane]} alone`);
    assert.ok(together.includes(others[lane]), `${lane} runs ${others[lane]} with the other files`);
  }
  const sample = ['legacy/packages/ts/tests/a.test.mjs', 'legacy/packages/ts/tests/b-mysql.test.mjs', 'legacy/packages/ts/tests/c.test.mjs'];
  assert.deepEqual(suiteBatches(sample, new Set(['legacy/packages/ts/tests/b-mysql.test.mjs'])), {
    together: ['legacy/packages/ts/tests/a.test.mjs', 'legacy/packages/ts/tests/c.test.mjs'],
    inTurn: ['legacy/packages/ts/tests/b-mysql.test.mjs'],
  });
});

caseTest('a file of the suite runs as the runner of its runtime runs one file', COMPUTE, () => {
  assert.deepEqual(suiteCommand('typescript', 'legacy/packages/ts/tests/a.test.mjs').args, ['--conditions=orm-test', '--test', 'legacy/packages/ts/tests/a.test.mjs']);
  assert.deepEqual(suiteCommand('python', 'legacy/packages/python/tests/test_a.py').args, ['-m', 'unittest', '-v', 'packages.python.tests.test_a']);
  const php = suiteCommand('php', 'legacy/packages/php/tests/ATest.php');
  assert.deepEqual([php.program, ...php.args], ['php', 'vendor-php/bin/phpunit', '--configuration', 'legacy/packages/php/phpunit.xml.dist', 'legacy/packages/php/tests/ATest.php']);
  assert.deepEqual(php.env, { ORM_PHP_MODE: 'library' });
});
