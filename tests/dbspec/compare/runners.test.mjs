// 모든 dbspec compare runner가 없거나 type이 다른 vector section, id, document,
// line을 위치를 밝힌 error와 nonzero exit로 거부하는지 확인한다.
//
// Usage: DBSPEC_STRESS_DOCUMENT=<stress document> node --test tests/dbspec/compare/runners.test.mjs
// (after the TypeScript build and the release build of the Rust example)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, runRunner, runners } from './runners.mjs';

const TIMEOUT = 120000;
const stress = process.env.DBSPEC_STRESS_DOCUMENT;
if (stress === undefined || stress === '') throw new Error('DBSPEC_STRESS_DOCUMENT is required');

const files = ['cases', 'ddl', 'plans', 'mermaid'];
const vectors = Object.fromEntries(files.map(name => [name, readFileSync(join(root, `tests/dbspec/${name}.json`), 'utf8')]));
const directory = mkdtempSync(join(tmpdir(), 'dbspec-compare-runners-'));
after(() => rmSync(directory, { recursive: true, force: true }));

// 각 경우는 vector file 하나를 고치고, runner가 stderr에 써야 할 위치와 문제를 정한다.
const mutations = [
  { file: 'cases', location: 'canonical', problem: 'is missing', change: v => delete v.canonical },
  { file: 'cases', location: 'hashes', problem: 'is not an array', change: v => (v.hashes = {}) },
  { file: 'cases', location: 'canonical[0].id', problem: 'is missing', change: v => delete v.canonical[0].id },
  { file: 'cases', location: 'invalid[0].main', problem: 'is not a string', change: v => (v.invalid[0].main = 1) },
  {
    file: 'cases',
    location: v => `canonical[0].documents.${v.canonical[0].main}`,
    problem: 'is missing',
    change: v => delete v.canonical[0].documents[v.canonical[0].main],
  },
  {
    file: 'cases',
    location: v => `normalize[0].documents.${v.normalize[0].main}[1]`,
    problem: 'is not a string',
    change: v => (v.normalize[0].documents[v.normalize[0].main][1] = 1),
  },
  { file: 'cases', location: 'normalize[0].crlf', problem: 'is not a boolean', change: v => (v.normalize[0].crlf = 'true') },
  { file: 'cases', location: 'hashes[0].documents', problem: 'is missing', change: v => delete v.hashes[0].documents },
  { file: 'ddl', location: 'cases', problem: 'is missing', change: v => delete v.cases },
  { file: 'ddl', location: 'cases[0].id', problem: 'is missing', change: v => delete v.cases[0].id },
  { file: 'plans', location: 'chains', problem: 'is missing', change: v => delete v.chains },
  { file: 'plans', location: 'cases[0].source', problem: 'is missing', change: v => delete v.cases[0].source },
  { file: 'plans', location: 'invalid[0].plan', problem: 'is not an array', change: v => (v.invalid[0].plan = 'dbplan 1 a') },
  { file: 'plans', location: 'chains[0].plans[0]', problem: 'is not an array', change: v => (v.chains[0].plans[0] = null) },
  { file: 'plans', location: 'parse[0].id', problem: 'is missing', change: v => delete v.parse[0].id },
  { file: 'plans', location: 'comparisons', problem: 'is missing', change: v => delete v.comparisons },
  { file: 'plans', location: 'comparisons[0].target', problem: 'is not an array', change: v => (v.comparisons[0].target = 'dbspec 1 schema') },
  { file: 'mermaid', location: 'round_trip', problem: 'is missing', change: v => delete v.round_trip },
  { file: 'mermaid', location: 'export[0].documents', problem: 'is missing', change: v => delete v.export[0].documents },
  { file: 'mermaid', location: 'import[0].mermaid', problem: 'is missing', change: v => delete v.import[0].mermaid },
  { file: 'mermaid', location: 'invalid[0].mermaid[0]', problem: 'is not a string', change: v => (v.invalid[0].mermaid[0] = 0) },
];

// inputsWith는 바뀐 vector file을 쓰고, 그 file과 나머지 원래 vector file의 경로를 runner 인자 순서로 돌려준다.
function inputsWith(index, mutation) {
  const value = JSON.parse(vectors[mutation.file]);
  const location = typeof mutation.location === 'function' ? mutation.location(value) : mutation.location;
  mutation.change(value);
  const path = join(directory, `${index}-${mutation.file}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  const paths = Object.fromEntries(files.map(name => [name, name === mutation.file ? path : join(root, `tests/dbspec/${name}.json`)]));
  return { path, location, inputs: [paths.cases, stress, paths.ddl, paths.plans, paths.mermaid] };
}

test('the unchanged vectors run in every runner', { timeout: TIMEOUT }, async () => {
  const inputs = [join(root, 'tests/dbspec/cases.json'), stress, ...['ddl', 'plans', 'mermaid'].map(name => join(root, `tests/dbspec/${name}.json`))];
  for (const runner of runners) {
    const result = await runRunner(runner, inputs, TIMEOUT);
    assert.equal(result.code, 0, `${runner.name}: ${result.stderr}`);
  }
});

mutations.forEach((mutation, index) => {
  const { path, location, inputs } = inputsWith(index, mutation);
  for (const runner of runners) {
    test(`${runner.name} rejects ${mutation.file} ${location} that ${mutation.problem}`, { timeout: TIMEOUT }, async () => {
      const result = await runRunner(runner, inputs, TIMEOUT);
      assert.notEqual(result.code, 0, `${runner.name} exited 0`);
      assert.equal(result.signal, null, `${runner.name} ended by ${result.signal}`);
      assert.ok(result.stderr.includes(`${path}: ${location} ${mutation.problem}`), `${runner.name} stderr: ${result.stderr}`);
    });
  }
});
