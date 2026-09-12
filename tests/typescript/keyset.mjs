import assert from 'node:assert/strict';
import { QueryCore, decodeKeysetCursor, encodeKeysetCursor } from '../../clients/typescript/dist/index.js';

const order = [{ column: 'name', desc: true }, { column: 'seq' }];
const cursor = encodeKeysetCursor(order, ['n', 42]);
const decoded = decodeKeysetCursor(cursor);
assert.deepEqual(decoded.order, order);
assert.deepEqual(decoded.values, [
  { type: 'string', value: 'n' },
  { type: 'i64', value: '42' },
]);

const query = new QueryCore('battle');
query.orderBy('name', true).keyset('after', cursor, 20, ['seq']);
assert.deepEqual(query.request.ir.order, order);
assert.deepEqual(query.request.ir.limit, { offset: 0, count: 20 });
assert.deepEqual(query.request.ir.keyset, { direction: 'after', values: [0, 1] });
assert.deepEqual(query.parameters(), ['n', 42]);

assert.throws(() => decodeKeysetCursor(cursor.slice(0, -1)), /CURSOR_INVALID/);
assert.throws(() => new QueryCore('battle').orderByExpression('name').keyset('after', '', 20, ['seq']), /CURSOR_INVALID/);
assert.throws(() => new QueryCore('battle').keyset('after', '', 0, ['seq']), /IR_INVALID/);

console.log('typescript keyset: codec, order, boundary, and validation checks passed');
