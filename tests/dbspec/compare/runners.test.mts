// Checks that every dbspec compare runner rejects, with an error stating the location and a nonzero exit, a vector file it reads whose vector section, id, document,
// or line is missing or of another type. A recipe file of tests/dbspec (canonical, normalize, invalid, positions, files, hashes and sets) is refused
// too for a field that the format does not name. A mutation of a recipe edits a copy of that recipe in a directory of its own, which the runners read as their directory.
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

// TIMEOUT is the deadline for one case. A case runs the Go, PHP, TypeScript, Rust, and PHP extension runner processes on one vector file,
// and the Go runner includes the `go run` compile.
const TIMEOUT = 120000;
const stress = process.env.DBSPEC_STRESS_DOCUMENT;
if (stress === undefined || stress === '') throw new Error('DBSPEC_STRESS_DOCUMENT is required; run it through make dbspec-compare-check, which writes the stress document');

const files = ['ddl', 'plan-cases', 'mermaid'];
// The recipe files of tests/dbspec: the document cases and the set analyses. Every runner reads them from the directory it is given.
const recipes = ['canonical', 'normalize', 'invalid', 'positions', 'files', 'hashes', 'sets'];
const directory = mkdtempSync(join(tmpdir(), 'dbspec-compare-runners-'));
after(() => rmSync(directory, { recursive: true, force: true }));
// The runners read the cases and the validation sections of plan-cases.json from the recipes beside it, and the physical
// records from plans-physical.json, so every workspace has those beside its plan-cases.json too.
const planRecipes = ['plan-invalid', 'plan-chains', 'plan-parse', 'plan-comparisons', 'plans-physical'];


/** An edit of a vector file: delete the value at a JSON Pointer, or set it. */
type Edit = ['delete', string] | ['set', string, unknown];
/** A mutation: the input it edits (dir for a recipe, named by recipe), the location and problem every runner reports, and the edit. */
type Mutation = { file: string; recipe?: string; location: string; problem: string; edit: Edit };

// Each case alters one vector file and sets the location and problem the runner must write to stderr. The recipe cases name the
// recipe file they edit; every runner reads the recipes of its directory, so their file is dir.
const mutations: Mutation[] = [
  { file: 'dir', recipe: 'canonical.json', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'dir', recipe: 'canonical.json', location: 'cases[0].id', problem: 'is missing', edit: ['delete', '/cases/0/id'] },
  { file: 'dir', recipe: 'invalid.json', location: 'cases[0].steps[0].text', problem: 'is not an array', edit: ['set', '/cases/0/steps/0/text', 1] },
  { file: 'dir', recipe: 'canonical.json', location: 'cases[0].steps[0].text', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/text'] },
  { file: 'dir', recipe: 'normalize.json', location: 'cases[0].steps[0].text[1]', problem: 'is not a string', edit: ['set', '/cases/0/steps/0/text/1', 1] },
  { file: 'dir', recipe: 'normalize.json', location: 'cases[0].steps[0].crlf', problem: 'is not a boolean', edit: ['set', '/cases/0/steps/0/crlf', 'true'] },
  { file: 'dir', recipe: 'positions.json', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'dir', recipe: 'positions.json', location: 'cases[0].steps[0].text', problem: 'is not an array', edit: ['set', '/cases/0/steps/0/text', 1] },
  { file: 'dir', recipe: 'positions.json', location: 'cases[0].steps[0].text', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/text'] },
  // A section or field that the format does not name is refused in every section, as a missing one is.
  { file: 'dir', recipe: 'canonical.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'dir', recipe: 'normalize.json', location: 'cases[0].requirements', problem: 'is missing', edit: ['delete', '/cases/0/requirements'] },
  { file: 'dir', recipe: 'normalize.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'dir', recipe: 'invalid.json', location: 'cases[0].steps[0].expect.none.diagnostics', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/diagnostics'] },
  { file: 'dir', recipe: 'invalid.json', location: 'cases[0].steps[0].expect.none.diagnostics[0].rule', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/diagnostics/0/rule'] },
  { file: 'dir', recipe: 'invalid.json', location: 'cases[0].steps[0].expect.none.diagnostics[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/steps/0/expect/none/diagnostics/0/extra', 1] },
  { file: 'dir', recipe: 'files.json', location: 'cases[0].steps[0].expect.none.errors', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/errors'] },
  { file: 'dir', recipe: 'files.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'dir', recipe: 'positions.json', location: 'cases[0].steps[0].expect.none.positions', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/positions'] },
  { file: 'dir', recipe: 'positions.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'dir', recipe: 'positions.json', location: 'cases[0].steps[0].expect.none.positions[0].line', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect/none/positions/0/line'] },
  { file: 'dir', recipe: 'positions.json', location: 'cases[0].steps[0].expect.none.positions[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/steps/0/expect/none/positions/0/extra', 1] },
  { file: 'ddl', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'ddl', location: 'cases[0].id', problem: 'is missing', edit: ['delete', '/cases/0/id'] },
  { file: 'plan-cases', location: 'requirements', problem: 'is missing', edit: ['delete', '/requirements'] },
  { file: 'plan-cases', location: 'cases', problem: 'is not a known field', edit: ['set', '/cases', []] },
  { file: 'mermaid', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'mermaid', location: 'cases[0].steps', problem: 'is missing', edit: ['delete', '/cases/0/steps'] },
  { file: 'mermaid', location: 'cases[0].steps[0].expect', problem: 'is missing', edit: ['delete', '/cases/0/steps/0/expect'] },
  { file: 'mermaid', location: 'cases[0].id', problem: 'is not a string', edit: ['set', '/cases/0/id', 1] },
  // Every runner reads every vector file through its schema (tests/dbspec/schema), so a rule of the schema that no
  // runner needs for its own output is refused in the same form as the others.
  { file: 'dir', recipe: 'invalid.json', location: 'cases', problem: 'is empty', edit: ['set', '/cases', []] },
  { file: 'ddl', location: 'cases[0].statements', problem: 'is missing', edit: ['delete', '/cases/0/statements'] },
  { file: 'ddl', location: 'extra', problem: 'is not a known field', edit: ['set', '/extra', true] },
  { file: 'plan-cases', location: 'version', problem: 'is not 1', edit: ['set', '/version', 2] },
  { file: 'dir', recipe: 'hashes.json', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'dir', recipe: 'hashes.json', location: 'cases[0].id', problem: 'is missing', edit: ['delete', '/cases/0/id'] },
  { file: 'dir', recipe: 'hashes.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'dir', recipe: 'hashes.json', location: 'extra', problem: 'is not a known field', edit: ['set', '/extra', true] },
  { file: 'dir', recipe: 'sets.json', location: 'cases', problem: 'is missing', edit: ['delete', '/cases'] },
  { file: 'dir', recipe: 'sets.json', location: 'cases[0].id', problem: 'is missing', edit: ['delete', '/cases/0/id'] },
  { file: 'dir', recipe: 'sets.json', location: 'cases[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/extra', true] },
  { file: 'dir', recipe: 'sets.json', location: 'extra', problem: 'is not a known field', edit: ['set', '/extra', true] },
  { file: 'mermaid', location: 'cases[0].steps[0].extra', problem: 'is not a known field', edit: ['set', '/cases/0/steps/0/extra', 1] },
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
const refusals: { file: string; recipe: string; problems: string[]; edits: Edit[] }[] = [
  { file: 'dir', recipe: 'hashes.json', problems: ['extra is not a known field', 'cases is missing'], edits: [['set', '/extra', true], ['delete', '/cases']] },
];

// workspace copies every vector input of the compare runners into a directory of its own, with the recipe files and the files of
// the recipes, which the runners read from that directory. A mutation edits only its copy.
function workspace(index: number | string): string {
  const dir = join(directory, `${index}`);
  mkdirSync(dir);
  for (const name of [...files, ...recipes, ...planRecipes]) copyFileSync(join(root, `tests/dbspec/${name}.json`), join(dir, `${name}.json`));
  cpSync(join(root, 'tests/dbspec/files'), join(dir, 'files'), { recursive: true });
  return dir;
}

// inputsWith writes the altered vector file in the workspace of the mutation and returns the path of that file, its location, and the
// paths of the vector files in runner argument order.
function inputsWith(index: number | string, mutation: Mutation | { file: string; recipe: string; location: string; edits: Edit[] }): { path: string; location: string; inputs: string[] } {
  const dir = workspace(index);
  const name = mutation.recipe ?? `${mutation.file}.json`;
  const path = join(dir, name);
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  for (const change of 'edits' in mutation ? mutation.edits : [mutation.edit]) edit(value, change);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return { path, location: mutation.location, inputs: [dir, stress ?? '', join(dir, 'ddl.json'), join(dir, 'plan-cases.json'), join(dir, 'mermaid.json')] };
}

// Requirements: PAR-2.
caseTest('the unchanged vectors run in every runner', TIMEOUT, async () => {
  const inputs = [join(root, 'tests/dbspec'), stress, ...['ddl', 'plan-cases', 'mermaid'].map(name => join(root, `tests/dbspec/${name}.json`))];
  for (const runner of runners) {
    const result = await runRunner(runner, inputs, TIMEOUT);
    assert.equal(result.code, 0, `${runner.name}: ${result.stderr}`);
  }
});

// plan-cases.json holds the note and the requirements. Its cases are the recipe plan-cases.json, and its physical records are
// plans-physical.json; the validation sections are recipes beside it. Their shape is the recipe schema's
// (scripts/features/schema/recipe.schema.json), which readPlanCases checks in every runner, and the plans mutations above cover
// plan-cases.json itself.
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
  const { path, inputs } = inputsWith(`refusals-${index}`, { file: refusal.file, recipe: refusal.recipe, location: '', edits: refusal.edits });
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
