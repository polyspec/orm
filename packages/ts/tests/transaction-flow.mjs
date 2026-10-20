// The execution flow of a TypeScript transaction, on a SQLite file: asynchronous work started inside the callback shares
// the callback's AsyncLocalStorage context and therefore the transaction, a statement that overlaps another statement
// on the transaction connection returns CONFIG. The test of DSL-121 and DSL-122 (docs/spec/dsl.md "Transactions").
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { OrmError, Service, connect } from '../dist/index.js';
import { installBench } from './bench-set.mjs';
import { DATABASE, caseTest } from '../../../tests/testcase.mts';

const work = await mkdtemp(join(tmpdir(), 'orm-ts-transaction-flow-'));
after(() => rm(work, { recursive: true, force: true }));

/** A new SQLite file with the bench set installed, connected. */
async function database(name) {
  const db = await connect(`sqlite://${join(work, `${name}.sqlite`)}`);
  await installBench(db);
  return db;
}

const stop = new Error('stop');

caseTest('transaction flow: asynchronous work inside the callback shares the transaction', DATABASE, async () => {
  const db = await database('shared');
  try {
    const failed = await db.transaction(async () => {
      // Started inside the callback, the work runs in its context, so its insert is part of the transaction.
      await new Promise((resolve, reject) => setImmediate(() => new Service().setName('inside').create().then(resolve, reject)));
      throw stop;
    }).then(() => undefined, error => error);
    if (failed !== stop) throw new Error(`the transaction ended with ${failed}, not the callback's error`);
    const left = await new Service().connect(db).name('inside').getCount();
    if (left !== 0) throw new Error(`the rolled back insert of the asynchronous work left ${left} row(s): it ran outside the transaction`);
  } finally { await db.close(); }
});

caseTest('transaction flow: overlapping statements on the transaction connection return CONFIG', DATABASE, async () => {
  const db = await database('overlap');
  try {
    let settled;
    await db.transaction(async () => {
      settled = await Promise.allSettled([new Service().getCount(), new Service().getCount()]);
    }, { retry: 0 });
    const codes = settled.map(r => r.status === 'rejected' ? (r.reason instanceof OrmError ? r.reason.code : String(r.reason)) : null);
    if (!codes.includes('CONFIG')) throw new Error(`two overlapping statements of one transaction gave ${JSON.stringify(codes)}, without CONFIG`);
  } finally { await db.close(); }
});
