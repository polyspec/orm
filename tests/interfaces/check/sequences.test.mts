// Comparison of --results: a statement that differs from the state contract's statement kind list is reported with position, kind, and SQL, and an output not written
// is reported by its path, and i64 values and their type are not lost.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../../testcase.mts';
import { deepEqual, losslessJson } from './json.mts';
import type { Sequence } from './manifest.mts';
import { checkResults, checkSequences, type SequenceOutput } from './sequences.mts';

// utility statements differ by dialect, so they are not compared. now_defaults output has the same shape as MySQL's: begin, insert,
// select, delete, commit.
caseTest('sequences name added and missing statements', COMPUTE, () => {
  const sequences: Sequence[] = [{ id: 'now_defaults', expected: { created_equals_updated: true }, statements: ['begin', 'insert', 'select', 'delete', 'commit'] }];
  const output = (list: string): Record<string, SequenceOutput> => {
    const parsed: unknown = losslessJson(`{"now_defaults":{"result":{"created_equals_updated":true},"statements":[${list}]}}`);
    assert.ok(parsed !== null && typeof parsed === 'object');
    return Object.fromEntries(Object.entries(parsed).map(([key, value]: [string, SequenceOutput]) => [key, value]));
  };
  const statements = '{"kind":"begin","sql":"START TRANSACTION"},{"kind":"insert","sql":"INSERT a"},{"kind":"select","sql":"SELECT a"},{"kind":"delete","sql":"DELETE a"},{"kind":"commit","sql":"COMMIT"}';
  assert.deepEqual(checkSequences('go.json', output(statements), sequences), []);
  assert.deepEqual(checkSequences('go.json', output(`${statements},{"kind":"utility","sql":"SELECT GET_LOCK(?, 50)"}`), sequences), [], 'a utility statement was compared');
  const cases: [string, string[]][] = [
    // Before T42 the contract (model statements only) and today's output have different shapes.
    ['{"kind":"insert","sql":"INSERT a"},{"kind":"select","sql":"SELECT a"},{"kind":"delete","sql":"DELETE a"}', [[
      'go.json: state contract now_defaults: statements other than utility differ from the contract: -2 transaction-control',
      '  - #1 begin',
      '  - #5 commit',
    ].join('\n')]],
    [`${statements},{"kind":"update","sql":"UPDATE a"}`, [[
      'go.json: state contract now_defaults: statements other than utility differ from the contract: +1 model',
      '  + #6 update UPDATE a',
    ].join('\n')]],
    [`${statements},{"sql":"SET x"}`, ['go.json: state contract now_defaults: statement #6 (SET x) has no kind']],
    [`${statements},{"kind":"other","sql":"SET x"}`, ['go.json: state contract now_defaults: statement #6 (SET x) has the unknown kind "other"']],
  ];
  for (const [list, want] of cases) assert.deepEqual(checkSequences('go.json', output(list), sequences), want, `statements ${list}`);
  const wrong = output(statements);
  wrong['now_defaults'] = { ...wrong['now_defaults'], result: { created_equals_updated: false } };
  assert.deepEqual(checkSequences('go.json', wrong, sequences), ['go.json: state contract now_defaults: result {"created_equals_updated":false}, expected {"created_equals_updated":true}']);
  assert.deepEqual(checkSequences('go.json', {}, sequences), ['go.json: state contract now_defaults: the output has no now_defaults vector']);
});

// A run of selected vectors checks the state contracts of those vectors only: a contract whose vector did not run is not
// reported missing, and a selected one is still compared.
caseTest('a selection checks the state contracts of its vectors', COMPUTE, () => {
  const sequences: Sequence[] = [
    { id: 'now_defaults', expected: { created_equals_updated: true }, statements: [] },
    { id: 'restore', expected: { hidden: null }, statements: [] },
  ];
  const output: Record<string, SequenceOutput> = { restore: { result: { hidden: 'NO_ROWS' }, statements: [] } };
  assert.deepEqual(checkSequences('go.json', output, sequences, ['restore']), ['go.json: state contract restore: result {"hidden":"NO_ROWS"}, expected {"hidden":null}']);
  assert.deepEqual(checkSequences('go.json', { restore: { result: { hidden: null }, statements: [] } }, sequences, ['restore']), []);
});

caseTest('the results name a missing output', COMPUTE, () => {
  const directory = mkdtempSync(join(tmpdir(), 'orm-interface-test-'));
  try {
    writeFileSync(join(directory, 'go.json'), '{}', { mode: 0o600 });
    assert.deepEqual(checkResults(directory, ['go', 'php'], []),
      [`missing input ${join(directory, 'php.json')}: the conformance run of this check did not write the php output`]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

caseTest('the state comparison preserves i64 values and their type', COMPUTE, () => {
  const first = losslessJson('[[9223372036854775806,"row"]]');
  const second = losslessJson('[[9223372036854775807,"row"]]');
  const text = losslessJson('[["9223372036854775806","row"]]');
  assert.ok(!deepEqual(first, second) && !deepEqual(first, text), 'comparison lost I64 precision or key type');
  assert.ok(!deepEqual(losslessJson('1'), losslessJson('1.0')), '1 and 1.0 compared equal');
});
