import { GroupRow, OrmError } from '../dist/index.js';
import { addedColumnValue } from '../dist/model.js';
import { caseTest, COMPUTE } from '../../../../tests/testcase.mts';

// The forms of an added integer that only a driver cell holds, at the bound that only a TypeScript number has: every other runtime
// holds an i64 whole, so no recipe case can state this bound (FCV-2). The recipe cases added_sum_above_i32, added_sum_above_i64,
// added_sum_fractional and added_text_not_exact hold what all six share. Requirements: COD-45, INT-160.
caseTest('added_column/driver_cell_forms', COMPUTE, () => {
  const column = { index: 0, name: 'added', column: 'added', type: 'i64', styles: [], hidden: false };
  const held = [[2, 2], ['2', 2], [2n, 2], ['-2', -2], ['0', 0], [9007199254740991, Number.MAX_SAFE_INTEGER], ['9007199254740991', Number.MAX_SAFE_INTEGER], [9007199254740991n, Number.MAX_SAFE_INTEGER], ['-9007199254740991', Number.MIN_SAFE_INTEGER], [null, null]];
  for (const [input, want] of held) {
    const got = addedColumnValue(column, input, [input], 'UTC');
    if (got !== want) throw new Error(`added i64 ${String(input)} read as ${String(got)}, want ${String(want)}`);
  }
  const refused = [true, false, '', 'bad', '2.0', '2.5', '+2', '02', ' 2', 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '9007199254740992', 9007199254740992n, '9007199254740993', 9007199254740993n, 1n << 63n, {}];
  for (const input of refused) {
    let code;
    try {
      addedColumnValue(column, input, [input], 'UTC');
    } catch (error) {
      if (!(error instanceof OrmError)) throw error;
      code = error.code;
    }
    if (code !== 'CODEC_DECODE') throw new Error(`added i64 ${String(input)} gave ${String(code)}, want CODEC_DECODE`);
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
