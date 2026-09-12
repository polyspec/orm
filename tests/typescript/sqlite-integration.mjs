import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Battle, CompositeAccount, CompositeMembership, ConnectCompiler, Db, Service, SoftRecord } from '../../clients/typescript/dist/index.js';

const endpoint = process.argv[2];
const driver = process.env.ORM_TEST_DRIVER ?? 'sqlite';
const dsn = process.env.ORM_TEST_DSN ?? process.argv[3] ?? '/tmp/orm_bench.sqlite';
if (!endpoint) throw new Error('usage: sqlite-integration.mjs <compiler-endpoint> [database-dsn]');
if (!['mysql', 'postgres', 'sqlite'].includes(driver)) throw new Error(`unsupported ORM_TEST_DRIVER ${driver}`);
const schema = JSON.parse(await readFile('schema/schema.json', 'utf8'));
const vectorPath = driver === 'mysql' ? 'tests/conformance/vectors.json' : `tests/conformance/vectors.${driver}.json`;
const vectors = JSON.parse(await readFile(vectorPath, 'utf8')).vectors;
const expected = name => vectors.find(vector => vector.name === name)?.expect.result;
const statements = [];
const options = {
  schemaHash: schema.schema_hash,
  compiler: new ConnectCompiler(endpoint),
  aesKey: 'bench-salt',
  blindIndexKey: 'bench-blind-index',
  onQuery: event => statements.push({ sql: event.sql, binds: event.binds }),
};
const db = await Db[driver](dsn, options);
try {
  const count = await Battle().using(db).getCountByServiceSeq(7);
  const expectedCount = expected('bound_count_finder');
  if (count !== expectedCount) throw new Error(`count=${count}, want ${expectedCount}`);
  const row = await Battle().using(db).getBySeq(42);
  if (row?.getSeq() !== 42 || row.getName() !== 'battle-42') throw new Error('single-row assembly failed');
  const indexed = await Battle().using(db).getByAesHexEmail('user42@example.com');
  if (indexed?.getSeq() !== 42) throw new Error('AES equality did not use blind index');
  const rows = await Battle().using(db).serviceSeq(7).isClose(false).orderBySeqDesc().limit(0, 5).gets();
  const expectedKeys = expected('list_order_limit').map(entry => entry[0]);
  if (rows.length !== expectedKeys.length || rows.keys().join(',') !== expectedKeys.join(',')) throw new Error(`ordered collection=${rows.keys().join(',')}`);
  const joined = await Battle().using(db).join(Service().where(where => where.name('service-7'))).seq(6).get();
  if (joined?.getService()?.getName() !== 'service-7') throw new Error('join assembly failed');
  const before = statements.length;
  const statement = await Battle().using(db).serviceSeq(7).selectAesHexEmail().limit(0, 1).sql();
  if (statements.length !== before || !statement.sql.includes('aes_hex_email')) throw new Error('sql terminal executed a statement or omitted selection');
  const tenantId = 910010;
  await CompositeMembership().tenantIdEq(tenantId).using(db).delete();
  await CompositeAccount().tenantIdEq(tenantId).using(db).delete();
  for (const accountId of [11, 12]) {
    const account = await CompositeAccount().setTenantId(tenantId).setAccountId(accountId).setName(`account-${accountId}`).using(db).insert();
    const member = await CompositeMembership().setTenantId(tenantId).setAccountId(accountId).setRole('reader').using(db).insert();
    if (account?.getTenantId() !== tenantId || account.getAccountId() !== accountId || member?.getAccountId() !== accountId) throw new Error('composite insert did not return the complete identity');
  }
  const first = await CompositeMembership().using(db).getByTenantIdAndAccountId(tenantId, 11);
  if (!first) throw new Error('composite primary-key finder failed');
  first.setRole('owner');
  await first.update();
  const second = await CompositeMembership().setTenantId(tenantId).setAccountId(12).setRole('editor').using(db).save();
  if (second?.getRole() !== 'editor') throw new Error('composite save did not use every key component');
  const page = await CompositeMembership().tenantIdEq(tenantId).orderByTenantIdAsc().orderByAccountIdAsc().using(db).paginate(1, 1);
  if (page.total !== 2 || page.items.length !== 1 || page.items.first()?.getAccountId() !== 11) throw new Error('composite pagination order differs');
  const firstKeyset = await Battle().serviceSeq(7).orderBySeqAsc().using(db).getsAfter('', 2);
  const secondKeyset = await Battle().serviceSeq(7).orderBySeqAsc().using(db).getsAfter(firstKeyset.nextCursor, 2);
  if (firstKeyset.items.length !== 2 || firstKeyset.nextCursor === '' || (secondKeyset.items.first()?.getSeq() ?? 0) <= (firstKeyset.items.first()?.getSeq() ?? 0)) throw new Error('keyset after is not ordered and exclusive');
  const previousKeyset = await Battle().serviceSeq(7).orderBySeqAsc().using(db).getsBefore(secondKeyset.previousCursor, 2);
  if (previousKeyset.items.first()?.getSeq() !== firstKeyset.items.first()?.getSeq()) throw new Error('keyset before did not restore request order');
  const accounts = await CompositeAccount().tenantIdEq(tenantId).orderByAccountIdAsc().relations(CompositeMembership()).using(db).gets();
  if (accounts.length !== 2 || accounts.first()?.getMemberships().length !== 1) throw new Error('composite relation omitted a key component');
  if (await CompositeAccount().tenantIdEq(tenantId).hasMemberships(() => {}).using(db).getCount() !== 2) throw new Error('relation exists predicate failed');
  if (await CompositeAccount().tenantIdEq(tenantId).countMembershipsEq(1, () => {}).using(db).getCount() !== 2) throw new Error('relation count predicate failed');
  await first.delete();
  if (await CompositeMembership().tenantIdEq(tenantId).using(db).getCount() !== 1) throw new Error('composite row delete omitted a key component');
  await CompositeMembership().tenantIdEq(tenantId).using(db).delete();
  await CompositeAccount().tenantIdEq(tenantId).using(db).delete();
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
      if (updated?.getName() !== 'typescript-updated' || updated.getLikeCount() !== 4 || updated.getAesHexEmail() !== 'typescript@example.com') {
        throw new Error(`row update or codec round trip failed: name=${JSON.stringify(updated?.getName())} like_count=${JSON.stringify(updated?.getLikeCount())} aes_hex_email=${JSON.stringify(updated?.getAesHexEmail())}`);
      }
      await updated.delete();
      if (await Battle().using(transaction).getCountBySeq(createdSeq) !== 0) throw new Error('row delete failed');
      await CompositeAccount().setTenantId(tenantId).setAccountId(13).setName('rollback').using(transaction).insert();
      await CompositeMembership().setTenantId(tenantId).setAccountId(13).setRole('rollback').using(transaction).insert();
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  if (createdSeq === undefined || await Battle().using(db).getCountBySeq(createdSeq) !== 0) throw new Error('transaction rollback state differs');
  if (await CompositeAccount().tenantIdEq(tenantId).accountIdEq(13).using(db).getCount() !== 0) throw new Error('composite transaction rollback retained rows');
  const soft = await SoftRecord().setName('soft-delete').using(db).insert();
  if (!soft || await SoftRecord().using(db).getCount() !== 1) throw new Error('soft-delete insert was not visible');
  await soft.delete();
  if (await SoftRecord().using(db).getCount() !== 0 || await SoftRecord().using(db).getBySeq(soft.getSeq()) !== null) throw new Error('soft-delete row remained visible');
  const batchPrefix = `tb-${Date.now().toString(36)}`;
  const batchDraft = (uuid, name, readCount = 1) => Battle()
    .setUuid(uuid).setName(name).setReadCount(readCount)
    .setUserSeq(1).setServiceSeq(999).setServiceModuleSeq(1).setServiceMemberSeq(1)
    .setStartDt('2026-06-01 00:00:00.000000').setEndDt('2026-12-31 00:00:00.000000');
  const batchCleanup = async () => {
    for (const suffix of ['insert', 'insert-2', 'upsert', 'rollback']) await Battle().uuidEq(`${batchPrefix}-${suffix}`).using(db).delete();
  };
  await batchCleanup();
  const batchInserted = await Battle().using(db).batchInsert([
    batchDraft(`${batchPrefix}-insert`, 'batch-1'),
    batchDraft(`${batchPrefix}-insert-2`, 'batch-2', 2),
  ], { chunkSize: 1 });
  if (batchInserted.attempted !== 2 || batchInserted.affected !== 2 || batchInserted.inserted !== 2) throw new Error('batch insert result differs');
  const batchRow = await Battle().uuidEq(`${batchPrefix}-insert`).using(db).get();
  if (!batchRow) throw new Error('batch insert row missing');
  let batchUpsert = await Battle().using(db).batchUpsert([batchDraft(`${batchPrefix}-upsert`, 'upsert-1')], { chunkSize: 1 });
  if (batchUpsert.attempted !== 1 || batchUpsert.affected !== 1 || batchUpsert.inserted !== 1) throw new Error('batch upsert insert result differs');
  batchUpsert = await Battle().using(db).batchUpsert([batchDraft(`${batchPrefix}-upsert`, 'upsert-2', 9).onDuplicateSetName('upsert-2')], { chunkSize: 1 });
  if (batchUpsert.attempted !== 1 || batchUpsert.affected !== 1) throw new Error('batch upsert update result differs');
  const batchUpdated = await Battle().using(db).batchUpdate([Battle().seqEq(batchRow.getSeq()).setName('batch-updated')], { chunkSize: 1 });
  if (batchUpdated.attempted !== 1 || batchUpdated.affected !== 1) throw new Error('batch update result differs');
  const batchDeleted = await Battle().using(db).batchDelete([
    Battle().seqEq(batchRow.getSeq()), Battle().uuidEq(`${batchPrefix}-insert-2`),
  ], { chunkSize: 1 });
  if (batchDeleted.attempted !== 2 || batchDeleted.affected !== 2) throw new Error('batch delete result differs');
  let batchRollbackFailed = false;
  try {
    await Battle().using(db).batchInsert([
      batchDraft(`${batchPrefix}-rollback`, 'rollback-1'),
      batchDraft(`${batchPrefix}-rollback`, 'rollback-2', 2),
    ], { chunkSize: 1 });
  } catch { batchRollbackFailed = true; }
  if (!batchRollbackFailed || await Battle().uuidEq(`${batchPrefix}-rollback`).using(db).getCount() !== 0) throw new Error('batch rollback differs');
  await batchCleanup();
} finally {
  await db.close();
}
if (driver === 'sqlite') {
  const configRoot = await mkdtemp(join(tmpdir(), 'orm-typescript-config-'));
  try {
  const configPath = join(configRoot, 'orm.toml');
  await writeFile(configPath, `schema = ${JSON.stringify(resolve('schema/schema.json'))}\n[db]\ndriver = "sqlite"\ndsn = ${JSON.stringify(resolve(dsn))}\npool = 1\n[secrets]\nblind_index = "bench-blind-index"\naes_version = 2\n[secrets.aes_keys]\n1 = "old-key"\n2 = "bench-salt"\n[ormd]\nendpoint = ${JSON.stringify(endpoint)}\ntimeout_ms = 5000\n`);
  const configured = await Db.fromConfig(configPath);
  try {
    if (await Battle().using(configured).getCountByServiceSeq(7) !== expected('bound_count_finder')) throw new Error('orm.toml query result differs');
  } finally { await configured.close(); }
  } finally { await rm(configRoot, { recursive: true, force: true }); }
}
console.log(`typescript ${driver} integration: read, join, SQL dump, write, composite keys, row state, codec, and transaction passed`);
