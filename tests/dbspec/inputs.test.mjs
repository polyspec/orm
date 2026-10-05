// tests/dbspec의 모든 runner와 Rust stress harness가 읽을 수 없는 input(없는 file,
// directory)을 그 경로와 0이 아닌 exit로, signature가 없는 stress 문서를 그 diagnostic
// message와 0이 아닌 exit로 거부하는지 확인한다.
//
// Usage: DBSPEC_STRESS_DOCUMENT=<stress document> node --test tests/dbspec/inputs.test.mjs
// (after the TypeScript build, the debug builds of the Rust dbspec_compare,
// dbspec_apply and dbspec_stress examples and the debug build of the PHP extension)
import { after } from 'node:test';
import { caseTest } from '../testcase.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cargoTarget } from '../cargo-target.mjs';
import { INPUTS, root, runRunner, runners } from './compare/runners.mjs';

// TIMEOUT은 case 하나의 기한이다. case는 runner process 하나를 없거나 directory인 input으로
// 실행하고, Go runner는 `go run` compile을 포함한다.
const TIMEOUT = 120000;
const stress = process.env.DBSPEC_STRESS_DOCUMENT;
if (stress === undefined || stress === '') throw new Error('DBSPEC_STRESS_DOCUMENT is required; run it through make dbspec-compare-check, which writes the stress document');

const directory = mkdtempSync(join(tmpdir(), 'dbspec-inputs-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const missing = join(directory, 'missing.json');
const folder = join(directory, 'folder');
mkdirSync(folder);

const vectors = ['cases', 'ddl', 'plans', 'mermaid'].map(name => join(root, `tests/dbspec/${name}.json`));
const compareInputs = [vectors[0], stress, vectors[1], vectors[2], vectors[3]];

// round trip case의 path만 바꾼 mermaid vector를 쓴다.
function mermaidWithPath(path) {
  const value = JSON.parse(readFileSync(vectors[3], 'utf8'));
  value.round_trip[0].path = path;
  const file = join(directory, `mermaid-${value.round_trip.length}-${path === missing ? 'missing' : 'folder'}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const applyRunners = [
  { name: 'apply go', command: 'go', args: ['run', './tests/dbspec/apply/go'] },
  { name: 'apply php', command: 'php', args: ['tests/dbspec/apply/php.php'] },
  { name: 'apply typescript', command: process.execPath, args: ['tests/dbspec/apply/typescript.mjs'] },
  { name: 'apply rust', command: join(cargoTarget(), 'debug/examples/dbspec_apply'), args: [] },
];
const stressHarness = { name: 'stress rust', command: join(cargoTarget(), 'debug/examples/dbspec_stress'), args: [] };
// inputNames는 INPUTS 순서의 input을 message에 쓰는 이름이다.
const inputNames = { cases: 'cases', stress: 'stress document', ddl: 'ddl', plans: 'plans', mermaid: 'mermaid' };

// 각 경우는 runner, 그 인자, 그리고 stderr에 나와야 할 읽을 수 없는 경로다.
const cases = [];
for (const unreadable of [missing, folder]) {
  const kind = unreadable === missing ? 'missing' : 'directory';
  // runner는 자기가 읽는 input(runners.mjs의 reads)만 받는다. PHP 확장 runner는 plan과 Mermaid vector를 읽지 않는다.
  for (const runner of runners) {
    INPUTS.forEach((input, i) => {
      if (!runner.reads.includes(input)) return;
      const inputs = compareInputs.slice();
      inputs[i] = unreadable;
      cases.push({ name: `${runner.name} rejects a ${kind} ${inputNames[input]}`, runner, inputs, unreadable });
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

// signature가 없는 stress 문서는 parse하지 않고 "<path> is not a dbspec document"로 거부한다.
const unsigned = join(root, 'tests/dbspec/files/dbschema.dbs');
const signatureCases = runners.map(runner => {
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
