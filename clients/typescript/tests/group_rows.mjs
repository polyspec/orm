import { GroupRow, GroupRows, OrmError } from '../dist/index.js';

const row = new GroupRow([['is_close', false], ['row_count', 3]]);
if (row.count !== 3 || row.value('is_close') !== false || JSON.stringify(row.toArray()) !== '{"is_close":false,"row_count":3}') {
  throw new Error('group result lost a selected value or count');
}
try {
  row.value('name');
  throw new Error('unselected group value was accepted');
} catch (error) {
  if (!(error instanceof OrmError) || error.code !== 'COLUMN_UNSELECTED') throw error;
}
const rows = new GroupRows([row]);
if (rows.length !== 1 || JSON.stringify(rows.toArray()) !== '[{"is_close":false,"row_count":3}]') {
  throw new Error('group result collection changed the row');
}
for (const invalid of [
  [['is_close', false]], [['row_count', true]], [['row_count', -1]],
  [['row_count', 1.5]], [['row_count', 9007199254740993n]],
  [['row_count', 1], ['row_count', 2]],
  [['row_count', 1, 'extra']], [['row_count', -0]],
]) {
  try {
    new GroupRow(invalid);
    throw new Error('invalid group count was accepted');
  } catch (error) {
    if (!(error instanceof OrmError) || !['CODEC_DECODE', 'INTERNAL', 'CONFIG'].includes(error.code)) throw error;
  }
}
console.log('TypeScript GroupRows owner cases passed');
