import { readFile } from 'node:fs/promises';
import { normalizeDecimal, decimalScaled, decimalFromScaled } from '../dist/decimal.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/decimal_model.json', import.meta.url), 'utf8'));
const columns = new Map(fixture.columns.map(column => [column.id, column]));
for (const testCase of fixture.cases) caseTest(testCase.id, COMPUTE, () => {
  const column = columns.get(testCase.column);
  if (!column) throw new Error(`${testCase.id}: unknown column ${testCase.column}`);
  try {
    const actual = normalizeDecimal(testCase.input, column.precision, column.scale);
    if (testCase.expected.error) throw new Error(`${testCase.id}: expected ${testCase.expected.error}`);
    if (actual !== testCase.expected.value) throw new Error(`${testCase.id}: got ${actual}; expected ${testCase.expected.value}`);
    const stored = decimalScaled(testCase.input, column.precision, column.scale);
    const decoded = decimalFromScaled(stored, column.precision, column.scale);
    if (decoded !== testCase.expected.value) throw new Error(`${testCase.id}: SQLite round trip got ${decoded}`);
  } catch (error) {
    if (!testCase.expected.error || error.code !== testCase.expected.error) throw error;
  }
});
