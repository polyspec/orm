import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { caseTest } from '../../../tests/testcase.mts';
import { DbspecApplyError, applyPlans, rollbackPlans } from '../dist/dbspec/index.js';
import { createFromEmptyPlans } from './dbspec-plan-fixture.mjs';

const root = new URL('../../../', import.meta.url);
const TIMEOUT = 20000;
const fixedNow = () => Date.UTC(2026, 9, 1, 0, 0, 0) * 1000 + 123456;
const masterQuery = `SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'dbspec$%' ORDER BY type, name`;
const plans = createFromEmptyPlans(root);

function failingSqlite() {
  const db = new DatabaseSync(':memory:');
  let queryFailure = null;
  let failOnCatalogRead = 1;
  let catalogReads = 0;
  return {
    exec(sql) { return db.exec(sql); },
    prepare(sql) {
      if (sql === masterQuery) {
        catalogReads++;
        if (queryFailure !== null && catalogReads === failOnCatalogRead) throw queryFailure;
      }
      return db.prepare(sql);
    },
    failCatalogWith(error, call = catalogReads + 1) { queryFailure = error; failOnCatalogRead = call; },
    historyState() { return db.prepare('SELECT state FROM "dbspec$plans"').get()?.state; },
    close() { db.close(); },
  };
}

function hasApplyError(error, code, cause) {
  assert(error instanceof DbspecApplyError, `${error}`);
  assert.equal(error.code, code);
  if (cause !== undefined) assert.equal(error.cause, cause);
  return true;
}

// Requirements: PLN-92.
caseTest('apply/settled-introspection-error', TIMEOUT, async () => {
  const cause = new Error('catalog read failed');
  const connection = failingSqlite();
  try {
    connection.failCatalogWith(cause);
    await assert.rejects(applyPlans(connection, 'sqlite', plans, fixedNow, null), error => hasApplyError(error, 'verify', cause));
  } finally {
    connection.close();
  }

  const drift = failingSqlite();
  try {
    drift.exec('CREATE TABLE unrelated (id INTEGER)');
    await assert.rejects(applyPlans(drift, 'sqlite', plans, fixedNow, null), error => hasApplyError(error, 'drift'));
  } finally {
    drift.close();
  }
});

// Requirements: PLN-96.
caseTest('apply/rollback-introspection-error', TIMEOUT, async () => {
  const cause = new Error('catalog read failed');
  const connection = failingSqlite();
  try {
    await applyPlans(connection, 'sqlite', plans, fixedNow, null);
    connection.failCatalogWith(cause);
    await assert.rejects(rollbackPlans(connection, 'sqlite', plans, fixedNow, null), error => hasApplyError(error, 'verify', cause));
  } finally {
    connection.close();
  }
});

// Requirements: PLN-93.
caseTest('apply/post-forward-introspection-error', TIMEOUT, async () => {
  const cause = new Error('post-forward catalog read failed');
  const connection = failingSqlite();
  const events = [];
  try {
    connection.failCatalogWith(cause, 2);
    await assert.rejects(applyPlans(connection, 'sqlite', plans, fixedNow, event => events.push(event.kind)), error => hasApplyError(error, 'verify', cause));
    assert.equal(connection.historyState(), 'applying');
    assert.equal(events.includes('verified'), false);
    assert.equal(events.includes('done'), false);
  } finally {
    connection.close();
  }
});
