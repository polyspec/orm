import { readFile } from 'node:fs/promises';
import { normalizeDecimal, decimalScaled, decimalFromScaled } from '../dist/decimal.js';
import { parseDbspec, renderDbspec } from '../dist/dbspec/index.js';

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
// SQLite decimal column은 dbspec renderer가 scaled integer storage로 쓴다.
const parsed = parseDbspec('dbspec 1 decimal\n\ntable t {\n  seq i64\n  amount decimal(13,4)\n  primary key (seq)\n}\n', {});
if (parsed.diagnostics.length !== 0) throw new Error(`decimal document: ${JSON.stringify(parsed.diagnostics)}`);
const rendered = renderDbspec([parsed.document], 'sqlite');
if (rendered.diagnostics.length !== 0 || !rendered.statements[0].includes('"amount" DECIMALINT(13,4) NOT NULL')) {
  throw new Error(`SQLite decimal DDL ${JSON.stringify(rendered)} must use exact scaled storage`);
}
console.log('CASE sqlite_decimal_ddl PASS');
