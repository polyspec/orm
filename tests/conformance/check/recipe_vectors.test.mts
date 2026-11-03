// The comparison of tests/conformance/check/recipe_vectors.mts: a body output against the expects of a recipe case and of
// the fixed-clock file, and that a difference fails.
// Requirements: FCV-2, PRT-53.
import assert from 'node:assert/strict';
import { compareOutput, expectations, plain, sequenceStatement } from './recipe_vectors.mts';
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
