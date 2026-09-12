import { readFile } from 'node:fs/promises';
import { Battle, ConnectCompiler, Db, Service } from '../../clients/typescript/dist/index.js';

const endpoint = process.argv[2];
const path = process.argv[3] ?? '/tmp/orm_bench.sqlite';
if (!endpoint) throw new Error('usage: sqlite-integration.mjs <compiler-endpoint> [database-path]');
const schema = JSON.parse(await readFile('schema/schema.json', 'utf8'));
const vectors = JSON.parse(await readFile('tests/conformance/vectors.sqlite.json', 'utf8')).vectors;
const expected = name => vectors.find(vector => vector.name === name)?.expect.result;
const statements = [];
const db = await Db.sqlite(path, {
  schemaHash: schema.schema_hash,
  compiler: new ConnectCompiler(endpoint),
  aesKey: 'bench-salt',
  onQuery: event => statements.push({ sql: event.sql, binds: event.binds }),
});
try {
  const count = await Battle().using(db).getCountByServiceSeq(7);
  const expectedCount = expected('bound_count_finder');
  if (count !== expectedCount) throw new Error(`count=${count}, want ${expectedCount}`);
  const row = await Battle().using(db).getBySeq(42);
  if (row?.getSeq() !== 42 || row.getName() !== 'battle-42') throw new Error('single-row assembly failed');
  const rows = await Battle().using(db).serviceSeq(7).isClose(false).orderBySeqDesc().limit(0, 5).gets();
  const expectedKeys = expected('list_order_limit').map(entry => entry[0]);
  if (rows.length !== expectedKeys.length || rows.keys().join(',') !== expectedKeys.join(',')) throw new Error(`ordered collection=${rows.keys().join(',')}`);
  const joined = await Battle().using(db).join(Service().where(where => where.name('service-7'))).seq(6).get();
  if (joined?.getService()?.getName() !== 'service-7') throw new Error('join assembly failed');
  const before = statements.length;
  const statement = await Battle().using(db).serviceSeq(7).selectAesHexEmail().limit(0, 1).sql();
  if (statements.length !== before || !statement.sql.includes('aes_hex_email')) throw new Error('sql terminal executed a statement or omitted selection');
  const rollback = new Error('rollback');
  let createdSeq;
  try {
    await db.transaction(async transaction => {
      const created = await Battle().using(transaction)
        .setName('typescript-write').setUserSeq(1).setServiceSeq(7).setServiceModuleSeq(1).setServiceMemberSeq(1)
        .setStartDt('2026-09-12 00:00:00.000000').setEndDt('2026-09-13 00:00:00.000000').setAesHexEmail('typescript@example.com').insert();
      if (!created) throw new Error('insert did not read the row back');
      createdSeq = created.getSeq();
      created.setName('typescript-updated').setLikeCount(4);
      await created.updateOptimistic();
      const updated = await Battle().using(transaction).getBySeq(createdSeq);
      if (updated?.getName() !== 'typescript-updated' || updated.getLikeCount() !== 4 || updated.getAesHexEmail() !== 'typescript@example.com') throw new Error('row update or codec round trip failed');
      await updated.delete();
      if (await Battle().using(transaction).getCountBySeq(createdSeq) !== 0) throw new Error('row delete failed');
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  if (createdSeq === undefined || await Battle().using(db).getCountBySeq(createdSeq) !== 0) throw new Error('transaction rollback state differs');
} finally {
  await db.close();
}
console.log('typescript SQLite integration: read, join, SQL dump, write, row state, codec, and transaction passed');
