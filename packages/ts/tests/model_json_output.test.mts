import { parse } from '@polyspec/ordered-json';
import { Author, StyledValue } from '../dist/index.js';
import { caseTest } from '../../../tests/testcase.mts';

// Requirements: COD-16.
caseTest('model/ordered-json-output-text', 1000, () => {
  const stored = '{"z":9007199254740993,"b":1.50,"a":1e2}';
  const row = new Author().setJsonSetting(StyledValue.value(parse(stored)));
  const want = `{"json_setting":{"kind":"value","value":${stored}}}`;
  if (row.toJSONText() !== want) throw new Error(`Model.toJSONText() = ${row.toJSONText()}; want ${want}`);
});
