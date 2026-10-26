// The GFM table reader of the docs scripts (scripts/docs/tables.mts): a cell is its source text, a table in a code block is not a table,
// a table without leading pipes is one, and tableUnder reads only the table of its heading.
//
// Usage: node --test tests/docs/tables.test.mts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { caseTest } from '../testcase.mts';
import { tableUnder, tablesIn } from '../../scripts/docs/tables.mts';

const TIMEOUT = 30_000;
const require = createRequire(import.meta.url);

function method(value: unknown, name: string): Function {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    throw new Error(`VitePress module has no ${name} method`);
  }
  const candidate: unknown = Reflect.get(value, name);
  if (typeof candidate !== 'function') throw new Error(`VitePress module has no ${name} method`);
  return candidate;
}

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


caseTest('angle-bracket examples in plan checklists render as text', TIMEOUT, async () => {
  const docs = path.resolve('docs');
  const vitepress: unknown = require('vitepress');
  const createMarkdownRenderer = method(vitepress, 'createMarkdownRenderer');
  const disposeMdItInstance = method(vitepress, 'disposeMdItInstance');
  const markdown: unknown = await Reflect.apply(createMarkdownRenderer, vitepress, [docs]);
  const render = method(markdown, 'render');
  try {
    for (const [relativePath, placeholder] of [
      ['plans/kit-standard/checklist.md', 'check'],
      ['plans/kit-standard/checklist.ko.md', 'gate'],
    ] as const) {
      const source = await readFile(path.join(docs, relativePath), 'utf8');
      const rendered: unknown = Reflect.apply(render, markdown, [source, { relativePath, path: path.join(docs, relativePath) }]);
      if (typeof rendered !== 'string') throw new Error(`${relativePath} did not render to HTML text`);
      assert.match(rendered, new RegExp(`&lt;${placeholder}&gt;`), `${relativePath} renders the ${placeholder} placeholder literally`);
      assert.match(rendered, /&lt;max@blue\.tools&gt;/, `${relativePath} renders the commit identity literally`);
      assert.match(rendered, /&lt;X&gt;/, `${relativePath} renders the generic type literally`);
      assert.match(rendered, /Refines &lt;id&gt;:/, `${relativePath} preserves the refinement prefix`);
      assert.match(rendered, /test_&lt;id&gt;/, `${relativePath} renders the test id placeholder literally`);
    }
    for (const relativePath of [
      'plans/execution/checklist.md',
      'plans/execution/checklist.ko.md',
    ]) {
      const source = await readFile(path.join(docs, relativePath), 'utf8');
      const rendered: unknown = Reflect.apply(render, markdown, [source, { relativePath, path: path.join(docs, relativePath) }]);
      if (typeof rendered !== 'string') throw new Error(`${relativePath} did not render to HTML text`);
      assert.match(rendered, /<code>&lt;limepie&gt;<\/code> and <code>&lt;polyspec&gt;<\/code>/, `${relativePath} preserves the checkout placeholders`);
    }
  } finally {
    Reflect.apply(disposeMdItInstance, vitepress, []);
  }
});
