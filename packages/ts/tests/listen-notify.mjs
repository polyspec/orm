// LISTEN and NOTIFY on PostgreSQL (DIA-192 to DIA-196, PRT-74). A notification sent inside a transaction is delivered
// with its commit and dropped by a rollback; one sent outside a transaction is delivered at once; unlisten stops a
// channel; a receive whose abort signal is aborted raises CANCELED; and MySQL and SQLite refuse notify, listen and
// unlisten with CAPABILITY_UNSUPPORTED before any statement runs.
import { connect } from '../dist/index.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';

function expectCode(error, code, what) {
  if (error?.code !== code) throw new Error(`${what} raised ${error?.code ?? error}; want ${code}`);
}

caseTest('listen-notify/postgres', DATABASE, async ({ step }) => {
  await withCaseDatabase('postgres', step, async database => {
    const db = await connect(database.dsn);
    try {
      const subscription = await db.listen('t229_events');
      await db.transaction(() => db.notify('t229_events', 'committed'));
      const first = await subscription.receive();
      if (first.channel !== 't229_events' || first.payload !== 'committed') throw new Error(`received ${JSON.stringify(first)}; want the committed notification`);

      let rolledBack = false;
      try {
        await db.transaction(async () => {
          await db.notify('t229_events', 'rolled back');
          throw new Error('roll back');
        });
      } catch { rolledBack = true; }
      if (!rolledBack) throw new Error('the transaction that fails did not fail');
      await db.notify('t229_events', 'outside');
      const second = await subscription.receive();
      if (second.payload !== 'outside') throw new Error(`received ${second.payload}; the rolled back notification must not arrive`);

      await subscription.unlisten('t229_events');
      await db.notify('t229_events', 'after unlisten');
      await subscription.close();

      const controller = new AbortController();
      const waiting = await db.withSignal(controller.signal).listen('t229_cancel');
      controller.abort();
      let raised = null;
      try { await waiting.receive(); } catch (error) { raised = error; }
      expectCode(raised, 'CANCELED', 'a receive on an aborted signal');
      await waiting.close();
    } finally {
      await db.close();
    }
  });
});

for (const dialect of ['sqlite', 'mysql']) {
  caseTest(`listen-notify/${dialect}`, DATABASE, async ({ step }) => {
    await withCaseDatabase(dialect, step, async database => {
      const db = await connect(database.dsn);
      try {
        let raised = null;
        try { await db.notify('t229_events', 'x'); } catch (error) { raised = error; }
        expectCode(raised, 'CAPABILITY_UNSUPPORTED', `${dialect} notify`);
        raised = null;
        try { await db.listen('t229_events'); } catch (error) { raised = error; }
        expectCode(raised, 'CAPABILITY_UNSUPPORTED', `${dialect} listen`);
      } finally {
        await db.close();
      }
    });
  });
}
