// The comparison of tests/conformance/check/recipe_vectors.mts: a body output against the expects of a recipe case and of
// the fixed-clock file, and that a difference fails.
// Requirements: FCV-2, PRT-53.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_RECIPE_CASE, RUNNER_SOURCES, compareOutput, compareOutputs, declaredBodies, expectations, fixedClockExpectations, list, plain, readRecipe, record, runnerCommand, sequenceDifferences, sequenceStatement, type Output, type Sequence } from './recipe_vectors.mts';
import { readJsonFile } from '../../../scripts/json/schema.mts';
import { COMPUTE, caseTest } from '../../testcase.mts';

const VECTORS_SCHEMA = join(import.meta.dirname, '../../../tests/conformance/schema/vectors.schema.json');
const INTERFACES_SCHEMA = join(import.meta.dirname, '../../../scripts/schema/interfaces-manifest.schema.json');

caseTest('a wrapper of a recipe value reads as plain JSON', COMPUTE, () => {
  assert.deepEqual(plain({ array: [{ object: [['a', { int: '7' }], ['b', { text: 'x' }]] }, { null: 'int' }, { bool: true }] }), [{ a: 7, b: 'x' }, null, true]);
  assert.deepEqual(plain({ json: { seq: 42 } }), { seq: 42 });
});

caseTest('each body with generated methods has the expects of its recipe case on each database', COMPUTE, () => {
  for (const database of ['mysql', 'postgres', 'sqlite']) {
    const want = expectations('generated', database);
    assert.deepEqual([...want.keys()], ['terminal_by', 'terminal_reuse', 'relation_empty', 'aes_values', 'hex_malformed', 'empty_reads', 'now_defaults', 'delete_recursive', 'affected_counts']);
    assert.equal(record(want.get('terminal_by')?.result).count, 40);
    assert.deepEqual(want.get('hex_malformed')?.result, { odd_length: 'CODEC_DECODE', white_space: 'CODEC_DECODE' });
    assert.ok((want.get('terminal_by')?.statements.length ?? 0) > 0);
    assert.deepEqual(want.get('now_defaults')?.result, { created_equals_updated: true, created_near_clock: true });
    assert.deepEqual(list(want.get('now_defaults')?.statements).map(statement => record(statement).transaction), [1, 1, 1, 1, 1]);
    assert.deepEqual(want.get('delete_recursive')?.result, { members: 2, members_left: 0, service_left: null });
    assert.equal(record(want.get('affected_counts')?.result).upsert_updated, 1);
  }
});

caseTest('the sequence statement comes from the recipe', COMPUTE, () => {
  assert.match(sequenceStatement(), /^SELECT setval\(/);
});

caseTest('the fixed-clock expects state the exact clock where the client writes it', COMPUTE, () => {
  const fixed = (database: string) => record(expectations('fixed-clock', database).get('clock_truncate_write')?.result).at6_fixed;
  assert.equal(fixed('sqlite'), true);
  assert.equal(fixed('postgres'), true);
  assert.equal(fixed('mysql'), false);
});

caseTest('a result or a statement that differs from its expect fails', COMPUTE, () => {
  const want = { result: { count: 40 }, statements: [{ sql: 'SELECT 1', binds: [1] }] };
  assert.doesNotThrow(() => { compareOutput('same', { result: { count: 40 }, statements: [{ sql: 'SELECT 1', binds: [1], error: null }] }, want); });
  assert.throws(() => { compareOutput('result', { result: { count: 1000 }, statements: want.statements }, want); }, /result differs/);
  assert.throws(() => { compareOutput('count', { result: want.result, statements: [] }, want); }, /number of statements/);
  assert.throws(() => { compareOutput('sql', { result: want.result, statements: [{ sql: 'SELECT 2', binds: [1] }] }, want); }, /statement 0 sql/);
  assert.doesNotThrow(() => { compareOutput('masked', { result: want.result, statements: [{ sql: 'SELECT 1', binds: ['$SEQ'] }] }, want); });
  assert.throws(() => { compareOutput('masked text', { result: want.result, statements: [{ sql: 'SELECT 1', binds: ['$SEQ'] }] }, { result: want.result, statements: [{ sql: 'SELECT 1', binds: ['a'] }] }); }, /statement 0 binds/);
});

// T457: the forms that the conformance rule of AGENTS.md names as an error.
caseTest('the comparison of a selection refuses an empty selection, an output outside it and a missing output', COMPUTE, () => {
  const one: Output = { result: 1, statements: [] };
  const want = new Map<string, Output>([['a', one]]);
  compareOutputs('go/sqlite', { a: { result: 1, statements: [] } }, want);
  assert.throws(() => compareOutputs('go/sqlite', {}, new Map<string, Output>()), /go\/sqlite: the selection names no vector/);
  assert.throws(() => compareOutputs('go/sqlite', { a: { result: 1, statements: [] }, b: { result: 1, statements: [] } }, want), /go\/sqlite: the runner gave the output b, which the selection does not name/);
  assert.throws(() => compareOutputs('go/sqlite', {}, want), /go\/sqlite: the runner gave no output for a/);
  assert.throws(() => compareOutputs('go/sqlite', { a: { result: 2, statements: [] } }, want), /go\/sqlite\/a: the result differs from its expect/);
});

// T457: a fixed-clock case has a nonempty id of its own and exactly the expects of mysql, postgres and sqlite.
caseTest('a fixed-clock file with no case, an empty or repeated id or other databases is refused', COMPUTE, () => {
  const held = { result: 1, statements: [] };
  const expect = { mysql: held, postgres: held, sqlite: held };
  assert.deepEqual([...fixedClockExpectations({ cases: [{ id: 'a', expect }, { id: 'b', expect }] }, 'sqlite').keys()], ['a', 'b']);
  assert.throws(() => fixedClockExpectations({ cases: [] }, 'sqlite'), /fixed_clock\.json holds no case/);
  assert.throws(() => fixedClockExpectations({ cases: [{ id: '', expect }] }, 'sqlite'), /fixed_clock\.json holds a case with an empty id/);
  assert.throws(() => fixedClockExpectations({ cases: [{ id: 'a', expect }, { id: 'a', expect }] }, 'sqlite'), /fixed_clock\.json holds the case a twice/);
  assert.throws(() => fixedClockExpectations({ cases: [{ id: 'a', expect: { mysql: held, sqlite: held } }] }, 'sqlite'), /case a states the expects of mysql, sqlite, not exactly those of mysql, postgres, sqlite/);
  assert.throws(() => fixedClockExpectations({ cases: [{ id: 'a', expect: { ...expect, markdown: held } }] }, 'sqlite'), /case a states the expects of markdown, mysql, postgres, sqlite, not exactly those of mysql, postgres, sqlite/);
  assert.throws(() => fixedClockExpectations({ cases: [{ id: 'a', expect: {} }] }, 'sqlite'), /case a states the expects of no database, not exactly those of mysql, postgres, sqlite/);
});

caseTest('every vector name is a recipe case or a fixed-clock body', COMPUTE, () => {
  const cases = new Set(readRecipe().cases.map(item => item.id));
  const { vectors } = readJsonFile<{ vectors: { name: string }[] }>(join(import.meta.dirname, '../vectors.json'), VECTORS_SCHEMA);
  for (const { name } of vectors) assert.ok(cases.has(name) || name in NO_RECIPE_CASE, `the vector ${name} has no recipe case`);
});

// A vector that a recipe case holds has no body: the checks reach only the generated-method and the fixed-clock bodies, and a
// body that no check reaches is code that nothing runs.
caseTest('each runner declares exactly the bodies that the checks reach', COMPUTE, () => {
  const reached = ['generated', 'fixed-clock'].flatMap(mode => [...expectations(mode, 'sqlite').keys()]).sort();
  assert.equal(reached.length, 11);
  for (const [language, sources] of Object.entries(RUNNER_SOURCES)) {
    const declared = sources.flatMap(source => declaredBodies(readFileSync(join(import.meta.dirname, '../../..', source), 'utf8')));
    assert.deepEqual(declared.sort(), reached, language);
  }
});

caseTest('a body declared in any runner form is read by its name', COMPUTE, () => {
  assert.deepEqual(declaredBodies('run("go_body", func() {\nrun!("rust_body", async {\nrun!(\n    "rust_long",\n'), ['go_body', 'rust_body', 'rust_long']);
  assert.deepEqual(declaredBodies("vector('php_body', fn() => 1);\nvector(\n    'php_long',\nawait run('ts_body', async () => {"), ['php_body', 'php_long', 'ts_body']);
  assert.deepEqual(declaredBodies('func run() {\nfunction vector(string $name, callable $fn)\nrun($name, $fn);\nexecuteVector("write", fn)'), []);
});

// Requirements: PAR-1.
caseTest('TestPHPExtensionCommandLine', COMPUTE, () => {
  const extension = '/run/php-extension/polyspec_orm.so';
  assert.deepEqual(runnerCommand('php-extension', 'dsn', [], { POLYSPEC_ORM_EXTENSION: extension }), [
    'php', ['-d', `extension=${extension}`, 'legacy/packages/php/testing/conformance/runner.php', '--dsn', 'dsn'],
  ], 'php-extension command line');
  assert.deepEqual(runnerCommand('php', 'dsn', ['one']), ['php', ['legacy/packages/php/testing/conformance/runner.php', '--dsn', 'dsn', '--vector', 'one']], 'php command line');
});

const contracts = (): Sequence[] => readJsonFile<{ sequences: Sequence[] }>(join(import.meta.dirname, '../../../contracts/interfaces.json'), INTERFACES_SCHEMA).sequences;

caseTest('every state contract of the interfaces holds in its recipe case on each database', COMPUTE, () => {
  const cases = new Map(readRecipe().cases.map(item => [item.id, item]));
  const sequences = contracts();
  assert.ok(sequences.length > 0, 'contracts/interfaces.json holds no state contract');
  for (const sequence of sequences) {
    const held = cases.get(sequence.id);
    assert.ok(held, `the state contract ${sequence.id} has no recipe case`);
    for (const database of ['mysql', 'postgres', 'sqlite']) {
      assert.deepEqual(sequenceDifferences(sequence, held, database), [], `${database}: ${sequence.id}`);
    }
  }
});

caseTest('a changed statement kind or result of a state contract is a difference', COMPUTE, () => {
  const cases = new Map(readRecipe().cases.map(item => [item.id, item]));
  const sequence = contracts().find(item => item.id === 'transactions');
  assert.ok(sequence);
  const held = cases.get('transactions');
  assert.ok(held);
  assert.deepEqual(sequenceDifferences(sequence, held, 'sqlite'), []);
  assert.notDeepEqual(sequenceDifferences({ ...sequence, statements: (sequence.statements ?? []).slice(1) }, held, 'sqlite'), [], 'a missing statement');
  assert.notDeepEqual(sequenceDifferences({ ...sequence, expected: [false, 1, 1, 'runner', true, 0] }, held, 'sqlite'), [], 'a changed result');
});
