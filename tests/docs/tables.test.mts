// The GFM table reader of the docs scripts (scripts/docs/tables.mts): a cell is its source text, a table in a code block is not a table,
// a table without leading pipes is one, and tableUnder reads only the table of its heading.
//
// Usage: node --test tests/docs/tables.test.mts
import assert from 'node:assert/strict';
import { caseTest } from '../testcase.mts';
import { tableUnder, tablesIn } from '../../scripts/docs/tables.mts';

const TIMEOUT = 30_000;

caseTest('an escaped pipe and a code span keep their source text in the cell', TIMEOUT, () => {
  const [table] = tablesIn('| a | b |\n|---|---|\n| `x` \\| `y` | z \\| w |\n');
  assert.deepEqual(table?.rows, [['`x` \\| `y`', 'z \\| w']]);
});

caseTest('a table in a code block is not a table', TIMEOUT, () => {
  assert.deepEqual(tablesIn('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n'), []);
});

caseTest('a table without leading pipes is read with its header and rows', TIMEOUT, () => {
  const [table] = tablesIn('Go | PHP\n--|--\n1 | 2\n');
  assert.deepEqual(table?.header, ['Go', 'PHP']);
  assert.deepEqual(table?.rows, [['1', '2']]);
});

caseTest('tableUnder reads the table of its heading and not one below a later heading', TIMEOUT, () => {
  const under = tableUnder('## Target\n\ntext\n\n| a |\n|---|\n| 1 |\n\n## Other\n\n| b |\n|---|\n| 2 |\n', heading => heading.depth === 2 && heading.children[0]?.type === 'text' && heading.children[0].value === 'Target');
  assert.deepEqual(under?.header, ['a']);
  const after = tableUnder('## Target\n\ntext\n\n## Other\n\n| b |\n|---|\n| 2 |\n', heading => heading.depth === 2 && heading.children[0]?.type === 'text' && heading.children[0].value === 'Target');
  assert.equal(after, undefined);
});
