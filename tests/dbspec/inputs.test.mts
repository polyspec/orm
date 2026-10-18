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
import { join } from 'node:path';
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
const missing = join(directory, 'missing.json');
const folder = join(directory, 'folder');
mkdirSync(folder);

const vector = (name: string) => join(root, `tests/dbspec/${name}.json`);
const compareInputs: string[] = [vector('cases'), stress, vector('ddl'), vector('plans'), vector('mermaid'), vector('syntax')];

// Writes the mermaid vector with only the path changed for the round trip case.
function mermaidWithPath(path: string): string {
  const value = readVectors(vector('mermaid'), 'mermaid');
  const [first] = value.round_trip;
  assert.ok(first, 'mermaid.json has a round trip case');
  first.path = path;
  const file = join(directory, `mermaid-${value.round_trip.length}-${path === missing ? 'missing' : 'folder'}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const applyRunners: Runner[] = [
  { name: 'apply go', command: 'go', args: ['run', './packages/go/internal/dbspec/apply'] },
  { name: 'apply php', command: 'php', args: ['packages/php/testing/dbspec/apply/php.php'] },
  { name: 'apply typescript', command: process.execPath, args: ['packages/ts/testing/dbspec/apply/typescript.mts'] },
  { name: 'apply rust', command: join(cargoTarget(), 'debug/examples/dbspec_apply'), args: [] },
];
const stressHarness: Runner = { name: 'stress rust', command: join(cargoTarget(), 'debug/examples/dbspec_stress'), args: [] };
// inputNames is the name, in INPUTS order, that the input uses in messages.
const inputNames: Record<string, string> = { cases: 'cases', stress: 'stress document', ddl: 'ddl', plans: 'plans', mermaid: 'mermaid', syntax: 'syntax' };

// Each case is the runner, its arguments, and the unreadable path that must appear on stderr.
const cases: { name: string; runner: Runner; inputs: string[]; unreadable: string }[] = [];
for (const unreadable of [missing, folder]) {
  const kind = unreadable === missing ? 'missing' : 'directory';
  // The runner accepts only the inputs it reads (reads in runners.mts).
  for (const runner of runners) {
    INPUTS.forEach((input, i) => {
      if (!runner.reads.includes(input)) return;
      const inputs = compareInputs.slice();
      inputs[i] = unreadable;
      cases.push({ name: `${runner.name} rejects a ${kind} ${inputNames[input] ?? input}`, runner, inputs, unreadable });
    });
    if (!runner.reads.includes('mermaid')) continue;
    const inputs = compareInputs.slice();
    inputs[INPUTS.indexOf('mermaid')] = mermaidWithPath(unreadable);
    cases.push({ name: `${runner.name} rejects a ${kind} round trip document`, runner, inputs, unreadable });
  }
  for (const runner of applyRunners) {
    const uri = `sqlite://${join(directory, 'apply.sqlite')}`;
    cases.push({ name: `${runner.name} rejects a ${kind} plans file`, runner, inputs: ['apply', 'sqlite', uri, unreadable], unreadable });
  }
  cases.push({ name: `${stressHarness.name} rejects a ${kind} document`, runner: stressHarness, inputs: [unreadable], unreadable });
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
  caseTest(c.name, TIMEOUT, async () => {
    const result = await runRunner(c.runner, c.inputs, TIMEOUT);
    assert.equal(result.signal, null, `ended by ${result.signal}`);
    assert.notEqual(result.code, 0, `exited 0; stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes(`${unsigned} is not a dbspec document`), `stderr does not reject ${unsigned}: ${result.stderr}`);
  });
}

for (const c of cases) {
  caseTest(c.name, TIMEOUT, async () => {
    const result = await runRunner(c.runner, c.inputs, TIMEOUT);
    assert.equal(result.signal, null, `ended by ${result.signal}`);
    assert.notEqual(result.code, 0, `exited 0; stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes(`${c.unreadable}: `), `stderr does not name ${c.unreadable}: ${result.stderr}`);
  });
}
