// diff case는 차이를 더해지고 빠진 statement로, 그 위치와 kind와 text와 함께 적는지 확인한다(stmtdiff.mts).
import assert from 'node:assert/strict';
import { COMPUTE, caseTest } from '../../testcase.mts';
import { changeLine, diff, statementGroup, summary, type Statement } from './stmtdiff.mts';

caseTest('TestDiffNamesAddedAndMissingStatements', COMPUTE, () => {
  const statement = (kind: string, text: string): Statement => ({ kind, text, key: `${kind} ${text}` });
  const expected = [statement('insert', 'INSERT a'), statement('select', 'SELECT a'), statement('delete', 'DELETE a')];
  const got = [statement('begin', 'START TRANSACTION'), statement('insert', 'INSERT a'), statement('select', 'SELECT b'), statement('delete', 'DELETE a'), statement('commit', 'COMMIT')];
  const changes = diff(expected, got);
  assert.deepEqual(changes.map(changeLine), ['+ #1 begin START TRANSACTION', '+ #3 select SELECT b', '- #2 select SELECT a', '+ #5 commit COMMIT']);
  assert.equal(summary(changes, statementGroup), '+1 model, +2 transaction-control, -1 model');
  assert.deepEqual(diff(expected, expected), [], 'equal lists differ');
});
