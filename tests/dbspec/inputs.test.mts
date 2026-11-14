// Checks that all tests/dbspec runners and the Rust stress harness reject unreadable inputs (a missing file,
// directory) with that path and a nonzero exit, and a stress document without a signature with its diagnostic
// message and a nonzero exit.
//
// Usage: DBSPEC_STRESS_DOCUMENT=<stress document> node --test tests/dbspec/inputs.test.mts
// (after the TypeScript build, the debug builds of the Rust dbspec_compare,
// dbspec_apply and dbspec_stress examples and the build of the PHP extension)
import { after } from 'node:test';
import { caseTest } from '../testcase.mts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { cargoTarget } from '../cargo-target.mts';
import { INPUTS, root, runRunner, runners, type Runner } from './compare/runners.mts';
import { readVectors } from './vectors.mts';

// TIMEOUT is the deadline for one case. A case runs one runner process on a missing or directory input,
// and the Go runner includes the `go run` compile.
const TIMEOUT = 120000;
const stress = process.env.DBSPEC_STRESS_DOCUMENT;
if (stress === undefined || stress === '') throw new Error('DBSPEC_STRESS_DOCUMENT is required; run it through make dbspec-compare-check, which writes the stress document');

const directory = mkdtempSync(join(tmpdir(), 'dbspec-inputs-'));
after(() => rmSync(directory, { recursive: true, force: true }));
// The .dbs names keep the unreadable documents of the round trip step valid against the recipe schema (its path ends in .dbs).
const missing = join(directory, 'missing.dbs');
const folder = join(directory, 'folder.dbs');
mkdirSync(folder);

const vector = (name: string) => join(root, `tests/dbspec/${name}.json`);
const compareInputs: string[] = [join(root, 'tests/dbspec'), stress, vector('ddl'), vector('plan-cases'), vector('mermaid')];

// Writes the Mermaid recipe with only the document file of its first export that has one changed to path. The recipe is
// copied into the directory of the unreadable path, so the path is written relative to the copy, as the recipe takes its
// paths.
function mermaidWithPath(path: string): string {
  const value = readVectors(vector('mermaid'), 'mermaid');
  const step = value.cases.flatMap(c => c.steps).find(s => s.op === 'dbspec.export_mermaid' && s.document !== undefined);
  assert.ok(step, 'mermaid.json has an export of a document file');
  step.document = relative(directory, path);
  const file = join(directory, `mermaid-${path === missing ? 'missing' : 'folder'}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const applyRunners: Runner[] = [
  { name: 'apply go', command: 'go', args: ['run', './legacy/packages/go/internal/dbspec/apply'] },
  { name: 'apply php', command: 'php', args: ['legacy/packages/php/testing/dbspec/apply/php.php'] },
  { name: 'apply typescript', command: process.execPath, args: ['legacy/packages/ts/testing/dbspec/apply/typescript.mts'] },
  { name: 'apply rust', command: join(cargoTarget(), 'debug/examples/dbspec_apply'), args: [] },
];
const stressHarness: Runner = { name: 'stress rust', command: join(cargoTarget(), 'debug/examples/dbspec_stress'), args: [] };
// inputNames is the name, in INPUTS order, that the input uses in messages.
const inputNames: Record<string, string> = { dir: 'recipes directory', stress: 'stress document', ddl: 'ddl', plans: 'plans', mermaid: 'mermaid' };

// Each case is the runner, its arguments, and the text naming the unreadable path that must appear on stderr: "<path>: ". The
// recipes directory given as an empty directory is a directory, so the runner names the first recipe file of it that it
// cannot read: "<path>/".
const cases: { name: string; runner: Runner; inputs: string[]; named: string }[] = [];
for (const unreadable of [missing, folder]) {
  const kind = unreadable === missing ? 'missing' : 'directory';
  // The runner accepts only the inputs it reads (reads in runners.mts).
  for (const runner of runners) {
    INPUTS.forEach((input, i) => {
      if (!runner.reads.includes(input)) return;
      const inputs = compareInputs.slice();
      inputs[i] = unreadable;
      const named = input === 'dir' && unreadable === folder ? `${unreadable}/` : `${unreadable}: `;
      cases.push({ name: `${runner.name} rejects a ${kind} ${inputNames[input] ?? input}`, runner, inputs, named });
    });
    if (!runner.reads.includes('mermaid')) continue;
    const inputs = compareInputs.slice();
    inputs[INPUTS.indexOf('mermaid')] = mermaidWithPath(unreadable);
    cases.push({ name: `${runner.name} rejects a ${kind} round trip document`, runner, inputs, named: `${unreadable}: ` });
  }
  for (const runner of applyRunners) {
    const uri = `sqlite://${join(directory, 'apply.sqlite')}`;
    cases.push({ name: `${runner.name} rejects a ${kind} plans file`, runner, inputs: ['apply', 'sqlite', uri, unreadable], named: `${unreadable}: ` });
  }
  cases.push({ name: `${stressHarness.name} rejects a ${kind} document`, runner: stressHarness, inputs: [unreadable], named: `${unreadable}: ` });
}

// A stress document without a signature is not parsed; it is rejected with "<path> is not a dbspec document".
const unsigned = join(root, 'tests/dbspec/files/dbschema.dbs');
const signatureCases: { name: string; runner: Runner; inputs: string[] }[] = runners.map(runner => {
  const inputs = compareInputs.slice();
  inputs[1] = unsigned;
  return { name: `${runner.name} rejects a stress document without the signature`, runner, inputs };
});
signatureCases.push({ name: `${stressHarness.name} rejects a document without the signature`, runner: stressHarness, inputs: [unsigned] });
for (const c of signatureCases) {
  caseTest(c.name, async () => {
    const result = await runRunner(c.runner, c.inputs, TIMEOUT);
    assert.equal(result.signal, null, `ended by ${result.signal}`);
    assert.notEqual(result.code, 0, `exited 0; stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes(`${unsigned} is not a dbspec document`), `stderr does not reject ${unsigned}: ${result.stderr}`);
  });
}

for (const c of cases) {
  caseTest(c.name, async () => {
    const result = await runRunner(c.runner, c.inputs, TIMEOUT);
    assert.equal(result.signal, null, `ended by ${result.signal}`);
    assert.notEqual(result.code, 0, `exited 0; stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes(c.named), `stderr does not name ${c.named}: ${result.stderr}`);
  });
}
