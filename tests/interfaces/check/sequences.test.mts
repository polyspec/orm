// --results의 비교: state contract의 statement kind 목록과 다른 statement를 위치, kind, SQL과 함께 적고, 쓰지 않은 output을
// 그 경로로 적으며, i64 값과 그 type을 잃지 않는다.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../../testcase.mts';
import { deepEqual, losslessJson } from './json.mts';
import type { Sequence } from './manifest.mts';
import { checkResults, checkSequences, type SequenceOutput } from './sequences.mts';

// utility statement는 dialect마다 다르므로 비교하지 않는다. now_defaults의 출력은 MySQL의 것과 같은 모양이다: begin, insert,
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
    // T42 이전의 contract(model statement만)와 오늘의 출력이 다른 모양이다.
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
