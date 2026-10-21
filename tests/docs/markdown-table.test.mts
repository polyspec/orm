// The Markdown IR executor table (scripts/docs/markdown-table.mts) reads the flowmark table of spec 60 with the GFM grammar: an escaped pipe
// outside a code span stays in its cell. The pipe split of the earlier code cut such a cell in two, so its row came out wrong.
//
// Usage: node --test tests/docs/markdown-table.test.mts
import assert from 'node:assert/strict';
import { caseTest } from '../testcase.mts';
import { runFixture } from './fixture.mts';

const TIMEOUT = 120_000;
const version = 'v0.0.0-20261013184618-8b5d16a81141';
const spec = '# Dialect\n\n## Surfaces\n\n| Surface | Ruling |\n|---|---|\n| `a` \\| `b` | Supported; Rule: x |\n';
const table = (header: string) => `# Dialects\n\n## Markdown IR executor\n\n${header}\n|---|---|---|\n| \`a\` \\| \`b\` | Supported | Rule: x |\n`;

caseTest('an escaped pipe in a spec cell stays in its cell, so the row of the table is its own cell', TIMEOUT, () => {
  const result = runFixture('scripts/docs/markdown-table.mts', {
    'tests/markdown/flowmark.version': `${version}\n`,
    [`mod/github.com/polyspec/flowmark@${version}/docs/spec/60-dialect.md`]: spec,
    [`mod/github.com/polyspec/flowmark@${version}/docs/spec/60-dialect.ko.md`]: spec,
    'docs/spec/dialects.md': table('| Surface | Result | Rule |'),
    'docs/spec/dialects.ko.md': table('| 표면 | 결과 | 규칙 |'),
  }, { GOMODCACHE: '{dir}/mod' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
