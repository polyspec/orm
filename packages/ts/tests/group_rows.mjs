import { GroupRow, GroupRows, OrmError } from '../dist/index.js';
import { groupValue } from '../dist/model.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

// Requirements: INT-68, INT-69, INT-70, INT-71.
caseTest('group_rows/owner', COMPUTE, () => {
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
  const second = new GroupRow([['is_close', true], ['row_count', 2]]);
  const nullable = new GroupRow([['price', null], ['row_count', 0]]);
  if (nullable.value('price') !== null) throw new Error('selected SQL NULL changed');
  const rows = new GroupRows([row, second, nullable]);
  if (rows.length !== 3 || JSON.stringify(rows.toArray()) !== '[{"is_close":false,"row_count":3},{"is_close":true,"row_count":2},{"price":null,"row_count":0}]') {
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
});

// Requirements: INT-90.
caseTest('group_rows/negative_count_codec_decode', COMPUTE, () => {
  for (const count of [-1, '-1', -1.5]) {
    try {
      new GroupRow([['row_count', count]]);
      throw new Error(`negative group count ${count} was accepted`);
    } catch (error) {
      if (!(error instanceof OrmError) || error.code !== 'CODEC_DECODE') throw error;
    }
  }
});

// PRT-36: the model result decoder rejects an invalid stored boolean.
caseTest('group_rows/boolean_invalid_stored_value', COMPUTE, () => {
  try {
    groupValue(null, { name: 'active', column: '', type: 'bool' }, 2, null);
    throw new Error('invalid boolean group value was accepted');
  } catch (error) {
    if (!(error instanceof OrmError) || error.code !== 'CODEC_DECODE') throw error;
    if (!error.message.includes('active is not boolean')) throw error;
  }
});

// Requirements: PRT-69, INT-1. The selected grouped i64 remains exact in the public row representation.
caseTest('group_rows/exact_i64_preserved', COMPUTE, () => {
  const want = 9007199254740991;
  const value = groupValue(null, { name: 'exact_value', column: '', type: 'i64' }, want, null);
  const row = new GroupRow([['exact_value', value], ['row_count', 1]]);
  if (value !== want || row.value('exact_value') !== want || row.toArray().exact_value !== want) {
    throw new Error(`group i64 value was not preserved exactly: ${String(row.value('exact_value'))}`);
  }
});

// Requirements: PRT-69, INT-90. The grouped row exposes only an exact nonnegative row count.
caseTest('group_rows/count_exactness', COMPUTE, () => {
  for (const invalid of [true, 1.5, -1, 9007199254740992, 9007199254740992n, '9007199254740992']) {
    try {
      new GroupRow([['row_count', invalid]]);
      throw new Error(`invalid row_count ${String(invalid)} was accepted`);
    } catch (error) {
      if (!(error instanceof OrmError) || error.code !== 'CODEC_DECODE') throw error;
    }
  }
  try {
    new GroupRow([['selected', 'x']]);
    throw new Error('missing row_count was accepted');
  } catch (error) {
    if (!(error instanceof OrmError) || error.code !== 'INTERNAL') throw error;
  }
  for (const [input, want] of [[0, 0], ['0', 0], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], ['9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    const row = new GroupRow([['row_count', input]]);
    if (row.count !== want || row.toArray().row_count !== want) throw new Error(`row_count ${String(input)} was not preserved as ${want}`);
  }
});
