import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { caseTest, withTemporaryDirectory } from '../../../tests/testcase.mts';
import { createDbspecPhysicalDatabaseRunner, withDbspecPhysicalDatabase } from './dbspec-physical-database.mjs';

caseTest('creates distinct process-scoped fixture names through the shared runner', 5000, async () => {
  const withDatabase = createDbspecPhysicalDatabaseRunner({ namePrefix: 'unit', filePrefix: 'unit' });
  const names = [];
  for (let i = 0; i < 2; i++) {
    await withDatabase('sqlite', async (_session, _open, name) => names.push(name));
  }
  assert.deepEqual(names, [`unit_ts${process.pid}_000`, `unit_ts${process.pid}_001`]);
});

caseTest('runs a SQLite physical fixture through shared session operations and removes its files', 5000, async () => {
  await withTemporaryDirectory('orm-dbspec-physical-', async directory => {
    await withDbspecPhysicalDatabase({
      dialect: 'sqlite', name: 'primary', sqliteDirectory: directory,
      body: async (session, open, name) => {
        assert.equal(name, 'primary');
        await session.exec('CREATE TABLE item (value TEXT NOT NULL)');
        await session.exec("INSERT INTO item VALUES ('first')");
        assert.deepEqual(await session.rows('SELECT value FROM item'), [['first']]);
        const second = await open();
        try {
          await second.exec("INSERT INTO item VALUES ('second')");
          assert.deepEqual(await second.rows('SELECT value FROM item ORDER BY rowid'), [['first'], ['second']]);
          await second.execute(second.connection, "INSERT INTO item VALUES ('third')");
          assert.deepEqual(await second.rows('SELECT value FROM item ORDER BY rowid'), [['first'], ['second'], ['third']]);
        } finally {
          await second.close();
        }
      },
    });
    assert.deepEqual(readdirSync(directory), []);
  });
});

caseTest('removes the SQLite physical fixture when the case fails', 5000, async () => {
  await withTemporaryDirectory('orm-dbspec-physical-failure-', async directory => {
    await assert.rejects(withDbspecPhysicalDatabase({
      dialect: 'sqlite', name: 'failure', sqliteDirectory: directory,
      body: async (session, _open, name) => {
        assert.equal(name, 'failure');
        await session.exec('CREATE TABLE item (value TEXT NOT NULL)');
        throw new Error('case failed');
      },
    }), { message: 'case failed' });
    assert.deepEqual(readdirSync(directory), []);
  });
});
