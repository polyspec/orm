// The links of the built site (scripts/docs/check.mts) are the targets of the links, images, stylesheets and scripts of each page. A `>`
// inside a quoted attribute does not end the tag, so the href after it is a link that the check must find and find missing here.
//
// Usage: node --test tests/docs/html.test.mts
import assert from 'node:assert/strict';
import { caseTest } from '../testcase.mts';
import { runFixture } from './fixture.mts';

const TIMEOUT = 120_000;
const mermaid = '<pre class="mermaid">graph TD</pre>'.repeat(20);

caseTest('a link whose quoted attribute holds a > is checked, so its missing target fails the check', TIMEOUT, () => {
  const result = runFixture('scripts/docs/check.mts', {
    'docs/.vitepress/dist/index.html': `<html><head><link rel="icon" href="/orm/favicon.svg"></head><body>${mermaid}</body></html>`,
    'docs/.vitepress/dist/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'docs/.vitepress/dist/page.html': '<html><body><a title="a>b" href="/orm/gone.html">gone</a></body></html>',
  }, { VITEPRESS_BASE: '/orm/' });
  assert.notEqual(result.status, 0, `the missing target was not reported:\n${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /gone\.html/);
});
