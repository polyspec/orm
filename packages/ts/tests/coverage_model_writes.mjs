// model_writes coverage: create_parts runs the batch behaviour of CompositeAccount natively, and model_write_cycle
// checks the ordered JSON text and the codec columns, which the model_writes recipe does not assert.
import assert from 'node:assert/strict';
import { Author, CompositeAccount, StyledValue, connect } from '../dist/index.js';
import { parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { errorCode, runCases, withCleanup } from './coverage_case.mjs';

const tenant = 990002;

await runCases('coverage_model_writes.mjs', {
  // Requirements: DSL-104, INT-35, PRT-41.
  async create_parts({ driver, dsn }) {
    const db = await connect(dsn);
    const createTenant = tenant + 1;
    const account = () => new CompositeAccount().connect(db);
    try {
      assert.equal(db.driver, driver);
      assert.equal(await account().tenantId(createTenant).getCount(), 0, 'tenant starts empty');
      const events = [];
      const unsubscribe = db.subscribe(event => { events.push(event); });
      try {
        const refused = [new CompositeAccount().setTenantId(createTenant).setAccountId(1).setName('refused')];
        assert.equal(await errorCode(account().creates(refused, 0)), 'CONFIG', 'batch zero is refused');
        assert.equal(events.length, 0, 'invalid batch sends no statements');
        const limit = driver === 'sqlite' ? 999 : 65535;
        const oversized = Array.from({ length: Math.floor(limit / 3) + 1 }, () =>
          new CompositeAccount().setTenantId(createTenant).setAccountId(8).setName('oversized'));
        assert.equal(await errorCode(account().creates(oversized, oversized.length)), 'BATCH_TOO_LARGE', 'over-limit batch is refused');
        assert.equal(events.length, 0, 'over-limit batch sends no statements');

        const labels = ['ordered-5', 'ordered-4', 'ordered-3', 'ordered-2', 'ordered-1'];
        const rows = labels.map((name, i) => new CompositeAccount().setTenantId(createTenant).setAccountId(i + 1).setName(name));
        assert.equal(await account().creates(rows, 2), 5, 'creates inserts all rows');
        const inserts = events.filter(event => event.kind === 'insert');
        assert.deepEqual(inserts.map(event => event.binds.length / 3), [2, 2, 1], 'INSERT batches are 2, 2, 1');
        const stored = await account().tenantId(createTenant).orderByAccountIdAsc().gets();
        assert.deepEqual([...stored].map(row => row.getName()), labels, 'stored rows preserve input order');

        await (await account().tenantId(createTenant).gets()).delete();
        events.length = 0;
        await account().setTenantId(createTenant).setAccountId(99).setName('existing').create();
        events.length = 0;
        const failing = [10, 11, 12, 13, 99].map(id => new CompositeAccount()
          .setTenantId(createTenant).setAccountId(id).setName(`rollback-${id}`));
        assert.equal(await errorCode(account().creates(failing, 2)), 'DUPLICATE_KEY', 'third batch conflicts with sentinel');
        const failedInserts = events.filter(event => event.kind === 'insert');
        assert.deepEqual(failedInserts.map(event => event.binds.length / 3), [2, 2, 1], 'failure is in third batch');
        assert.equal(await account().tenantId(createTenant).getCount(), 1, 'failed call rolls back earlier batches');
        assert.equal((await account().getByTenantIdAndAccountId(createTenant, 99)).getName(), 'existing');
      } finally { unsubscribe(); }
    } finally {
      try {
        await withCleanup(async () => {
            await (await account().tenantId(createTenant).gets()).delete();
          assert.equal(await account().tenantId(createTenant).getCount(), 0, 'case leaves no rows');
        }, async () => { await (await account().tenantId(createTenant).gets()).delete(); });
      } finally {
        await db.close();
      }
    }
  },
  // Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26.
  async model_write_cycle({ driver, dsn }) {
    const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      assert.equal(db.driver, driver);
      const text = '{"b":1,"a":[],"c":{},"n":1.50}';
      const rollback = new Error('rollback ordered JSON text probe');
      try {
        await db.transaction(async () => {
          const row = await new Author().connect(db).addAllColumns().getBySeq(1);
          assert.ok(row, 'seed author row 1 exists');
          await row.setJsonSetting(StyledValue.value(parseJson(text))).update();
          const stored = await new Author().connect(db).addAllColumns().getBySeq(1);
          assert.ok(stored, 'seed author row 1 remains after update');
          assert.equal(stringifyJson(stored.getJsonSetting().payload()), text, 'ordered JSON text round trip');
          throw rollback;
        }, { retry: 0 });
        assert.fail('ordered JSON text probe transaction unexpectedly committed');
      } catch (error) {
        assert.equal(error, rollback, 'ordered JSON probe rolls back its row update');
      }

      const codecRollback = new Error('rollback codec columns probe');
      let codecCaught = null;
      try {
        await db.transaction(async () => {
          const row = await new Author().connect(db).addAllColumns().getBySeq(1);
          assert.ok(row, 'seed author row 1 exists for codec columns');
          await row.setIp('10.0.0.1')
            .setGzExtend(StyledValue.value('compressed text'))
            .setBase64Extra(StyledValue.value('plain'))
            .update();
          const stored = await new Author().connect(db).addAllColumns().getBySeq(1);
          assert.ok(stored, 'author row remains after codec update');
          assert.equal(stored.getIp(), '10.0.0.1', 'ip codec column round trip');
          assert.equal(stored.getGzExtend().payload(), 'compressed text', 'gz codec column round trip');
          assert.equal(stored.getBase64Extra().payload(), 'plain', 'base64 codec column round trip');
          assert.equal(await new Author().connect(db).ip('10.0.0.1').getCount(), 1, 'ip codec equality');
          assert.equal(
            await errorCode(Promise.resolve().then(() => stored.setIp('10. 0.0.1').update())),
            'CODEC_ENCODE',
            'ip rejects embedded whitespace',
          );
          throw codecRollback;
        }, { retry: 0 });
      } catch (error) {
        codecCaught = error;
      }
      assert.equal(codecCaught, codecRollback, 'codec column probe rolls back its row update');
    } finally { await db.close(); }
  },
}, 300_000);
