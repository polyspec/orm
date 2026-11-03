import { GroupRow, GroupRows, OrmError } from '../dist/index.js';
import { groupValue } from '../dist/model.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

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

// The forms of a count that only a driver cell holds: a text, a bigint, a negative zero, a repeated column and an entry of another
// length. The answer of a listener holds none of them, since its count is a JSON number and its row a JSON object (PRT-69), so the
// collection recipe cannot write them (FCV-2). Requirements: INT-68, INT-90.
caseTest('group_rows/driver_cell_forms', COMPUTE, () => {
  const refused = (entries, code) => {
    try {
      new GroupRow(entries);
    } catch (error) {
      if (error instanceof OrmError && error.code === code) return;
      throw error;
    }
    throw new Error(`group entries ${JSON.stringify(entries, (_key, value) => typeof value === 'bigint' ? `${value}n` : value)} were accepted`);
  };
  for (const count of ['three', '-1', '00', '+1', '', '9007199254740992', 9007199254740993n, -1n, -0]) refused([['row_count', count]], 'CODEC_DECODE');
  for (const [input, want] of [['0', 0], ['9007199254740991', Number.MAX_SAFE_INTEGER], [9007199254740991n, Number.MAX_SAFE_INTEGER]]) {
    const row = new GroupRow([['row_count', input]]);
    if (row.count !== want || row.toArray().row_count !== want) throw new Error(`row_count ${String(input)} was not preserved as ${want}`);
  }
  refused([['row_count', 1], ['row_count', 2]], 'CONFIG');
  refused([['row_count', 1, 'extra']], 'CONFIG');
});
