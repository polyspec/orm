// The comparison of tests/conformance/check/recipe_vectors.mts: a body output against the expects of a recipe case and of
// the fixed-clock file, and that a difference fails.
// Requirements: FCV-2, PRT-53.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_RECIPE_CASE, compareOutput, expectations, plain, vectorDifferences, vectorFile } from './recipe_vectors.mts';
import { COMPUTE, caseTest } from '../../testcase.mts';

caseTest('a wrapper of a recipe value reads as plain JSON', COMPUTE, () => {
  assert.deepEqual(plain({ array: [{ object: [['a', { int: '7' }], ['b', { text: 'x' }]] }, { null: 'int' }, { bool: true }] }), [{ a: 7, b: 'x' }, null, true]);
  assert.deepEqual(plain({ json: { seq: 42 } }), { seq: 42 });
});

caseTest('each body with generated methods has the expects of its recipe case on each database', COMPUTE, () => {
  for (const database of ['mysql', 'postgres', 'sqlite']) {
    const want = expectations('generated', database);
    assert.deepEqual([...want.keys()], ['terminal_by', 'terminal_reuse', 'relation_empty', 'aes_values', 'hex_malformed', 'empty_reads']);
    assert.equal((want.get('terminal_by')?.result as { count: number }).count, 40);
    assert.deepEqual(want.get('hex_malformed')?.result, { odd_length: 'CODEC_DECODE', white_space: 'CODEC_DECODE' });
    assert.ok((want.get('terminal_by')?.statements.length ?? 0) > 0);
  }
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
