import { readFile } from 'node:fs/promises';
import { normalizeDecimal, decimalScaled, decimalFromScaled } from '../dist/decimal.js';
import { parseDbspec, renderDbspec } from '../dist/dbspec/index.js';
import { cases, COMPUTE } from '../../../tests/testcase.mjs';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/decimal_model.json', import.meta.url), 'utf8'));
const columns = new Map(fixture.columns.map(column => [column.id, column]));
const run = cases();
for (const testCase of fixture.cases) await run.run(`decimal_model/${testCase.id}`, COMPUTE, () => {
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
// SQLite decimal column은 dbspec renderer가 scaled integer storage로 쓴다.
await run.run('decimal_model/sqlite_decimal_ddl', COMPUTE, () => {
  const parsed = parseDbspec('dbspec 1 decimal\n\ntable t {\n  seq i64\n  amount decimal(13,4)\n  primary key (seq)\n}\n', {});
  if (parsed.diagnostics.length !== 0) throw new Error(`decimal document: ${JSON.stringify(parsed.diagnostics)}`);
  const rendered = renderDbspec([parsed.document], 'sqlite');
  if (rendered.diagnostics.length !== 0 || !rendered.statements[0].includes('"amount" DECIMALINT(13,4) NOT NULL')) {
    throw new Error(`SQLite decimal DDL ${JSON.stringify(rendered)} must use exact scaled storage`);
  }
});
run.finish();
