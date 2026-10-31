// The recipe format of docs/spec/feature-coverage.md (FCV-2 to FCV-4): every recipe of the parity suites is valid against
// scripts/features/schema/recipe.schema.json, and the schema refuses each break of the format that a recipe can hold.
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { readParityConfig } from '../json/formats.mts';
import { checkJson, readJsonFile, refusedPaths } from '../json/schema.mts';

const root = new URL('../..', import.meta.url).pathname;
const schema = resolve(root, 'scripts/features/schema/recipe.schema.json');
const fixtures = resolve(root, 'scripts/features/fixtures/recipes');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Recipe = { [key: string]: Json };

// read is a fixture recipe, checked against the recipe schema as it is read.
const read = (file: string): Recipe => readJsonFile<Recipe>(file, schema);
const refused = (value: unknown, source: string) => refusedPaths(() => checkJson(value, schema, source));

type Key = string | number;

// at is the member of value that path names; a path through a value that does not hold it is a fault of the test.
function at(value: Json, path: Key[]): Json {
  let node = value;
  for (const key of path) {
    const next = Array.isArray(node) && typeof key === 'number' ? node[key] : node !== null && typeof node === 'object' && !Array.isArray(node) && typeof key === 'string' ? node[key] : undefined;
    if (next === undefined) throw new Error(`the recipe holds no ${path.join('.')}`);
    node = next;
  }
  return node;
}

// change is a copy of the recipe with the member that path names set to value, or deleted when no value is given.
function change(recipe: Recipe, path: Key[], value?: Json): Recipe {
  const copy = structuredClone(recipe);
  const parent = at(copy, path.slice(0, -1));
  const key = path[path.length - 1];
  if (Array.isArray(parent) && typeof key === 'number') {
    if (value === undefined) parent.splice(key, 1);
    else parent[key] = value;
  } else if (parent !== null && typeof parent === 'object' && !Array.isArray(parent) && typeof key === 'string') {
    if (value === undefined) delete parent[key];
    else parent[key] = value;
  } else throw new Error(`the recipe holds no ${path.join('.')}`);
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
    ['a recipe without $schema', change(database, ['$schema'])],
    ['a key outside the format', change(database, ['databases'], ['mysql'])],
    ['a case without an id', change(database, ['cases', 0, 'id'])],
    ['a recipe without cases', change(database, ['cases'], [])],
    ['an op outside the list', change(database, ['cases', 0, 'steps', decode, 'op'], 'codec.reverse')],
    ['an expect without one database', change(database, ['cases', 0, 'steps', decode, 'expect', 'postgres'])],
    ['an expect of none in a recipe with a fixture', change(database, ['cases', 0, 'steps', decode, 'expect'], { none: { value: { text: 'a' } } })],
    ['an expect of the databases in a recipe without one', change(none, ['cases', 0, 'steps', 0, 'expect'], { mysql: { value: { text: 'a' } }, postgres: { value: { text: 'a' } }, sqlite: { value: { text: 'a' } } })],
    ['a step that compares its result without expect', change(database, ['cases', 0, 'steps', decode, 'expect'])],
    ['model.connect with expect', change(database, ['cases', 0, 'steps', 0, 'expect'], at(database, ['cases', 0, 'steps', decode, 'expect']))],
    ['sql.exec without its reason', change(database, ['cases', 0, 'steps', 1, 'reason'])],
    ['SQL for two of the three databases', change(database, ['cases', 0, 'steps', 1, 'sql', 'sqlite'])],
    ['an int as a JSON number', change(database, ['seed', 'rows', 'audit_log', 0, 'seq'], { int: 1 })],
    ['an int that is not a decimal', change(database, ['seed', 'rows', 'audit_log', 0, 'seq'], { int: '1e3' })],
    ['a value with two wrappers', change(database, ['seed', 'rows', 'audit_log', 0, 'seq'], { int: '1', text: '1' })],
    ['a wrapper outside the list', change(database, ['seed', 'rows', 'audit_log', 0, 'seq'], { money: '1.5' })],
    ['a float that is not a number text', change(database, ['seed', 'rows', 'audit_log', 0, 'seq'], { float: 'NaN' })],
    ['nil that is not true', change(database, ['seed', 'rows', 'audit_log', 0, 'seq'], { nil: false })],
    ['an object member that is not a key and value pair', change(database, ['seed', 'rows', 'audit_log', 0, 'seq'], { object: [['a', { int: '1' }, { int: '2' }]] })],
    ['an array item that is no wrapper', change(database, ['seed', 'rows', 'audit_log', 0, 'seq'], { array: [1] })],
    ['codec.encode that neither binds nor expects', change(none, ['cases', 0, 'steps', 0], { op: 'codec.encode', styles: ['serialize'], value: { text: 'a' } })],
    ['codec.host_decode without its key', change(none, ['cases', 0, 'steps', 0], { op: 'codec.host_decode', styles: ['hex'], raw: { text: '41' }, expect: { none: { value: { text: 'A' } } } })],
    ['codec.blind_index without expect', change(none, ['cases', 0, 'steps', 0], { op: 'codec.blind_index', value: { text: 'a' }, key: 'k' })],
    ['bytes_hex with an upper-case digit', change(database, ['cases', 0, 'steps', 3, 'raw'], { bytes_hex: '6A' })],
    ['bytes_hex with half a byte', change(database, ['cases', 0, 'steps', 3, 'raw'], { bytes_hex: '616' })],
    ['a datetime outside the INT-103 form', change(database, ['cases', 0, 'seed', 'rows', 'audit_log', 0, 'stamp'], { datetime: '2024-02-29T01:02:03Z' })],
    ['an error code outside the code form', change(database, ['cases', 0, 'steps', decode, 'expect', 'mysql'], { error: 'codec decode' })],
    ['a ref outside the name form', change(database, ['cases', 0, 'steps', 4, 'raw'], { ref: '1decoded' })],
    ['a fixture that is not a .dbs file', change(database, ['fixture'], 'contracts/fixtures/planner.json')],
  ];
  for (const [name, recipe] of breaks) assert.notDeepEqual(refused(recipe, name), [], `the schema accepts ${name}`);
});

caseTest('every recipe of the parity suites names the recipe schema and is valid against it', COMPUTE, () => {
  const parity = readParityConfig(resolve(root, 'config/parity.json'));
  const files = (parity.suites ?? []).flatMap(glob => globSync(glob, { cwd: root }));
  assert.ok(files.length > 0, 'config/parity.json names no suite file');
  for (const file of files) {
    const value: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    const named = value !== null && typeof value === 'object' && '$schema' in value ? value.$schema : undefined;
    if (typeof named !== 'string' || !named.endsWith('/recipe.schema.json')) continue;
    assert.equal(resolve(root, dirname(file), named), schema, `${file} names another recipe schema`);
    assert.deepEqual(refused(value, file), [], file);
  }
});
