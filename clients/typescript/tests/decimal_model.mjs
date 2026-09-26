import { readFile } from 'node:fs/promises';
import { normalizeDecimal, decimalScaled, decimalFromScaled } from '../dist/decimal.js';
import { ddlType } from '../dist/engine/ddl.js';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/decimal_model.json', import.meta.url), 'utf8'));
const columns = new Map(fixture.columns.map(column => [column.id, column]));
for (const testCase of fixture.cases) {
  const column = columns.get(testCase.column);
  if (!column) throw new Error(`${testCase.id}: unknown column ${testCase.column}`);
  try {
    const actual = normalizeDecimal(testCase.input, column.precision, column.scale);
    if (testCase.error) throw new Error(`${testCase.id}: expected ${testCase.error}`);
    if (actual !== testCase.expected) throw new Error(`${testCase.id}: got ${actual}; expected ${testCase.expected}`);
    const stored = decimalScaled(testCase.input, column.precision, column.scale);
    const decoded = decimalFromScaled(stored, column.precision, column.scale);
    if (decoded !== testCase.expected) throw new Error(`${testCase.id}: SQLite round trip got ${decoded}`);
  } catch (error) {
    if (!testCase.error || error.code !== testCase.error) throw error;
  }
  console.log(`CASE ${testCase.id} PASS`);
}
const sqliteType = ddlType({ name: 'amount', type: 'decimal', precision: 13, scale: 4 }, 'sqlite');
if (sqliteType !== 'DECIMALINT(13,4)') throw new Error(`SQLite decimal DDL ${sqliteType} must use exact scaled storage`);
console.log('CASE sqlite_decimal_ddl PASS');
