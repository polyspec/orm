// The recipe format of docs/spec/feature-coverage.md (FCV-2 to FCV-4): every recipe of tests/ and contracts/ is valid against
// scripts/features/schema/recipe.schema.json, and the schema refuses each break of the format that a recipe can hold.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';

import { checkJson, parseJsonValue, readJsonFile, refusedPaths, type Json } from '../json/schema.mts';
import { executeCoverage, languages, recipeCaseIds, selectFeatures, type Manifest, type Owner } from './coverage.mts';
import { FEATURES_SCHEMA, ownerRecipeCommands, readFeatures } from './manifest.mts';
import { jsonFiles } from './recipe-files.mts';
import { readImplementations } from '../json/formats.mts';
import { testDirectoryOf } from './packages.mts';

const root = new URL('../..', import.meta.url).pathname;
// The recipes are the JSON files of tests/ and contracts/ that name the recipe schema.
const namedSchema = (file: string): unknown => {
  const value: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  return value !== null && typeof value === 'object' && '$schema' in value ? value.$schema : undefined;
};
const implementations = readImplementations(resolve(root, 'contracts/implementations.json'));
const recipeFiles = jsonFiles(root).filter(file => { const named = namedSchema(file); return typeof named === 'string' && named.endsWith('/recipe.schema.json'); });
const schema = resolve(root, 'scripts/features/schema/recipe.schema.json');
const fixtures = resolve(root, 'scripts/features/fixtures/recipes');

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

// label is a value of a recipe in the message of a fault.
const label = (value: Json | undefined): string => typeof value === 'string' ? value : JSON.stringify(value);

// jsonFile is a JSON file of the repository whose shape the case narrows.
const jsonFile = (file: string): Json => parseJsonValue(readFileSync(resolve(root, file), 'utf8'), file);

// items is the list that path names.
function items(value: Json, path: Key[]): Json[] {
  const list = at(value, path);
  if (!Array.isArray(list)) throw new Error(`${path.join('.')} of the recipe is not a list`);
  return list;
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

// B2-2a: a database op (model.connect, sql.exec) needs the three databases, so a recipe without a fixture cannot hold one.
caseTest('a recipe without a fixture refuses a database op', COMPUTE, () => {
  const recipe = read(resolve(fixtures, 'without-database.json'));
  const withOp = structuredClone(recipe);
  const cases = withOp.cases;
  assert.ok(Array.isArray(cases) && cases.length > 0, 'the recipe has a case');
  const kase = cases[0];
  assert.ok(typeof kase === 'object' && kase !== null && !Array.isArray(kase), 'the first case is an object');
  const steps = kase.steps;
  assert.ok(Array.isArray(steps), 'the case has steps');
  steps.push({ op: 'sql.exec', sql: 'SELECT 1', reason: 'a database op in a recipe without a fixture' });
  assert.notDeepEqual(refused(withOp, 'without-database + sql.exec'), [], 'a recipe without a fixture accepted sql.exec');
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
    ['a table page expect without its columns', change(database, ['cases', 0, 'steps', decode], { op: 'catalog.table_page', table: 'audit_log', limit: 1, offset: 0, columns: ['seq'], expect: Object.fromEntries(['mysql', 'postgres', 'sqlite'].map(db => [db, { order_by: ['seq'], has_more: false, rows: [] }])) })],
    ['a fixture that is not a document set', change(database, ['fixture'], 'contracts/fixtures/audit.dbs')],
  ];
  for (const [name, recipe] of breaks) assert.notDeepEqual(refused(recipe, name), [], `the schema accepts ${name}`);
});

// expectFaults are the steps of a recipe with a fixture whose expect names another set than the databases that run the step:
// those of the only of the step, else of its case, else all three (FCV-4, FCV-10). A markdown connection is a SQLite
// connection, so it reads the sqlite entry, and an entry of its own is named only where its result differs (DIA-154).
const DATABASES = ['mysql', 'postgres', 'sqlite'];
function expectFaults(recipe: Json): string[] {
  const faults: string[] = [];
  const walk = (steps: Json, inherited: string[], where: string) => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (step === null || typeof step !== 'object' || Array.isArray(step)) continue;
      const only = Array.isArray(step.only) ? step.only.map(String) : inherited;
      for (const key of ['expect', 'expect_unnamed']) {
        const expect = step[key];
        if (expect === null || typeof expect !== 'object' || Array.isArray(expect) || expect === undefined) continue;
        const servers = (names: string[]) => names.filter(name => name !== 'markdown').sort().join(',');
        const named = Object.keys(expect);
        const want = servers(only);
        if (servers(named) !== want || (named.includes('markdown') && !only.includes('sqlite'))) {
          faults.push(`${where} ${label(step.op)} ${key} names ${[...named].sort().join(',')}, want ${want}`);
        }
      }
      walk(step.steps ?? null, only, where);
    }
  };
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe) || !('fixture' in recipe) || !Array.isArray(recipe.cases)) return faults;
  for (const kase of recipe.cases) {
    if (kase === null || typeof kase !== 'object' || Array.isArray(kase)) continue;
    walk(kase.steps ?? null, Array.isArray(kase.only) ? kase.only.map(String) : DATABASES, label(kase.id));
  }
  return faults;
}

caseTest('an expect names exactly the databases that run its step', COMPUTE, () => {
  const database = read(resolve(fixtures, 'database.json'));
  const decode = 2;
  const expect = at(database, ['cases', 0, 'steps', decode, 'expect']);
  assert.ok(expect !== null && typeof expect === 'object' && !Array.isArray(expect), 'the expect is an object');
  const postgres = { postgres: expect.postgres ?? null };
  assert.deepEqual(expectFaults(database), []);
  assert.deepEqual(expectFaults(change(change(database, ['cases', 0, 'only'], ['postgres']), ['cases', 0, 'steps', decode, 'expect'], postgres)).filter(fault => fault.includes(' names postgres,')), [], 'a case with only names that database');
  assert.notDeepEqual(expectFaults(change(database, ['cases', 0, 'steps', decode, 'expect', 'postgres'])), [], 'an expect without one database');
  assert.notDeepEqual(expectFaults(change(database, ['cases', 0, 'only'], ['postgres'])), [], 'a case with only whose expect names the others');
  assert.notDeepEqual(expectFaults(change(change(database, ['cases', 0, 'steps', decode, 'only'], ['postgres']), ['cases', 0, 'steps', decode, 'expect', 'postgres'])), [], 'a step with only whose expect leaves it out');
  assert.deepEqual(recipeFiles.flatMap(file => expectFaults(jsonFile(file)).map(fault => `${file}: ${fault}`)), []);
});

// One subtest per recipe, so that a run reports every invalid recipe and not the first.
for (const file of recipeFiles) {
  const value: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  const named = value !== null && typeof value === 'object' && '$schema' in value ? value.$schema : undefined;
  if (typeof named !== 'string') continue;
  caseTest(`the recipe ${file} names the recipe schema and is valid against it`, COMPUTE, () => {
    assert.equal(resolve(root, dirname(file), named), schema, `${file} names another recipe schema`);
    assert.deepEqual(refused(value, file), [], file);
  });
}

// Requirements: FCV-12.
caseTest('the recipe is the list of the cases of its owners', COMPUTE, () => {
  const differences: string[] = [];
  // The manifest holds no copy of what the recipe lists: a copy goes stale when a lane adds a case to the recipe.
  const written = readJsonFile<Manifest>(resolve(root, 'contracts/features.json'), FEATURES_SCHEMA);
  for (const feature of written.features ?? []) {
    const owners = Object.entries(feature.coverage?.owners ?? {});
    const recipeOnly = owners.length > 0 && owners.every(([, owner]) => {
      const lists = Object.values(owner.commands ?? {});
      return lists.length > 0 && lists.every(list => (list ?? []).some(command => command.recipe));
    });
    if (recipeOnly && feature.coverage?.cases !== undefined) differences.push(`${feature.id}: coverage.cases copies its recipe`);
  }
  for (const feature of readFeatures(root).features ?? []) {
    const { every, commands } = ownerRecipeCommands(feature);
    const whole = new Set<string>();
    for (const { language, database, recipe, command } of commands) {
      const ids = recipeCaseIds(readFileSync(resolve(root, recipe), 'utf8'), command.database ?? database);
      ids.forEach(id => whole.add(id));
      if (JSON.stringify([...command.cases].sort()) !== JSON.stringify([...ids].sort()))
        differences.push(`${feature.id}/${language}/${database}: ${command.cases.length} declared, ${ids.length} in ${recipe}`);
    }
    if (every && JSON.stringify([...(feature.coverage?.cases ?? [])].sort()) !== JSON.stringify([...whole].sort()))
      differences.push(`${feature.id}: coverage.cases is not the list of its recipe`);
  }
  assert.deepEqual(differences, []);
});

// sampleOwner is a manifest in which the TypeScript owner runs entry as a recipe owner; the other owners are declared and
// not selected, since the checker requires an owner for each language that the tests of the feature claim.
function sampleOwner(entry: string, recipe: string, cases: string[]): Manifest {
  const owners = Object.fromEntries(languages.map((language): [string, Owner] => {
    // The other test lies in the first root of its implementation, so that the language is a language of the feature.
    const part = testDirectoryOf(language);
    const first = implementations.find(entry => entry.name === language)?.roots[0] ?? part;
    return [language, { part, tests: [`${first}/other`], commands: {} }];
  }));
  owners.typescript = { part: 'packages/ts', tests: [entry],
    commands: { none: [{ runner: 'node', test: entry, cases, recipe }] } };
  return selectFeatures({ features: [{ id: 'sample', status: 'partial', tests: Object.values(owners).flatMap(owner => owner.tests),
    coverage: { kind: 'independent', cases: ['whole'], owners, dependents: [] } }] }, 'sample', ['owner/typescript']);
}

// outcome is what a run of the sample reports, its errors and its TAP lines, which it keeps out of the output of this test.
async function outcome(manifest: Manifest, root: string): Promise<{ errors: string[]; text: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  // Inside this test's own node:test process a child `node --test` would report to this process and run no file.
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const errors = await executeCoverage(manifest, root, 5000);
    return { errors, text: [...errors, ...lines].join('\n') };
  } finally {
    console.log = log;
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
}

// Requirements: FCV-12.
caseTest('a recipe owner runs once and is read from the results its runner writes', 20000, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'orm-recipe-owner-')));
  const entry = 'packages/ts/tests/entry.mjs';
  const recipe = 'contracts/fixtures/sample/sample.json';
  const script = (lines: string[], after = '') => [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(join(directory, 'runs'))}, 'run\\n');`,
    ...lines.map(line => `appendFileSync(process.env.ORM_RECIPE_RESULTS, ${JSON.stringify(`${line}\n`)});`),
    after, ''].join('\n');
  try {
    await mkdir(join(directory, 'packages/ts/tests'), { recursive: true });
    await mkdir(join(directory, 'contracts/fixtures/sample'), { recursive: true });
    await writeFile(join(directory, recipe), JSON.stringify({ cases: [{ id: 'first', steps: [] }, { id: 'second', steps: [] }] }));
    const both = sampleOwner(entry, recipe, ['first', 'second']);

    await writeFile(join(directory, entry), script(['CASE first PASS', 'CASE second PASS']));
    assert.deepEqual((await outcome(both, directory)).errors, []);
    assert.equal(await readFile(join(directory, 'runs'), 'utf8'), 'run\n');

    // A case that wrote no line did not pass, whatever the exit status says.
    await writeFile(join(directory, entry), script(['CASE first PASS']));
    assert.match((await outcome(both, directory)).text, /observed cases first differ from first,second/);
    // A failed exit is a failure, whatever lines were written.
    await writeFile(join(directory, entry), script(['CASE first PASS', 'CASE second PASS'], 'process.exit(3);'));
    assert.match((await outcome(both, directory)).text, /exit 1/);
    // The recipe is the list: a command that names other cases is refused before anything runs.
    assert.match((await outcome(sampleOwner(entry, recipe, ['first']), directory)).text,
      /cases differ from recipe contracts\/fixtures\/sample\/sample\.json: declared first; recipe first,second/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Requirements: FCV-12.
caseTest('a recipe under tests/ or contracts/fixtures/ is accepted and a recipe elsewhere is refused', 20000, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'orm-recipe-place-')));
  const entry = 'packages/ts/tests/entry.mjs';
  try {
    await mkdir(join(directory, 'packages/ts/tests'), { recursive: true });
    await writeFile(join(directory, entry), `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.ORM_RECIPE_RESULTS, 'CASE first PASS\\n');\n`);
    for (const recipe of ['tests/sample/sample.json', 'contracts/fixtures/sample/sample.json', 'docs/sample/sample.json']) {
      await mkdir(join(directory, dirname(recipe)), { recursive: true });
      await writeFile(join(directory, recipe), JSON.stringify({ cases: [{ id: 'first', steps: [] }] }));
    }
    assert.deepEqual((await outcome(sampleOwner(entry, 'tests/sample/sample.json', ['first']), directory)).errors, []);
    assert.deepEqual((await outcome(sampleOwner(entry, 'contracts/fixtures/sample/sample.json', ['first']), directory)).errors, []);
    assert.match((await outcome(sampleOwner(entry, 'docs/sample/sample.json', ['first']), directory)).text, /invalid test command/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Requirements: FCV-3, FCV-12.
caseTest('the cases of a recipe on a database leave out a case that names only other databases', COMPUTE, () => {
  const text = JSON.stringify({ cases: [{ id: 'all' }, { id: 'lite', only: ['sqlite'] }] });
  assert.deepEqual(recipeCaseIds(text, 'sqlite'), ['all', 'lite']);
  assert.deepEqual(recipeCaseIds(text, 'mysql'), ['all']);
});

// tests/dbspec/introspect.json is the vector file of the recipe dbspec_introspect, not a suite of its own: each of its cases
// is a case of that recipe, so that a new vector cannot stay unrun.
// Requirements: FCV-2, DIA-133.
caseTest('the recipe dbspec_introspect names every case of tests/dbspec/introspect.json', COMPUTE, () => {
  const vectors = items(jsonFile('tests/dbspec/introspect.json'), ['cases']).map(vector => label(at(vector, ['id'])));
  const named = items(jsonFile('contracts/fixtures/dbspec_introspect/dbspec_introspect.json'), ['cases']).flatMap(entry =>
    items(entry, ['steps']).filter(step => step !== null && typeof step === 'object' && !Array.isArray(step) && step.vectors === '../../../tests/dbspec/introspect.json').map(step => label(at(step, ['case']))));
  assert.deepEqual([...named].sort(), [...vectors].sort());
});
