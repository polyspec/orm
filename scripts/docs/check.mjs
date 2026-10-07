import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { docs, dist, files, siteBase } from './lib.mjs';
import { COMPUTE, runCase } from '../../tests/testcase.mjs';

// docs check는 build한 site의 HTML을 Node로 읽는다: Markdown page마다 HTML page가 있는지, 모든 내부 link, image,
// script와 stylesheet가 dist의 file을 가리키는지, fragment가 그 page의 id인지, Mermaid fence가 소스(<pre
// class="mermaid">)로 들어 있는지 본다. Mermaid 그림은 읽는 이의 browser가 그린다(docs/.vitepress/theme/index.ts).
let failed = 0;
const check = async (name, body) => { if (!(await runCase(name, COMPUTE, body))) failed++; };

const base = siteBase();
let pages = [];
await check('docs-site/pages', async () => {
  const index = await readFile(path.join(dist, 'index.html'), 'utf8');
  assert.ok(index.includes(`href="${base}favicon.svg"`), 'Rebuild with the same VITEPRESS_BASE before checking');
  pages = (await files(dist)).filter(file => file.endsWith('.html'));
  assert.ok(pages.length > 1, 'No static pages were built');
  for (const source of (await files(docs)).filter(file => file.endsWith('.md'))) {
    const relativeSource = path.relative(docs, source).split(path.sep).join('/');
    const relativePage = relativeSource.endsWith('.ko.md')
      ? `ko/${relativeSource.slice(0, -'.ko.md'.length)}.html`
      : relativeSource.replace(/\.md$/, '.html');
    assert.ok(pages.includes(path.join(dist, relativePage)), `Missing HTML for ${source}`);
  }
});
if (failed) process.exit(1);

const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const origin = 'http://site.invalid';
await check('docs-site/links', async ({ step }) => {
  const anchors = new Map();
  const links = new Set();
  let diagrams = 0;
  for (const file of pages) {
    const html = await readFile(file, 'utf8');
    const relative = path.relative(dist, file).split(path.sep).join('/');
    anchors.set(relative, new Set([...html.matchAll(/\sid="([^"]*)"/g)].map(match => decode(match[1]))));
    diagrams += html.split('<pre class="mermaid"').length - 1;
    const url = `${origin}${base}${relative}`;
    for (const match of html.matchAll(/<(?:a|link|img|script)\s[^>]*?\b(?:href|src)="([^"]*)"/g)) {
      const target = new URL(decode(match[1]), url);
      if (target.origin === origin) links.add(target.href);
    }
  }
  assert.ok(diagrams >= 20, 'Expected the Mermaid sources of the interface pages in static HTML');
  for (const link of links) {
    const url = new URL(link);
    assert.ok(url.pathname.startsWith(base), `Link escapes the base: ${link}`);
    let relative = decodeURIComponent(url.pathname.slice(base.length));
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const target = path.resolve(dist, relative);
    assert.ok(target.startsWith(dist + path.sep), `Link escapes dist: ${link}`);
    assert.ok((await stat(target)).isFile(), `Missing target: ${link}`);
    if (url.hash && relative.endsWith('.html')) {
      assert.ok(anchors.get(relative)?.has(decodeURIComponent(url.hash.slice(1))), `Missing anchor: ${link}`);
    }
  }
  step(`${pages.length} HTML pages, ${links.size} internal targets and ${diagrams} Mermaid sources at ${base}`);
});
if (failed) process.exit(1);
