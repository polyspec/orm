// The comparison of tests/conformance/check/recipe_vectors.mts: a body output against the expects of a recipe case and of
// the fixed-clock file, and that a difference fails.
// Requirements: FCV-2, PRT-53.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_RECIPE_CASE, compareOutput, expectations, plain, runnerCommand, sequenceDifferences, sequenceStatement, vectorDifferences, vectorFile } from './recipe_vectors.mts';
import { COMPUTE, caseTest } from '../../testcase.mts';

caseTest('a wrapper of a recipe value reads as plain JSON', COMPUTE, () => {
  assert.deepEqual(plain({ array: [{ object: [['a', { int: '7' }], ['b', { text: 'x' }]] }, { null: 'int' }, { bool: true }] }), [{ a: 7, b: 'x' }, null, true]);
  assert.deepEqual(plain({ json: { seq: 42 } }), { seq: 42 });
});

caseTest('each body with generated methods has the expects of its recipe case on each database', COMPUTE, () => {
  for (const database of ['mysql', 'postgres', 'sqlite']) {
    const want = expectations('generated', database);
    assert.deepEqual([...want.keys()], ['terminal_by', 'terminal_reuse', 'relation_empty', 'aes_values', 'hex_malformed', 'empty_reads', 'now_defaults', 'delete_recursive', 'affected_counts']);
    assert.equal((want.get('terminal_by')?.result as { count: number }).count, 40);
    assert.deepEqual(want.get('hex_malformed')?.result, { odd_length: 'CODEC_DECODE', white_space: 'CODEC_DECODE' });
    assert.ok((want.get('terminal_by')?.statements.length ?? 0) > 0);
    assert.deepEqual(want.get('now_defaults')?.result, { created_equals_updated: true, created_near_clock: true });
    assert.deepEqual((want.get('now_defaults')?.statements as { transaction: number }[]).map(statement => statement.transaction), [1, 1, 1, 1, 1]);
    assert.deepEqual(want.get('delete_recursive')?.result, { members: 2, members_left: 0, service_left: null });
    assert.equal((want.get('affected_counts')?.result as { upsert_updated: number }).upsert_updated, 1);
  }
});

caseTest('the sequence statement comes from the recipe', COMPUTE, () => {
  assert.match(sequenceStatement(), /^SELECT setval\(/);
});

caseTest('the fixed-clock expects state the exact clock where the client writes it', COMPUTE, () => {
  const fixed = (database: string) => (expectations('fixed-clock', database).get('clock_truncate_write')?.result as { at6_fixed: boolean }).at6_fixed;
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

const recipeCases = (): { id: string; steps: never[] }[] => JSON.parse(readFileSync(
  join(import.meta.dirname, '../../../contracts/fixtures/conformance_verification/conformance_verification.json'), 'utf8',
)).cases;
const vectorsOf = (database: string): { name: string; expect: never }[] => JSON.parse(readFileSync(vectorFile(database), 'utf8')).vectors;

caseTest('every vector equals its recipe case on each database until the vector files lose their expect', COMPUTE, () => {
  const cases = new Map(recipeCases().map(item => [item.id, item]));
  for (const database of ['mysql', 'postgres', 'sqlite']) {
    for (const vector of vectorsOf(database)) {
      const held = cases.get(vector.name);
      if (held === undefined) {
        assert.ok(vector.name in NO_RECIPE_CASE, `${database}: the vector ${vector.name} has no recipe case`);
        continue;
      }
      assert.deepEqual(vectorDifferences(vector, held as never, database), [], `${database}: ${vector.name}`);
    }
  }
});

caseTest('a changed text, bind or result of a vector is a difference', COMPUTE, () => {
  const held = recipeCases().find(item => item.id === 'upsert_one_key');
  assert.ok(held);
  const vector = () => structuredClone(vectorsOf('sqlite').find(item => item.name === 'upsert_one_key')) as unknown as
    { name: string; expect: { result: Record<string, unknown>; statements: { sql: string; binds: unknown[] }[] } };
  const differs = (change: (item: ReturnType<typeof vector>) => void, pattern: RegExp) => {
    const item = vector();
    assert.deepEqual(vectorDifferences(item as never, held as never, 'sqlite'), []);
    change(item);
    assert.match(vectorDifferences(item as never, held as never, 'sqlite').join('\n'), pattern);
  };
  differs(item => { (item.expect.statements[1] as { sql: string }).sql += ' '; }, /statement 1 sql/);
  differs(item => { item.expect.statements[1]?.binds.splice(0, 1, 'changed'); }, /statement 1 bind 0/);
  differs(item => { item.expect.result = { changed: 'not in the case' }; }, /result value "not in the case"/);
  differs(item => { item.expect.statements.pop(); }, /statements in the vector/);
});

caseTest('a changed size, boolean or text of a folded or seed vector is a difference', COMPUTE, () => {
  const cases = new Map(recipeCases().map(item => [item.id, item]));
  const changed = (name: string, change: (result: never) => unknown, pattern: RegExp) => {
    const vector = structuredClone(vectorsOf('sqlite').find(item => item.name === name)) as unknown as { name: string; expect: { result: unknown } };
    assert.deepEqual(vectorDifferences(vector as never, cases.get(name) as never, 'sqlite'), []);
    vector.expect.result = change(vector.expect.result as never);
    assert.match(vectorDifferences(vector as never, cases.get(name) as never, 'sqlite').join('\n'), pattern, name);
  };
  changed('transactions', (result: unknown[]) => [false, ...result.slice(1)], /\$\[0\]: false/);
  changed('transactions', (result: unknown[]) => [result[0], result[1], 2, ...result.slice(3)], /\$\[2\]: 2/);
  changed('relation_empty', () => 1, /\$: 1/);
  changed('delete_lock', () => [[1, 0, 'none'], [1, 1, 'FOREIGN_KEY']], /\$\[0\]\[0\]: 1/);
  changed('now_defaults', () => ({ created_equals_updated: false, created_near_clock: true }), /created_equals_updated/);
  changed('audit_lazy', (result: object) => ({ ...result, rolled_back: false }), /rolled_back/);
  changed('terminal_by', (result: { one: object }) => ({ ...result, one: { ...result.one, name: 'changed' } }), /name: "changed"/);
  changed('column_pairs', (result: object) => ({ ...result, col_decimal_i64: 'CHANGED' }), /col_decimal_i64/);
  changed('aes_status', (result: object) => ({ ...result, versions: '2:100000' }), /versions/);
});

// Requirements: PAR-1.
caseTest('TestPHPExtensionCommandLine', COMPUTE, () => {
  const extension = '/run/php-extension/polyspec_orm.so';
  assert.deepEqual(runnerCommand('php-extension', 'dsn', [], { POLYSPEC_ORM_EXTENSION: extension }), [
    'php', ['-d', `extension=${extension}`, 'packages/php/testing/conformance/runner.php', '--dsn', 'dsn'],
  ], 'php-extension command line');
  assert.deepEqual(runnerCommand('php', 'dsn', ['one']), ['php', ['packages/php/testing/conformance/runner.php', '--dsn', 'dsn', '--vector', 'one']], 'php command line');
});

const contracts = (): { id: string; expected?: never; statements?: string[] }[] =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '../../../contracts/interfaces.json'), 'utf8')) as { sequences: { id: string; statements?: string[] }[] }).sequences;

caseTest('every state contract of the interfaces holds in its recipe case on each database', COMPUTE, () => {
  const cases = new Map(recipeCases().map(item => [item.id, item]));
  const sequences = contracts();
  assert.ok(sequences.length > 0, 'contracts/interfaces.json holds no state contract');
  for (const sequence of sequences) {
    const held = cases.get(sequence.id);
    assert.ok(held, `the state contract ${sequence.id} has no recipe case`);
    for (const database of ['mysql', 'postgres', 'sqlite']) {
      assert.deepEqual(sequenceDifferences(sequence, held as never, database), [], `${database}: ${sequence.id}`);
    }
  }
});

caseTest('a changed statement kind or result of a state contract is a difference', COMPUTE, () => {
  const cases = new Map(recipeCases().map(item => [item.id, item]));
  const sequence = contracts().find(item => item.id === 'transactions');
  assert.ok(sequence);
  const held = cases.get('transactions') as never;
  assert.deepEqual(sequenceDifferences(sequence, held, 'sqlite'), []);
  assert.notDeepEqual(sequenceDifferences({ ...sequence, statements: (sequence.statements ?? []).slice(1) }, held, 'sqlite'), [], 'a missing statement');
  assert.notDeepEqual(sequenceDifferences({ ...sequence, expected: [false, 1, 1, 'runner', true, 0] as never }, held, 'sqlite'), [], 'a changed result');
});
