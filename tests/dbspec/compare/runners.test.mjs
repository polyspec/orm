// 모든 dbspec compare runner가 자기가 읽는 vector file의 없거나 type이 다른 vector section, id, document,
// line을 위치를 밝힌 error와 nonzero exit로 거부하는지 확인한다. In cases.json a section or field that the format does
// not name is refused too.
//
// Usage: DBSPEC_STRESS_DOCUMENT=<stress document> node --test tests/dbspec/compare/runners.test.mjs
// (after the TypeScript build, the debug build of the Rust example and the build of the PHP extension)
import { after } from 'node:test';
import { caseTest } from '../../testcase.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, runRunner, runners } from './runners.mjs';

// TIMEOUT은 case 하나의 기한이다. case는 Go, PHP, TypeScript, Rust, PHP 확장 runner process를 vector file 하나로
// 실행하고, Go runner는 `go run` compile을 포함한다.
const TIMEOUT = 120000;
const stress = process.env.DBSPEC_STRESS_DOCUMENT;
if (stress === undefined || stress === '') throw new Error('DBSPEC_STRESS_DOCUMENT is required; run it through make dbspec-compare-check, which writes the stress document');

const files = ['cases', 'ddl', 'plans', 'mermaid', 'syntax'];
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
  { file: 'cases', location: 'sets', problem: 'is missing', change: v => delete v.sets },
  { file: 'cases', location: 'sets[0].documents[1]', problem: 'is not an array', change: v => (v.sets[0].documents[1] = 'dbspec 1 shop') },
  { file: 'cases', location: 'sets[0].documents[0][0]', problem: 'has no document name', change: v => (v.sets[0].documents[0][0] = 'dbspec 1') },
  { file: 'cases', location: 'sets[0].parsing', problem: 'is missing', change: v => delete v.sets[0].parsing },
  {
    file: 'cases',
    location: v => `sets[${v.sets.findIndex(c => Object.hasOwn(c, 'external'))}].external`,
    problem: 'is not an array',
    change: v => (v.sets.find(c => Object.hasOwn(c, 'external')).external = {}),
  },
  { file: 'cases', location: 'positions', problem: 'is missing', change: v => delete v.positions },
  { file: 'cases', location: 'positions[0].main', problem: 'is not a string', change: v => (v.positions[0].main = 1) },
  {
    file: 'cases',
    location: v => `positions[0].documents.${v.positions[0].main}`,
    problem: 'is missing',
    change: v => delete v.positions[0].documents[v.positions[0].main],
  },
  // A section or field that the format does not name is refused in every section, as a missing one is.
  { file: 'cases', location: 'note', problem: 'is missing', change: v => delete v.note },
  { file: 'cases', location: 'extra', problem: 'is not a known field', change: v => (v.extra = []) },
  { file: 'cases', location: 'canonical[0].extra', problem: 'is not a known field', change: v => (v.canonical[0].extra = true) },
  { file: 'cases', location: 'normalize[0].canonical', problem: 'is missing', change: v => delete v.normalize[0].canonical },
  { file: 'cases', location: 'normalize[0].extra', problem: 'is not a known field', change: v => (v.normalize[0].extra = true) },
  { file: 'cases', location: 'invalid[0].errors', problem: 'is missing', change: v => delete v.invalid[0].errors },
  { file: 'cases', location: 'invalid[0].errors[0].rule', problem: 'is missing', change: v => delete v.invalid[0].errors[0].rule },
  { file: 'cases', location: 'invalid[0].errors[0].extra', problem: 'is not a known field', change: v => (v.invalid[0].errors[0].extra = 1) },
  { file: 'cases', location: 'hashes[0].schemaHash', problem: 'is missing', change: v => delete v.hashes[0].schemaHash },
  { file: 'cases', location: 'hashes[0].extra', problem: 'is not a known field', change: v => (v.hashes[0].extra = true) },
  { file: 'cases', location: 'sets[0].errors', problem: 'is missing', change: v => delete v.sets[0].errors },
  { file: 'cases', location: 'sets[0].extra', problem: 'is not a known field', change: v => (v.sets[0].extra = true) },
  {
    file: 'cases',
    location: v => `sets[${v.sets.findIndex(c => Object.hasOwn(c, 'manifest'))}].manifest.created`,
    problem: 'is missing',
    change: v => delete v.sets.find(c => Object.hasOwn(c, 'manifest')).manifest.created,
  },
  {
    file: 'cases',
    location: v => `sets[${v.sets.findIndex(c => Object.hasOwn(c, 'manifest'))}].manifest.extra`,
    problem: 'is not a known field',
    change: v => (v.sets.find(c => Object.hasOwn(c, 'manifest')).manifest.extra = []),
  },
  { file: 'cases', location: 'files[0].errors', problem: 'is missing', change: v => delete v.files[0].errors },
  { file: 'cases', location: 'files[0].extra', problem: 'is not a known field', change: v => (v.files[0].extra = true) },
  { file: 'cases', location: 'positions[0].positions', problem: 'is missing', change: v => delete v.positions[0].positions },
  { file: 'cases', location: 'positions[0].extra', problem: 'is not a known field', change: v => (v.positions[0].extra = true) },
  { file: 'cases', location: 'positions[0].positions[0].line', problem: 'is missing', change: v => delete v.positions[0].positions[0].line },
  { file: 'cases', location: 'positions[0].positions[0].extra', problem: 'is not a known field', change: v => (v.positions[0].positions[0].extra = 1) },
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
  { file: 'syntax', location: 'cases', problem: 'is missing', change: v => delete v.cases },
  { file: 'syntax', location: 'cases[0]', problem: 'is not an object', change: v => (v.cases[0] = 'canonical/x') },
  { file: 'syntax', location: 'cases[0].id', problem: 'is not a string', change: v => (v.cases[0].id = 1) },
  { file: 'syntax', location: 'cases[1].id', problem: 'names no input of the shared cases', change: v => (v.cases[1].id = 'canonical/no-such-case') },
];

// inputsWith는 바뀐 vector file을 쓰고, 그 file과 나머지 원래 vector file의 경로를 runner 인자 순서로 돌려준다.
function inputsWith(index, mutation) {
  const value = JSON.parse(vectors[mutation.file]);
  const location = typeof mutation.location === 'function' ? mutation.location(value) : mutation.location;
  mutation.change(value);
  const path = join(directory, `${index}-${mutation.file}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  const paths = Object.fromEntries(files.map(name => [name, name === mutation.file ? path : join(root, `tests/dbspec/${name}.json`)]));
  return { path, location, inputs: [paths.cases, stress, paths.ddl, paths.plans, paths.mermaid, paths.syntax] };
}

caseTest('the unchanged vectors run in every runner', TIMEOUT, async () => {
  const inputs = [join(root, 'tests/dbspec/cases.json'), stress, ...['ddl', 'plans', 'mermaid', 'syntax'].map(name => join(root, `tests/dbspec/${name}.json`))];
  for (const runner of runners) {
    const result = await runRunner(runner, inputs, TIMEOUT);
    assert.equal(result.code, 0, `${runner.name}: ${result.stderr}`);
  }
});

// runner는 자기가 읽는 vector file(runners.mjs의 reads)의 잘못된 vector를 거부한다.
mutations.forEach((mutation, index) => {
  const { path, location, inputs } = inputsWith(index, mutation);
  for (const runner of runners.filter(runner => runner.reads.includes(mutation.file))) {
    caseTest(`${runner.name} rejects ${mutation.file} ${location} that ${mutation.problem}`, TIMEOUT, async () => {
      const result = await runRunner(runner, inputs, TIMEOUT);
      assert.notEqual(result.code, 0, `${runner.name} exited 0`);
      assert.equal(result.signal, null, `${runner.name} ended by ${result.signal}`);
      assert.ok(result.stderr.includes(`${path}: ${location} ${mutation.problem}`), `${runner.name} stderr: ${result.stderr}`);
    });
  }
});
