import { readFile } from 'node:fs/promises';
import { aggregateNumber } from '../dist/model.js';
import { OrmError } from '../dist/index.js';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/aggregate_numeric.json', import.meta.url), 'utf8'));

for (const testCase of fixture.cases) {
  const input = {
    integer_text: () => BigInt(testCase.input),
    decimal_text: () => testCase.input,
    null: () => null,
  }[testCase.input_type]?.();
  if (input === undefined) throw new Error(`${testCase.id}: unknown input type ${testCase.input_type}`);
  try {
    const value = aggregateNumber(input);
    if (testCase.expected.error) throw new Error(`${testCase.id}: expected ${testCase.expected.error}, got a value`);
    const bytes = new ArrayBuffer(8);
    new DataView(bytes).setFloat64(0, value, false);
    const bits = new DataView(bytes).getBigUint64(0, false).toString(16).padStart(16, '0');
    if (bits !== testCase.expected.bits) throw new Error(`${testCase.id}: expected ${testCase.expected.bits}, got ${bits}`);
  } catch (error) {
    if (!(error instanceof OrmError) || error.code !== testCase.expected.error) throw error;
  }
  console.log(`CASE ${testCase.id} PASS`);
}
