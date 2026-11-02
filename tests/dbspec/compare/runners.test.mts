// Checks that every dbspec compare runner rejects, with an error stating the location and a nonzero exit, a vector file it reads whose vector section, id, document,
// or line is missing or of another type. In cases.json a section or field that the format does
// not name is refused too. The document cases are in the recipe files beside cases.json (canonical, normalize, invalid, positions and files
// of tests/dbspec); a mutation of a recipe edits a copy of that recipe in a directory of its own, which the runners read from the directory of cases.json.
//
// Usage: DBSPEC_STRESS_DOCUMENT=<stress document> node --test tests/dbspec/compare/runners.test.mts
// (after the TypeScript build, the debug build of the Rust example and the build of the PHP extension)
import { after } from 'node:test';
import { caseTest } from '../../testcase.mts';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, runRunner, runners } from './runners.mts';
import { readCases } from '../cases.mts';

// TIMEOUT is the deadline for one case. A case runs the Go, PHP, TypeScript, Rust, and PHP extension runner processes on one vector file,
// and the Go runner includes the `go run` compile.
const TIMEOUT = 120000;
const stress = process.env.DBSPEC_STRESS_DOCUMENT;
if (stress === undefined || stress === '') throw new Error('DBSPEC_STRESS_DOCUMENT is required; run it through make dbspec-compare-check, which writes the stress document');

const files = ['cases', 'ddl', 'plans', 'mermaid', 'syntax'];
// The recipe files of the document cases, which sit beside cases.json and read it from the same directory.
const recipes = ['canonical', 'normalize', 'invalid', 'positions', 'files'];
const directory = mkdtempSync(join(tmpdir(), 'dbspec-compare-runners-'));
after(() => rmSync(directory, { recursive: true, force: true }));

// The shared cases name the sets cases with external documents or a manifest; the mutations that need them read them from the cases.
const shared = readCases();
const setWith = (key: 'external' | 'manifest'): number => shared.sets.findIndex(c => Object.hasOwn(c, key));

/** An edit of a vector file: delete the value at a JSON Pointer, or set it. */
type Edit = ['delete', string] | ['set', string, unknown];
/** A mutation: the vector file it edits, the recipe file of that file when it is a recipe, the location and problem every runner reports, and the edit. */
type Mutation = { file: string; recipe?: string; location: string; problem: string; edit: Edit };

// Each case alters one vector file and sets the location and problem the runner must write to stderr. The recipe cases name the
// recipe file they edit; every runner reads the recipes beside cases.json, so their file is cases.
const mutations: Mutation[] = [
  { file: 'cases', location: 'hashes', problem: 'is not an array', edit: ['set', '/hashes', {}] },
  { file: 'cases', recipe: 'canonical.json', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'cases', recipe: 'canonical.json', location: 'cases[0].id', problem: 'is missing', edit: ['delete', '/cases/0/id'] },
  { file: 'cases', recipe: 'invalid.json', location: 'cases[0].steps[0].text', problem: 'is not an array', edit: ['set', '/cases/0/steps/0/text', 1] },
  { file: 'cases', recipe: 'canonical.json', location: 'cases[0].steps[0].text', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/text'] },
  { file: 'cases', recipe: 'normalize.json', location: 'cases[0].steps[0].text[1]', problem: 'is not a string', edit: ['set', '/cases/0/steps/0/text/1', 1] },
  { file: 'cases', recipe: 'normalize.json', location: 'cases[0].steps[0].crlf', problem: 'is not a boolean', edit: ['set', '/cases/0/steps/0/crlf', 'true'] },
  { file: 'cases', location: 'hashes[0].documents', problem: 'is missing', edit: ['delete', '/hashes/0/documents'] },
  { file: 'cases', location: 'sets', problem: 'is missing', edit: ['delete', '/sets'] },
  { file: 'cases', location: 'sets[0].documents[1]', problem: 'is not an array', edit: ['set', '/sets/0/documents/1', 'dbspec 1 shop'] },
  { file: 'cases', location: 'sets[0].documents[0][0]', problem: 'has no document name', edit: ['set', '/sets/0/documents/0/0', 'dbspec 1'] },
  { file: 'cases', location: 'sets[0].parsing', problem: 'is missing', edit: ['delete', '/sets/0/parsing'] },
  { file: 'cases', location: `sets[${setWith('external')}].external`, problem: 'is not an array', edit: ['set', `/sets/${setWith('external')}/external`, {}] },
  { file: 'cases', recipe: 'positions.json', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'cases', recipe: 'positions.json', location: 'cases[0].steps[0].text', problem: 'is not an array', edit: ['set', '/cases/0/steps/0/text', 1] },
  { file: 'cases', recipe: 'positions.json', location: 'cases[0].steps[0].text', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/text'] },
  // A section or field that the format does not name is refused in every section, as a missing one is.
  { file: 'cases', location: 'note', problem: 'is missing', edit: ['delete', '/note'] },
  { file: 'cases', location: 'extra', problem: 'is not a known field', edit: ['set', '/extra', []] },
  { file: 'cases', recipe: 'canonical.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'cases', recipe: 'normalize.json', location: 'cases[0].requirements', problem: 'is missing', edit: ['delete', '/cases/0/requirements'] },
  { file: 'cases', recipe: 'normalize.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'cases', recipe: 'invalid.json', location: 'cases[0].steps[0].expect.none.diagnostics', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/diagnostics'] },
  { file: 'cases', recipe: 'invalid.json', location: 'cases[0].steps[0].expect.none.diagnostics[0].rule', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/diagnostics/0/rule'] },
  { file: 'cases', recipe: 'invalid.json', location: 'cases[0].steps[0].expect.none.diagnostics[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/steps/0/expect/none/diagnostics/0/extra', 1] },
  { file: 'cases', location: 'hashes[0].schemaHash', problem: 'is missing', edit: ['delete', '/hashes/0/schemaHash'] },
  { file: 'cases', location: 'hashes[0].extra', problem: 'is not a known field', edit: ['set', '/hashes/0/extra', true] },
  { file: 'cases', location: 'sets[0].errors', problem: 'is missing', edit: ['delete', '/sets/0/errors'] },
  { file: 'cases', location: 'sets[0].extra', problem: 'is not a known field', edit: ['set', '/sets/0/extra', true] },
  { file: 'cases', location: `sets[${setWith('manifest')}].manifest.created`, problem: 'is missing', edit: ['delete', `/sets/${setWith('manifest')}/manifest/created`] },
  { file: 'cases', location: `sets[${setWith('manifest')}].manifest.extra`, problem: 'is not a known field', edit: ['set', `/sets/${setWith('manifest')}/manifest/extra`, []] },
  { file: 'cases', recipe: 'files.json', location: 'cases[0].steps[0].expect.none.errors', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/errors'] },
  { file: 'cases', recipe: 'files.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'cases', recipe: 'positions.json', location: 'cases[0].steps[0].expect.none.positions', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/positions'] },
  { file: 'cases', recipe: 'positions.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'cases', recipe: 'positions.json', location: 'cases[0].steps[0].expect.none.positions[0].line', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/positions/0/line'] },
  { file: 'cases', recipe: 'positions.json', location: 'cases[0].steps[0].expect.none.positions[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/steps/0/expect/none/positions/0/extra', 1] },
  { file: 'ddl', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'ddl', location: 'cases[0].id', problem: 'is missing', edit: ['delete', '/cases/0/id'] },
  { file: 'plans', location: 'chains', problem: 'is missing', edit: ['delete', '/chains'] },
  { file: 'plans', location: 'cases[0].source', problem: 'is missing', edit: ['delete', '/cases/0/source'] },
  { file: 'plans', location: 'invalid[0].plan', problem: 'is not an array', edit: ['set', '/invalid/0/plan', 'dbplan 1 a'] },
  { file: 'plans', location: 'chains[0].plans[0]', problem: 'is not an array', edit: ['set', '/chains/0/plans/0', null] },
  { file: 'plans', location: 'parse[0].id', problem: 'is missing', edit: ['delete', '/parse/0/id'] },
  { file: 'plans', location: 'comparisons', problem: 'is missing', edit: ['delete', '/comparisons'] },
  { file: 'plans', location: 'comparisons[0].target', problem: 'is not an array', edit: ['set', '/comparisons/0/target', 'dbspec 1 schema'] },
  { file: 'mermaid', location: 'round_trip', problem: 'is missing', edit: ['delete', '/round_trip'] },
  { file: 'mermaid', location: 'export[0].documents', problem: 'is missing', edit: ['delete', '/export/0/documents'] },
  { file: 'mermaid', location: 'import[0].mermaid', problem: 'is missing', edit: ['delete', '/import/0/mermaid'] },
  { file: 'mermaid', location: 'invalid[0].mermaid[0]', problem: 'is not a string', edit: ['set', '/invalid/0/mermaid/0', 0] },
  { file: 'syntax', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'syntax', location: 'cases[0]', problem: 'is not an object', edit: ['set', '/cases/0', 'canonical.x'] },
  { file: 'syntax', location: 'cases[0].id', problem: 'is not a string', edit: ['set', '/cases/0/id', 1] },
  { file: 'syntax', location: 'cases[1].id', problem: 'names no input of the shared cases', edit: ['set', '/cases/1/id', 'canonical.no-such-case'] },
  // Every runner reads every vector file through its schema (tests/dbspec/schema), so a rule of the schema that no
  // runner needs for its own output is refused in the same form as the others.
  { file: 'cases', recipe: 'invalid.json', location: 'cases', problem: 'is empty', edit: ['set', '/cases', []] },
  { file: 'cases', location: 'version', problem: 'is not 1', edit: ['set', '/version', 2] },
  { file: 'ddl', location: 'cases[0].statements', problem: 'is missing', edit: ['delete', '/cases/0/statements'] },
  { file: 'ddl', location: 'extra', problem: 'is not a known field', edit: ['set', '/extra', true] },
  { file: 'plans', location: 'cases[0].steps', problem: 'is missing', edit: ['delete', '/cases/0/steps'] },
  { file: 'plans', location: 'version', problem: 'is not 1', edit: ['set', '/version', 2] },
  { file: 'mermaid', location: 'export[0].dropped', problem: 'is not an array', edit: ['set', '/export/0/dropped', {}] },
  { file: 'mermaid', location: 'invalid[0].extra', problem: 'is not a known field', edit: ['set', '/invalid/0/extra', 1] },
  { file: 'syntax', location: 'cases[0].tokens', problem: 'is missing', edit: ['delete', '/cases/0/tokens'] },
  { file: 'syntax', location: 'cases[0].tokens[0][0]', problem: 'is not an integer', edit: ['set', '/cases/0/tokens/0/0', 'one'] },
];

// edit applies an edit to a parsed vector file: it walks the JSON Pointer to the container of the last segment, which must
// exist, and deletes or sets that segment there.
function edit(value: unknown, change: Edit): void {
  const [op, pointer] = change;
  const segments = pointer.split('/').slice(1);
  const last = segments.pop();
  let container = value;
  for (const segment of segments) {
    assert.ok(typeof container === 'object' && container !== null, `${pointer}: ${segment} is inside no object or array`);
    container = Reflect.get(container, segment);
  }
  assert.ok(last !== undefined && typeof container === 'object' && container !== null, `${pointer} names no value inside an object or array`);
  if (op === 'delete') assert.ok(Reflect.deleteProperty(container, last), `${pointer} cannot be deleted`);
  else assert.ok(Reflect.set(container, last, change[2]), `${pointer} cannot be set`);
}

// A file with several refusals is refused with one line for each, in every runner: a refused field does not hide the
// fields beside it, and the valid fields beside it are not reported.
const refusals: { file: string; problems: string[]; edits: Edit[] }[] = [
  { file: 'cases', problems: ['version is not 1', 'extra is not a known field'], edits: [['set', '/version', 2], ['set', '/extra', true]] },
];

// workspace copies every vector input of the compare runners into a directory of its own, with the recipe files and the files of
// the recipes beside cases.json, which the runners read from its directory. A mutation edits only its copy.
function workspace(index: number | string): string {
  const dir = join(directory, `${index}`);
  mkdirSync(dir);
  for (const name of [...files, ...recipes]) copyFileSync(join(root, `tests/dbspec/${name}.json`), join(dir, `${name}.json`));
  cpSync(join(root, 'tests/dbspec/files'), join(dir, 'files'), { recursive: true });
  return dir;
}

// inputsWith writes the altered vector file in the workspace of the mutation and returns the path of that file, its location, and the
// paths of the vector files in runner argument order.
function inputsWith(index: number | string, mutation: Mutation | { file: string; location: string; edits: Edit[] }): { path: string; location: string; inputs: string[] } {
  const dir = workspace(index);
  const name = 'recipe' in mutation && mutation.recipe !== undefined ? mutation.recipe : `${mutation.file}.json`;
  const path = join(dir, name);
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  for (const change of 'edits' in mutation ? mutation.edits : [mutation.edit]) edit(value, change);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return { path, location: mutation.location, inputs: [join(dir, 'cases.json'), stress ?? '', join(dir, 'ddl.json'), join(dir, 'plans.json'), join(dir, 'mermaid.json'), join(dir, 'syntax.json')] };
}

// Requirements: PAR-2.
caseTest('the unchanged vectors run in every runner', TIMEOUT, async () => {
  const inputs = [join(root, 'tests/dbspec/cases.json'), stress, ...['ddl', 'plans', 'mermaid', 'syntax'].map(name => join(root, `tests/dbspec/${name}.json`))];
  for (const runner of runners) {
    const result = await runRunner(runner, inputs, TIMEOUT);
    assert.equal(result.code, 0, `${runner.name}: ${result.stderr}`);
  }
});

// The runner rejects invalid vectors in the vector files it reads (reads in runners.mts).
mutations.forEach((mutation, index) => {
  const { path, location, inputs } = inputsWith(index, mutation);
  const target = mutation.recipe ?? mutation.file;
  for (const runner of runners.filter(runner => runner.reads.includes(mutation.file))) {
    caseTest(`${runner.name} rejects ${target} ${location} that ${mutation.problem}`, TIMEOUT, async () => {
      const result = await runRunner(runner, inputs, TIMEOUT);
      assert.notEqual(result.code, 0, `${runner.name} exited 0`);
      assert.equal(result.signal, null, `${runner.name} ended by ${result.signal}`);
      assert.ok(result.stderr.includes(`${path}: ${location} ${mutation.problem}`), `${runner.name} stderr: ${result.stderr}`);
    });
  }
});

refusals.forEach((refusal, index) => {
  const { path, inputs } = inputsWith(`refusals-${index}`, { file: refusal.file, location: '', edits: refusal.edits });
  for (const runner of runners.filter(runner => runner.reads.includes(refusal.file))) {
    caseTest(`${runner.name} reports every refusal of ${refusal.file}: ${refusal.problems.join(', ')}`, TIMEOUT, async () => {
      const result = await runRunner(runner, inputs, TIMEOUT);
      assert.notEqual(result.code, 0, `${runner.name} exited 0`);
      assert.equal(result.signal, null, `${runner.name} ended by ${result.signal}`);
      const lines = result.stderr.split('\n').filter(line => line.startsWith(`${path}: `));
      assert.deepEqual(lines.toSorted(), refusal.problems.map(problem => `${path}: ${problem}`).toSorted(), `${runner.name} stderr: ${result.stderr}`);
    });
  }
});
