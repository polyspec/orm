import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AesKeyring, Db, QueryCore, Row, batchWrite, hostDecode, hostEncode, openSqlite, registerRow } from '../../clients/typescript/dist/index.js';

class ItemRow extends Row {
  static entity() { return 'item'; }
  static primaryKeys() { return ['seq']; }
  static columns() { return { seq: 'i64', name: 'string', parent_seq: 'i64' }; }
}
class ChildRow extends Row {
  static entity() { return 'child'; }
  static primaryKeys() { return ['seq']; }
  static columns() { return { seq: 'i64', parent_seq: 'i64', name: 'string' }; }
}
registerRow('item', ItemRow);
registerRow('child', ChildRow);

class CompositeInsertQuery extends QueryCore {
  assigned(keys) { return this.assignedKeyValues(keys); }
}
const completeInsert = new CompositeInsertQuery('membership').set('tenant_id', 7).set('account_id', 11).set('name', 'created');
if (completeInsert.assigned(['tenant_id', 'account_id']).join(',') !== '7,11' || completeInsert.request.ir.set.length !== 3 || completeInsert.request.ir.where !== undefined) throw new Error('composite insert key inspection changed the request');
const partialInsert = new CompositeInsertQuery('membership').set('tenant_id', 7).set('name', 'created');
let partialInsertRejected = false;
try { partialInsert.assigned(['tenant_id', 'account_id']); } catch (error) { partialInsertRejected = error?.code === 'IR_INVALID'; }
if (!partialInsertRejected || partialInsert.request.ir.set.length !== 2 || partialInsert.request.ir.where !== undefined) throw new Error('partial composite insert changed the request');

const calls = [];
const connection = {
  name: 'sqlite',
  async execute(sql, params) {
    calls.push({ sql, params });
    if (sql === 'main') return { rows: [[1, 'first'], [2, 'second']], columns: ['seq', 'name'], affected: 0, insertId: null };
    if (sql.startsWith('children')) return { rows: [[10, 1, 'a'], [11, 1, 'b']], columns: ['seq', 'parent_seq', 'name'], affected: 0, insertId: null };
    if (sql === 'count') return { rows: [[2]], columns: ['count'], affected: 0, insertId: null };
    if (sql === 'write') return { rows: [], columns: [], affected: 1, insertId: 8 };
    throw new Error(`unexpected SQL ${sql}`);
  },
  async begin() { throw new Error('unused'); },
  async close() {},
};
const transport = { async compile() { throw new Error('unused'); }, async metadata() { throw new Error('unused'); } };
const db = new Db(connection, { schemaHash: 'hash', compiler: transport, onQuery: event => calls.push({ event }) });
const itemAssembly = { entity: 'item', alias: 'a', columns: [
  { index: 0, name: 'seq', column: 'seq', type: 'i64', styles: [], hidden: false },
  { index: 1, name: 'name', column: 'name', type: 'string', styles: [], hidden: false },
], children: [{ rel: 'children', kind: 'many', step: 1, parent_keys: [{ column: 'seq', index: 0 }], child_keys: [{ column: 'parent_seq', index: 1 }], key: [{ column: 'seq', index: 0 }], flatten: false, cascade: true }], key: [{ column: 'seq', index: 0 }] };
const childAssembly = { entity: 'child', alias: 'b', columns: [
  { index: 0, name: 'seq', column: 'seq', type: 'i64', styles: [], hidden: false },
  { index: 1, name: 'parent_seq', column: 'parent_seq', type: 'i64', styles: [], hidden: false },
  { index: 2, name: 'name', column: 'name', type: 'string', styles: [], hidden: false },
], children: [], key: [{ column: 'seq', index: 0 }] };
const plan = { schema_hash: 'hash', kind: 'all', steps: [
  { id: 0, role: 'main', sql: 'main', bind_slots: [], assemble: itemAssembly },
  { id: 1, role: 'relation', sql: 'children (?)', bind_slots: [{ from: 'parent', param: 0, transform: '', name: '', step: 0, column: '', host_styles: [], col_type: '' }], parent: { step: 0, keys: [{ column: 'seq', index: 0 }] }, assemble: childAssembly },
] };
const items = await db.execute(plan, []);
if (items.length !== 2 || items.first().column('name') !== 'first') throw new Error('root assembly failed');
const children = items.first().relation('children');
if (children.length !== 2 || children.keys().join(',') !== '10,11') throw new Error('relation assembly failed');
if (calls[2].sql !== 'children (?, ?)' || calls[2].params.join(',') !== '1,2') throw new Error('parent bind expansion failed');

const compositeCalls = [];
const compositeConnection = {
  name: 'sqlite',
  async execute(sql, params) {
    compositeCalls.push({ sql, params });
    if (sql === 'composite-main') return { rows: [[1, 2], [1, 3], [1, 2]], columns: [], affected: 0, insertId: null };
    if (sql.startsWith('composite-children')) return { rows: [[10, 1, 2], [11, 1, 3]], columns: [], affected: 0, insertId: null };
    throw new Error(`unexpected composite SQL ${sql}`);
  },
  async begin() { throw new Error('unused'); },
  async close() {},
};
const compositeDb = new Db(compositeConnection, { schemaHash: 'hash', compiler: transport });
const compositeChild = { entity: 'child', alias: 'c', columns: [
  { index: 0, name: 'seq', column: 'seq', type: 'i64', styles: [], hidden: false },
  { index: 1, name: 'tenant_id', column: 'tenant_id', type: 'i64', styles: [], hidden: false },
  { index: 2, name: 'parent_id', column: 'parent_id', type: 'i64', styles: [], hidden: false },
], children: [], key: [{ column: 'seq', index: 0 }] };
const compositeRoot = { entity: 'item', alias: 'p', columns: [
  { index: 0, name: 'tenant_id', column: 'tenant_id', type: 'i64', styles: [], hidden: false },
  { index: 1, name: 'seq', column: 'seq', type: 'i64', styles: [], hidden: false },
], children: [{ rel: 'children', kind: 'many', step: 1, parent_keys: [{column:'tenant_id',index:0},{column:'seq',index:1}], child_keys: [{column:'tenant_id',index:1},{column:'parent_id',index:2}], key: [{column:'seq',index:0}], flatten:false, cascade:true }], key: [{column:'tenant_id',index:0},{column:'seq',index:1}] };
await compositeDb.execute({ schema_hash:'hash', kind:'all', steps:[
  { id:0, role:'main', sql:'composite-main', bind_slots:[], assemble:compositeRoot },
  { id:1, role:'relation', sql:'composite-children ((?))', bind_slots:[{from:'parent',param:0,transform:'',name:'',step:0,column:'',host_styles:[],col_type:''}], parent:{step:0,keys:[{column:'tenant_id',index:0},{column:'seq',index:1}]}, assemble:compositeChild },
] }, []);
if (compositeCalls[1].sql !== 'composite-children ((?, ?), (?, ?))' || compositeCalls[1].params.join(',') !== '1,2,1,3') throw new Error('composite parent expansion or tuple deduplication failed');

const count = await db.execute({ schema_hash: 'hash', kind: 'count', steps: [{ id: 0, role: 'count', sql: 'count', bind_slots: [] }] }, []);
if (count !== 2) throw new Error('scalar execution failed');
const bundleRequest = { ir_version: 1, schema_hash: 'hash', kind: 'count', entity: 'item', n_params: 0 };
const bundleHash = createHash('sha256').update(JSON.stringify(bundleRequest, Object.keys(bundleRequest).sort())).digest('hex');
db.loadPlanBundle({ version: 1, schema_hash: 'hash', dialect: 'sqlite', request_sha256: bundleHash, plan: { schema_hash: 'hash', kind: 'count', steps: [{ id: 0, role: 'count', sql: 'count', bind_slots: [] }] } }, bundleRequest);
if ((await db.plan(bundleRequest)).steps[0].sql !== 'count') throw new Error('precompiled plan was not loaded into the cache');
const planCompilerCalls = [];
const planCompiler = {
  async compile(request) {
    const names = { 1: 'one', 2: 'all', 3: 'count' };
    planCompilerCalls.push(names[request.kind]);
    return { schemaHash: 'hash', kind: request.kind, steps: [{ id: 0, role: 'main', sql: names[request.kind], binds: [] }] };
  },
  async metadata() { return { schemaHash: 'hash', dialect: 'sqlite', irVersion: 1 }; },
};
const cacheDb = new Db(connection, { schemaHash: 'hash', compiler: planCompiler, planCacheSize: 2 });
const cacheRequests = ['all', 'count', 'one'].map(kind => ({ ir_version: 1, schema_hash: 'hash', kind, entity: 'item', n_params: 0 }));
for (const request of cacheRequests) await cacheDb.plan(request);
await cacheDb.plan(cacheRequests[0]);
if (planCompilerCalls.join(',') !== 'all,count,one,all') throw new Error('TypeScript plan cache did not evict the oldest shape');
await cacheDb.close();
let closedPlanRejected = false;
try { await cacheDb.plan(cacheRequests[1]); } catch (error) { closedPlanRejected = error?.code === 'CONFIG'; }
if (!closedPlanRejected) throw new Error('TypeScript plan cache accepted a request after close');
const write = await db.execute({ schema_hash: 'hash', kind: 'insert', steps: [{ id: 0, role: 'main', sql: 'write', bind_slots: [] }] }, []);
if (write.affected !== 1 || write.insertId !== 8) throw new Error('write execution failed');
const emptyBatch = await batchWrite(db, [], 'insert', { chunkSize: 1 });
if (emptyBatch.attempted !== 0 || emptyBatch.affected !== 0 || emptyBatch.inserted !== 0) throw new Error('empty batch result differs');
const batchEvents = [];
const batchConnection = {
  ...connection,
  async begin() {
    return { name: 'sqlite', execute: connection.execute, async commit() { batchEvents.push('commit'); }, async rollback() { batchEvents.push('rollback'); }, async savepoint() {}, async rollbackTo() {}, async releaseSavepoint() {} };
  },
};
const batchDb = new Db(batchConnection, { schemaHash: 'hash', compiler: transport });
const batchPlan = { schema_hash: 'hash', kind: 'insert', steps: [{ id: 0, role: 'main', sql: 'write', bind_slots: [] }] };
const batch = await batchWrite(batchDb, [{ plan: batchPlan, params: [] }, { plan: batchPlan, params: [] }], 'insert', { chunkSize: 1 });
if (batch.attempted !== 2 || batch.affected !== 2 || batch.inserted !== 2 || batchEvents.join(',') !== 'commit') throw new Error('batch transaction or result differs');
await batchDb.close();
let invalidBatchRejected = false;
try { await batchWrite(db, [], 'merge'); } catch (error) { invalidBatchRejected = error?.code === 'CONFIG'; }
if (!invalidBatchRejected) throw new Error('invalid batch kind was accepted');

const directory = await mkdtemp(join(tmpdir(), 'orm-aes-'));
const sqliteConnection = openSqlite(join(directory, 'rotation.sqlite'));
const sqliteDb = new Db(sqliteConnection, { schemaHash: 'hash', compiler: transport });
try {
  await sqliteConnection.execute('CREATE TABLE "orm_stream_test" ("seq" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)', []);
  await sqliteConnection.execute('INSERT INTO "orm_stream_test" ("seq", "name") VALUES (?, ?), (?, ?), (?, ?)', [1, 'first', 2, 'second', 3, 'third']);
  const streamAssembly = { entity: 'item', alias: 'a', columns: [
    { index: 0, name: 'seq', column: 'seq', type: 'i64', styles: [], hidden: false },
    { index: 1, name: 'name', column: 'name', type: 'string', styles: [], hidden: false },
  ], children: [], key: [{ column: 'seq', index: 0 }] };
  const streamPlan = { schema_hash: 'hash', kind: 'all', steps: [{ id: 0, role: 'main', sql: 'SELECT "seq", "name" FROM "orm_stream_test" ORDER BY "seq"', bind_slots: [], assemble: streamAssembly }] };
  const streamed = [];
  const stopped = await sqliteDb.stream(streamPlan, [], row => { streamed.push(row); return streamed.length < 2; });
  if (stopped.state !== 'stopped' || stopped.count !== 2 || streamed[0] === streamed[1] || streamed[0].column('seq') === streamed[1].column('seq')) throw new Error('ORM stream stop or row ownership differs');
  const exhausted = await sqliteDb.stream(streamPlan, [], () => true);
  if (exhausted.state !== 'exhausted' || exhausted.count !== 3) throw new Error('ORM stream exhaustion differs');
  let relationRejected = false;
  try { await sqliteDb.stream(plan, [], () => true); } catch (error) { relationRejected = error?.code === 'IR_INVALID'; }
  if (!relationRejected) throw new Error('ORM relation stream was accepted');
  let visitorFailed = false;
  try { await sqliteDb.stream(streamPlan, [], () => { throw new Error('stream visitor error'); }); } catch (error) { visitorFailed = error?.message === 'stream visitor error'; }
  if (!visitorFailed || Number((await sqliteConnection.execute('SELECT COUNT(*) FROM "orm_stream_test"', [])).rows[0][0]) !== 3) throw new Error('ORM stream error did not close the iterator');

  await sqliteConnection.execute('CREATE TABLE "orm_aes_rotation_test" ("tenant_id" INTEGER NOT NULL, "id" INTEGER NOT NULL, "aes_key_version" INTEGER NOT NULL, "aes_hex_email" TEXT, "aes_hex_phone" TEXT, PRIMARY KEY ("tenant_id", "id"))', []);
  const encrypted = [hostEncode('member@example.test', ['aes', 'hex'], 'rotation-key-v1'), hostEncode('01012345678', ['aes', 'hex'], 'rotation-key-v1')];
  await sqliteConnection.execute('INSERT INTO "orm_aes_rotation_test" ("tenant_id", "id", "aes_key_version", "aes_hex_email", "aes_hex_phone") VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)', [7, 1, 1, ...encrypted, 7, 2, 1, ...encrypted]);
  const spec = { table: 'orm_aes_rotation_test', primaryKeys: ['tenant_id', 'id'], versionColumn: 'aes_key_version', columns: [{ name: 'aes_hex_email', styles: ['aes', 'hex'] }, { name: 'aes_hex_phone', styles: ['aes', 'hex'] }], batchSize: 1 };
  const keyring = new AesKeyring(new Map([[1, 'rotation-key-v1'], [2, 'rotation-key-v2']]), 2);
  const before = await sqliteDb.aesStatus(spec, keyring);
  const changed = await sqliteDb.rotateAESRows(spec, keyring);
  const resumed = await sqliteDb.rotateAESRows(spec, keyring);
  const after = await sqliteDb.aesStatus(spec, keyring);
  const repeated = await sqliteDb.rotateAESRows(spec, keyring);
  if (before.total !== 2 || before.pending !== 2 || before.versions['1'] !== 2) throw new Error('AES source status differs');
  if (changed !== 1 || resumed !== 1 || after.pending !== 0 || after.versions['2'] !== 2 || repeated !== 0) throw new Error('AES rotation is not bounded or idempotent');
  const stored = (await sqliteConnection.execute('SELECT "aes_key_version", "aes_hex_email", "aes_hex_phone" FROM "orm_aes_rotation_test" WHERE "tenant_id" = 7 AND "id" = 1', [])).rows[0];
  if (Number(stored[0]) !== 2 || hostDecode(stored[1], ['aes', 'hex'], 'rotation-key-v2') !== 'member@example.test' || hostDecode(stored[2], ['aes', 'hex'], 'rotation-key-v2') !== '01012345678') throw new Error('AES rotated values differ');
} finally {
  await sqliteDb.close();
  await rm(directory, { recursive: true, force: true });
}
console.log('typescript database: scalar, write, root, relation, stream, parent expansion, and AES rotation passed');
