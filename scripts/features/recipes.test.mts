// The recipe format of docs/spec/feature-coverage.md (FCV-2 to FCV-4): every recipe of the parity suites is valid against
// scripts/features/schema/recipe.schema.json, and the schema refuses each break of the format that a recipe can hold.
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { checkJson, refusedPaths } from '../json/schema.mts';

const root = new URL('../..', import.meta.url).pathname;
const schema = resolve(root, 'scripts/features/schema/recipe.schema.json');
const fixtures = resolve(root, 'scripts/features/fixtures/recipes');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Recipe = { [key: string]: Json };

const read = (file: string): Recipe => JSON.parse(readFileSync(file, 'utf8'));
const refused = (value: unknown, source: string) => refusedPaths(() => checkJson(value, schema, source));

// change is a copy of the recipe with one edit applied to it.
function change(recipe: Recipe, edit: (copy: any) => void): Recipe {
  const copy = structuredClone(recipe);
  edit(copy);
  return copy;
}

caseTest('the recipe fixtures with and without a database are valid', COMPUTE, () => {
  for (const name of ['database.json', 'without-database.json']) {
    assert.deepEqual(refused(read(resolve(fixtures, name)), name), [], name);
  }
});

caseTest('the recipe schema refuses each break of the format', COMPUTE, () => {
  const database = read(resolve(fixtures, 'database.json'));
  const none = read(resolve(fixtures, 'without-database.json'));
  const decode = 2;
  const breaks: [string, Recipe][] = [
    ['a recipe without $schema', change(database, copy => delete copy.$schema)],
    ['a key outside the format', change(database, copy => (copy.databases = ['mysql']))],
    ['a case without an id', change(database, copy => delete copy.cases[0].id)],
    ['a recipe without cases', change(database, copy => (copy.cases = []))],
    ['an op outside the list', change(database, copy => (copy.cases[0].steps[decode].op = 'codec.encode'))],
    ['an expect without one database', change(database, copy => delete copy.cases[0].steps[decode].expect.postgres)],
    ['an expect of none in a recipe with a fixture', change(database, copy => (copy.cases[0].steps[decode].expect = { none: { value: { text: 'a' } } }))],
    ['an expect of the databases in a recipe without one', change(none, copy => (copy.cases[0].steps[0].expect = { mysql: { value: { text: 'a' } }, postgres: { value: { text: 'a' } }, sqlite: { value: { text: 'a' } } }))],
    ['a step that compares its result without expect', change(database, copy => delete copy.cases[0].steps[decode].expect)],
    ['model.connect with expect', change(database, copy => (copy.cases[0].steps[0].expect = copy.cases[0].steps[decode].expect))],
    ['sql.exec without its reason', change(database, copy => delete copy.cases[0].steps[1].reason)],
    ['SQL for two of the three databases', change(database, copy => delete copy.cases[0].steps[1].sql.sqlite)],
    ['an int as a JSON number', change(database, copy => (copy.seed.rows.audit_log[0].seq = { int: 1 }))],
    ['an int that is not a decimal', change(database, copy => (copy.seed.rows.audit_log[0].seq = { int: '1e3' }))],
    ['a value with two wrappers', change(database, copy => (copy.seed.rows.audit_log[0].seq = { int: '1', text: '1' }))],
    ['a wrapper outside the list', change(database, copy => (copy.seed.rows.audit_log[0].seq = { float: '1.5' }))],
    ['bytes_hex with an upper-case digit', change(database, copy => (copy.cases[0].steps[3].raw = { bytes_hex: '6A' }))],
    ['bytes_hex with half a byte', change(database, copy => (copy.cases[0].steps[3].raw = { bytes_hex: '616' }))],
    ['a datetime outside the INT-103 form', change(database, copy => (copy.cases[0].seed.rows.audit_log[0].stamp = { datetime: '2024-02-29T01:02:03Z' }))],
    ['an error code outside the code form', change(database, copy => (copy.cases[0].steps[decode].expect.mysql = { error: 'codec decode' }))],
    ['a ref outside the name form', change(database, copy => (copy.cases[0].steps[4].raw = { ref: '1decoded' }))],
    ['a fixture that is not a .dbs file', change(database, copy => (copy.fixture = 'contracts/fixtures/planner.json'))],
  ];
  for (const [name, recipe] of breaks) assert.notDeepEqual(refused(recipe, name), [], `the schema accepts ${name}`);
});

caseTest('every recipe of the parity suites names the recipe schema and is valid against it', COMPUTE, () => {
  const parity = JSON.parse(readFileSync(resolve(root, 'config/parity.json'), 'utf8')) as { suites: string[] };
  const files = parity.suites.flatMap(glob => globSync(glob, { cwd: root }));
  assert.ok(files.length > 0, 'config/parity.json names no suite file');
  for (const file of files) {
    const value: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    const named = value !== null && typeof value === 'object' && '$schema' in value ? value.$schema : undefined;
    if (typeof named !== 'string' || !named.endsWith('/recipe.schema.json')) continue;
    assert.equal(resolve(root, dirname(file), named), schema, `${file} names another recipe schema`);
    assert.deepEqual(refused(value, file), [], file);
  }
});
