// LISTEN and NOTIFY on PostgreSQL (DIA-192 to DIA-196, PRT-74). A notification sent inside a transaction is delivered
// with its commit and dropped by a rollback; one sent outside a transaction is delivered at once; unlisten stops a
// channel; a receive whose abort signal is aborted raises CANCELED; and MySQL and SQLite refuse notify, listen and
// unlisten with CAPABILITY_UNSUPPORTED before any statement runs.
// Requirements: DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.
import { connect } from '../dist/index.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { postgresClient, relatedDsn, withCaseDatabase } from './case-database.mjs';

function expectCode(error, code, what) {
  if (error?.code !== code) throw new Error(`${what} raised ${error?.code ?? error}; want ${code}`);
}

caseTest('listen-notify/postgres', DATABASE, async ({ step }) => {
  await withCaseDatabase('postgres', step, async database => {
    const db = await connect(database.dsn);
    try {
      const subscription = await db.listen('t229_events');
      for (const channel of ['', 'x'.repeat(64), 'é'.repeat(32), 'bad\0channel']) {
        let raised = null;
        try { await db.notify(channel, 'invalid channel'); } catch (error) { raised = error; }
        expectCode(raised, 'CONFIG', 'notify invalid channel');
        raised = null;
        try { await db.listen(channel); } catch (error) { raised = error; }
        expectCode(raised, 'CONFIG', 'listen invalid channel');
      }
      await db.notify('é'.repeat(31), 'valid 62-byte channel');
      for (const payload of ['x'.repeat(8000), 'x'.repeat(8001), 'é'.repeat(4000), 'é'.repeat(4001), 'bad\0payload']) {
        let raised = null;
        try { await db.notify('t229_events', payload); } catch (error) { raised = error; }
        expectCode(raised, 'DRIVER', 'notify invalid payload');
      }
      const boundary = 'x'.repeat(7999);
      await db.transaction(() => db.notify('t229_events', 'committed'));
      const first = await subscription.receive();
      if (first.channel !== 't229_events' || first.payload !== 'committed') throw new Error(`received ${JSON.stringify(first)}; want the committed notification`);
      await db.notify('t229_events', boundary);
      if ((await subscription.receive()).payload !== boundary) throw new Error('the 7999-byte payload was not delivered');
      for (const payload of ['buffer-1', 'buffer-2', 'buffer-3']) await db.notify('t229_events', payload);
      const buffered = [
        (await subscription.receive()).payload,
        (await subscription.receive()).payload,
        (await subscription.receive()).payload,
      ];
      if (JSON.stringify(buffered) !== JSON.stringify(['buffer-1', 'buffer-2', 'buffer-3'])) {
        throw new Error(`buffered notifications arrived out of order: ${JSON.stringify(buffered)}`);
      }

      let rolledBack = false;
      const rollBack = new Error('roll back');
      try {
        await db.transaction(async () => {
          await db.notify('t229_events', 'rolled back');
          throw rollBack;
        });
      } catch (error) {
        if (error !== rollBack) throw error;
        rolledBack = true;
      }
      if (!rolledBack) throw new Error('the transaction that fails did not fail');
      await db.notify('t229_events', 'outside');
      const second = await subscription.receive();
      if (second.payload !== 'outside') throw new Error(`received ${second.payload}; the rolled back notification must not arrive`);

      await subscription.unlisten('t229_events');
      await db.notify('t229_events', 'after unlisten');
      await subscription.close();

      const noDeliveryController = new AbortController();
      const noDelivery = await db.withSignal(noDeliveryController.signal).listen('t229_unlisten_stops_delivery');
      await noDelivery.unlisten('t229_unlisten_stops_delivery');
      await db.notify('t229_unlisten_stops_delivery', 'must not arrive');
      const noDeliveryDeadline = setTimeout(() => noDeliveryController.abort(), 50);
      let noDeliveryError = null;
      try { await noDelivery.receive(); } catch (error) { noDeliveryError = error; }
      clearTimeout(noDeliveryDeadline);
      expectCode(noDeliveryError, 'CANCELED', 'unlisten stopped delivery');
      let closedError = null;
      try { await noDelivery.receive(); } catch (error) { closedError = error; }
      expectCode(closedError, 'CONFIG', 'receive after cancellation is closed');
      await noDelivery.close();

      const lostDb = await connect(database.dsn);
      const lost = await lostDb.listen('t229_connection_lost');
      await lostDb.close();
      const serverDsn = process.env.ORM_TEST_POSTGRES_SERVER_DSN;
      if (!serverDsn) throw new Error('ORM_TEST_POSTGRES_SERVER_DSN is required; run the test through make orm-test-servers');
      const admin = postgresClient(relatedDsn(serverDsn, database.name));
      await admin.connect();
      try {
        const sessions = await admin.query(
          'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND query = $1 LIMIT 1',
          ['LISTEN "t229_connection_lost"'],
        );
        if (sessions.rows.length !== 1) throw new Error('the listener backend is visible in pg_stat_activity');
        const ended = await admin.query('SELECT pg_terminate_backend($1, 5000)', [sessions.rows[0].pid]);
        if (ended.rows[0].pg_terminate_backend !== true) throw new Error('the listener backend was not terminated');
      } finally {
        await admin.end();
      }
      let lostError = null;
      try { await lost.receive(); } catch (error) { lostError = error; }
      if (lostError?.code !== 'CONNECTION_LOST') throw new Error(`receive after listener connection loss raised ${lostError?.code}: ${lostError?.message}; cause=${lostError?.cause?.code}: ${lostError?.cause?.message}`);
      let lostClosedError = null;
      try { await lost.receive(); } catch (error) { lostClosedError = error; }
      expectCode(lostClosedError, 'CONFIG', 'receive after connection loss is closed');
      await lost.close();

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
