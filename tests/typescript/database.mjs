import { Db, Row, registerRow } from '../../clients/typescript/dist/index.js';

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
console.log('typescript database: scalar, write, root, relation, and parent expansion passed');
