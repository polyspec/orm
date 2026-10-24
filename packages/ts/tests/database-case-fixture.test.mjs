import assert from 'node:assert/strict';
import { caseTest } from '../../../tests/testcase.mts';
import { loadDatabaseCaseFixture } from './database-case-fixture.mjs';

caseTest('loads a schema and model with independent database-case state', 1000, async () => {
  const reports = [];
  const Model = class {};
  const fixture = await loadDatabaseCaseFixture('refusal.dbs', 'refused_row', {
    modelFactory: text => {
      assert.match(text, /table refused_row/);
      return { refused_row: Model };
    },
    report: message => reports.push(message),
  });
  assert.equal(fixture.model, Model);
  assert.equal(fixture.deadline, 30_000);
  assert.deepEqual(fixture.state, { failures: 0, current: '' });
  fixture.state.current = 'trigger_refused/sqlite';
  fixture.check(false, 'row was changed');
  assert.deepEqual(fixture.state, { failures: 1, current: 'trigger_refused/sqlite' });
  assert.deepEqual(reports, ['FAIL trigger_refused/sqlite: row was changed']);
});

caseTest('loads the generated model for a fixture without connecting to a database', 5000, async () => {
  const fixture = await loadDatabaseCaseFixture('rollback.dbs', 'rollback_probe');
  assert.equal(typeof fixture.model, 'function');
  assert.match(fixture.text, /table rollback_probe/);
});

caseTest('reports a missing model by the fixture and model name', 1000, async () => {
  await assert.rejects(loadDatabaseCaseFixture('rollback.dbs', 'missing', { modelFactory: () => ({}) }), {
    message: 'rollback.dbs does not provide model missing',
  });
});
