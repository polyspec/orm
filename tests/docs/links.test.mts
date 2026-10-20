// The links of the documentation site (docs/.vitepress/links.ts): a Korean page reaches an English page at any depth.
//
// Usage: node --test tests/docs/links.test.mts
import assert from 'node:assert/strict';
import { caseTest } from '../testcase.mts';
import { englishHref } from '../../docs/.vitepress/links.ts';

const TIMEOUT = 15000;

caseTest('a Korean page links to an English page from the site root', TIMEOUT, () => {
  assert.equal(englishHref('/site/docs', '/site/docs/index.md', ''), '/index.html');
  assert.equal(englishHref('/site/docs', '/site/docs/plans/execution/plan.md', ''), '/plans/execution/plan.html', 'a nested English page');
  assert.equal(englishHref('/site/docs', '/site/docs/spec/dbspec.md', '#names'), '/spec/dbspec.html#names', 'with its fragment');
});
