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
} finally {
  await db.close();
}
console.log('typescript SQLite integration: count, row, collection, join, and SQL dump passed');
