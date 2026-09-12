import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AesKeyring, Db, Row, hostDecode, hostEncode, openSqlite, registerRow } from '../../clients/typescript/dist/index.js';

class ItemRow extends Row {
  static entity() { return 'item'; }
  static primaryKey() { return 'seq'; }
  static columns() { return { seq: 'i64', name: 'string', parent_seq: 'i64' }; }
}
class ChildRow extends Row {
  static entity() { return 'child'; }
  static primaryKey() { return 'seq'; }
  static columns() { return { seq: 'i64', parent_seq: 'i64', name: 'string' }; }
}
registerRow('item', ItemRow);
registerRow('child', ChildRow);

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
], children: [{ rel: 'children', kind: 'many', step: 1, parent_column: 'seq', parent_index: 0, child_column: 'parent_seq', child_index: 1, key_by: 'seq', key_index: 0, flatten: false, cascade: true }] };
const childAssembly = { entity: 'child', alias: 'b', columns: [
  { index: 0, name: 'seq', column: 'seq', type: 'i64', styles: [], hidden: false },
  { index: 1, name: 'parent_seq', column: 'parent_seq', type: 'i64', styles: [], hidden: false },
  { index: 2, name: 'name', column: 'name', type: 'string', styles: [], hidden: false },
], children: [] };
const plan = { schema_hash: 'hash', kind: 'all', steps: [
  { id: 0, role: 'main', sql: 'main', bind_slots: [], assemble: itemAssembly },
  { id: 1, role: 'relation', sql: 'children (?)', bind_slots: [{ from: 'parent', param: 0, transform: '', name: '', step: 0, column: '', host_styles: [], col_type: '' }], parent: { step: 0, column: 'seq', index: 0 }, assemble: childAssembly },
] };
const items = await db.execute(plan, []);
if (items.length !== 2 || items.first().column('name') !== 'first') throw new Error('root assembly failed');
const children = items.first().relation('children');
if (children.length !== 2 || children.keys().join(',') !== '10,11') throw new Error('relation assembly failed');
if (calls[2].sql !== 'children (?, ?)' || calls[2].params.join(',') !== '1,2') throw new Error('parent bind expansion failed');

const count = await db.execute({ schema_hash: 'hash', kind: 'count', steps: [{ id: 0, role: 'count', sql: 'count', bind_slots: [] }] }, []);
if (count !== 2) throw new Error('scalar execution failed');
const write = await db.execute({ schema_hash: 'hash', kind: 'insert', steps: [{ id: 0, role: 'main', sql: 'write', bind_slots: [] }] }, []);
if (write.affected !== 1 || write.insertId !== 8) throw new Error('write execution failed');

const directory = await mkdtemp(join(tmpdir(), 'orm-aes-'));
const sqliteConnection = openSqlite(join(directory, 'rotation.sqlite'));
const sqliteDb = new Db(sqliteConnection, { schemaHash: 'hash', compiler: transport });
try {
  await sqliteConnection.execute('CREATE TABLE "orm_aes_rotation_test" ("id" INTEGER PRIMARY KEY, "aes_key_version" INTEGER NOT NULL, "aes_hex_email" TEXT, "aes_hex_phone" TEXT)', []);
  await sqliteConnection.execute('INSERT INTO "orm_aes_rotation_test" ("id", "aes_key_version", "aes_hex_email", "aes_hex_phone") VALUES (?, ?, ?, ?)', [1, 1, hostEncode('member@example.test', ['aes', 'hex'], 'rotation-key-v1'), hostEncode('01012345678', ['aes', 'hex'], 'rotation-key-v1')]);
  const spec = { table: 'orm_aes_rotation_test', primaryKey: 'id', versionColumn: 'aes_key_version', columns: [{ name: 'aes_hex_email', styles: ['aes', 'hex'] }, { name: 'aes_hex_phone', styles: ['aes', 'hex'] }] };
  const keyring = new AesKeyring(new Map([[1, 'rotation-key-v1'], [2, 'rotation-key-v2']]), 2);
  const before = await sqliteDb.aesStatus(spec, keyring);
  const changed = await sqliteDb.rotateAESRows(spec, keyring);
  const after = await sqliteDb.aesStatus(spec, keyring);
  const repeated = await sqliteDb.rotateAESRows(spec, keyring);
  if (before.total !== 1 || before.pending !== 1 || before.versions['1'] !== 1) throw new Error('AES source status differs');
  if (changed !== 1 || after.pending !== 0 || after.versions['2'] !== 1 || repeated !== 0) throw new Error('AES rotation is not idempotent');
  const stored = (await sqliteConnection.execute('SELECT "aes_key_version", "aes_hex_email", "aes_hex_phone" FROM "orm_aes_rotation_test" WHERE "id" = 1', [])).rows[0];
  if (Number(stored[0]) !== 2 || hostDecode(stored[1], ['aes', 'hex'], 'rotation-key-v2') !== 'member@example.test' || hostDecode(stored[2], ['aes', 'hex'], 'rotation-key-v2') !== '01012345678') throw new Error('AES rotated values differ');
} finally {
  await sqliteDb.close();
  await rm(directory, { recursive: true, force: true });
}
console.log('typescript database: scalar, write, root, relation, parent expansion, and AES rotation passed');
