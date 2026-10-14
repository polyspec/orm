// 모든 dbspec compare runner가 자기가 읽는 vector file의 없거나 type이 다른 vector section, id, document,
// line을 위치를 밝힌 error와 nonzero exit로 거부하는지 확인한다. In cases.json a section or field that the format does
// not name is refused too.
//
// Usage: DBSPEC_STRESS_DOCUMENT=<stress document> node --test tests/dbspec/compare/runners.test.mts
// (after the TypeScript build, the debug build of the Rust example and the build of the PHP extension)
import { after } from 'node:test';
import { caseTest } from '../../testcase.mts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, runRunner, runners } from './runners.mts';
import { readCases } from '../cases.mts';

// TIMEOUT은 case 하나의 기한이다. case는 Go, PHP, TypeScript, Rust, PHP 확장 runner process를 vector file 하나로
// 실행하고, Go runner는 `go run` compile을 포함한다.
const TIMEOUT = 120000;
const stress = process.env.DBSPEC_STRESS_DOCUMENT;
if (stress === undefined || stress === '') throw new Error('DBSPEC_STRESS_DOCUMENT is required; run it through make dbspec-compare-check, which writes the stress document');

const files = ['cases', 'ddl', 'plans', 'mermaid', 'syntax'];
const vectors = Object.fromEntries(files.map(name => [name, readFileSync(join(root, `tests/dbspec/${name}.json`), 'utf8')]));
const directory = mkdtempSync(join(tmpdir(), 'dbspec-compare-runners-'));
after(() => rmSync(directory, { recursive: true, force: true }));

// The shared cases name the main document of each case and the sets cases with external documents or a manifest; the
// mutations that need them read them from the cases.
const shared = readCases();
const main = (section: 'canonical' | 'normalize' | 'positions'): string => shared[section][0]?.main ?? '';
const setWith = (key: 'external' | 'manifest'): number => shared.sets.findIndex(c => Object.hasOwn(c, key));

/** An edit of a vector file: delete the value at a JSON Pointer, or set it. */
type Edit = ['delete', string] | ['set', string, unknown];
/** A mutation: the vector file it edits, the location and problem every runner reports, and the edit. */
type Mutation = { file: string; location: string; problem: string; edit: Edit };

// 각 경우는 vector file 하나를 고치고, runner가 stderr에 써야 할 위치와 문제를 정한다.
const mutations: Mutation[] = [
  { file: 'cases', location: 'canonical', problem: 'is missing', edit: ['delete', '/canonical'] },
  { file: 'cases', location: 'hashes', problem: 'is not an array', edit: ['set', '/hashes', {}] },
  { file: 'cases', location: 'canonical[0].id', problem: 'is missing', edit: ['delete', '/canonical/0/id'] },
  { file: 'cases', location: 'invalid[0].main', problem: 'is not a string', edit: ['set', '/invalid/0/main', 1] },
  { file: 'cases', location: `canonical[0].documents.${main('canonical')}`, problem: 'is missing', edit: ['delete', `/canonical/0/documents/${main('canonical')}`] },
  { file: 'cases', location: `normalize[0].documents.${main('normalize')}[1]`, problem: 'is not a string', edit: ['set', `/normalize/0/documents/${main('normalize')}/1`, 1] },
  { file: 'cases', location: 'normalize[0].crlf', problem: 'is not a boolean', edit: ['set', '/normalize/0/crlf', 'true'] },
  { file: 'cases', location: 'hashes[0].documents', problem: 'is missing', edit: ['delete', '/hashes/0/documents'] },
  { file: 'cases', location: 'sets', problem: 'is missing', edit: ['delete', '/sets'] },
  { file: 'cases', location: 'sets[0].documents[1]', problem: 'is not an array', edit: ['set', '/sets/0/documents/1', 'dbspec 1 shop'] },
  { file: 'cases', location: 'sets[0].documents[0][0]', problem: 'has no document name', edit: ['set', '/sets/0/documents/0/0', 'dbspec 1'] },
  { file: 'cases', location: 'sets[0].parsing', problem: 'is missing', edit: ['delete', '/sets/0/parsing'] },
  { file: 'cases', location: `sets[${setWith('external')}].external`, problem: 'is not an array', edit: ['set', `/sets/${setWith('external')}/external`, {}] },
  { file: 'cases', location: 'positions', problem: 'is missing', edit: ['delete', '/positions'] },
  { file: 'cases', location: 'positions[0].main', problem: 'is not a string', edit: ['set', '/positions/0/main', 1] },
  { file: 'cases', location: `positions[0].documents.${main('positions')}`, problem: 'is missing', edit: ['delete', `/positions/0/documents/${main('positions')}`] },
  // A section or field that the format does not name is refused in every section, as a missing one is.
  { file: 'cases', location: 'note', problem: 'is missing', edit: ['delete', '/note'] },
  { file: 'cases', location: 'extra', problem: 'is not a known field', edit: ['set', '/extra', []] },
  { file: 'cases', location: 'canonical[0].extra', problem: 'is not a known field', edit: ['set', '/canonical/0/extra', true] },
  { file: 'cases', location: 'normalize[0].canonical', problem: 'is missing', edit: ['delete', '/normalize/0/canonical'] },
  { file: 'cases', location: 'normalize[0].extra', problem: 'is not a known field', edit: ['set', '/normalize/0/extra', true] },
  { file: 'cases', location: 'invalid[0].errors', problem: 'is missing', edit: ['delete', '/invalid/0/errors'] },
  { file: 'cases', location: 'invalid[0].errors[0].rule', problem: 'is missing', edit: ['delete', '/invalid/0/errors/0/rule'] },
  { file: 'cases', location: 'invalid[0].errors[0].extra', problem: 'is not a known field', edit: ['set', '/invalid/0/errors/0/extra', 1] },
  { file: 'cases', location: 'hashes[0].schemaHash', problem: 'is missing', edit: ['delete', '/hashes/0/schemaHash'] },
  { file: 'cases', location: 'hashes[0].extra', problem: 'is not a known field', edit: ['set', '/hashes/0/extra', true] },
  { file: 'cases', location: 'sets[0].errors', problem: 'is missing', edit: ['delete', '/sets/0/errors'] },
  { file: 'cases', location: 'sets[0].extra', problem: 'is not a known field', edit: ['set', '/sets/0/extra', true] },
  { file: 'cases', location: `sets[${setWith('manifest')}].manifest.created`, problem: 'is missing', edit: ['delete', `/sets/${setWith('manifest')}/manifest/created`] },
  { file: 'cases', location: `sets[${setWith('manifest')}].manifest.extra`, problem: 'is not a known field', edit: ['set', `/sets/${setWith('manifest')}/manifest/extra`, []] },
  { file: 'cases', location: 'files[0].errors', problem: 'is missing', edit: ['delete', '/files/0/errors'] },
  { file: 'cases', location: 'files[0].extra', problem: 'is not a known field', edit: ['set', '/files/0/extra', true] },
  { file: 'cases', location: 'positions[0].positions', problem: 'is missing', edit: ['delete', '/positions/0/positions'] },
  { file: 'cases', location: 'positions[0].extra', problem: 'is not a known field', edit: ['set', '/positions/0/extra', true] },
  { file: 'cases', location: 'positions[0].positions[0].line', problem: 'is missing', edit: ['delete', '/positions/0/positions/0/line'] },
  { file: 'cases', location: 'positions[0].positions[0].extra', problem: 'is not a known field', edit: ['set', '/positions/0/positions/0/extra', 1] },
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
  { file: 'syntax', location: 'cases[0]', problem: 'is not an object', edit: ['set', '/cases/0', 'canonical/x'] },
  { file: 'syntax', location: 'cases[0].id', problem: 'is not a string', edit: ['set', '/cases/0/id', 1] },
  { file: 'syntax', location: 'cases[1].id', problem: 'names no input of the shared cases', edit: ['set', '/cases/1/id', 'canonical/no-such-case'] },
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

// inputsWith는 바뀐 vector file을 쓰고, 그 file과 나머지 원래 vector file의 경로를 runner 인자 순서로 돌려준다.
function inputsWith(index: number, mutation: Mutation): { path: string; location: string; inputs: string[] } {
  const value: unknown = JSON.parse(vectors[mutation.file] ?? '');
  edit(value, mutation.edit);
  const path = join(directory, `${index}-${mutation.file}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  const paths = Object.fromEntries(files.map(name => [name, name === mutation.file ? path : join(root, `tests/dbspec/${name}.json`)]));
  return { path, location: mutation.location, inputs: [paths['cases'] ?? '', stress ?? '', paths['ddl'] ?? '', paths['plans'] ?? '', paths['mermaid'] ?? '', paths['syntax'] ?? ''] };
}

caseTest('the unchanged vectors run in every runner', TIMEOUT, async () => {
  const inputs = [join(root, 'tests/dbspec/cases.json'), stress, ...['ddl', 'plans', 'mermaid', 'syntax'].map(name => join(root, `tests/dbspec/${name}.json`))];
  for (const runner of runners) {
    const result = await runRunner(runner, inputs, TIMEOUT);
    assert.equal(result.code, 0, `${runner.name}: ${result.stderr}`);
  }
});

// runner는 자기가 읽는 vector file(runners.mts의 reads)의 잘못된 vector를 거부한다.
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
