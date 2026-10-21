import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from 'parse5';
import { docs, dist, files, siteBase } from './lib.mts';
import { COMPUTE, runCase, type CaseBody } from '../../tests/testcase.mts';

// docs check reads the built site's HTML with parse5: for each Markdown page it checks that an HTML page exists, and that all internal links, images,
// scripts and stylesheets point to files in dist, that fragments are ids of their page, and that the Mermaid fences are included as source (<pre
// class="mermaid">). The Mermaid diagrams are drawn by the reader's browser (docs/.vitepress/theme/index.ts).
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

// elementsOf returns every element of a parsed document in document order, the content of a template included.
function elementsOf(document: Node): Element[] {
  const found: Element[] = [];
  const visit = (node: Node): void => {
    if (defaultTreeAdapter.isElementNode(node)) found.push(node);
    const children = 'content' in node ? node.content.childNodes : 'childNodes' in node ? node.childNodes : [];
    children.forEach(visit);
  };
  visit(document);
  return found;
}

// attribute returns the value of an attribute of an element, decoded by the parser, or undefined when it has none.
const attribute = (element: Element, name: string): string | undefined => element.attrs.find(attr => attr.name === name)?.value;
let failed = 0;
const check = async (name: string, body: CaseBody) => { if (!(await runCase(name, COMPUTE, body))) failed++; };

const base = siteBase();
let pages: string[] = [];
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

const origin = 'http://site.invalid';
await check('docs-site/links', async ({ step }) => {
  const anchors = new Map<string, Set<string>>();
  const links = new Set<string>();
  let diagrams = 0;
  for (const file of pages) {
    const elements = elementsOf(parse(await readFile(file, 'utf8')));
    const relative = path.relative(dist, file).split(path.sep).join('/');
    anchors.set(relative, new Set(elements.flatMap(element => attribute(element, 'id') ?? [])));
    diagrams += elements.filter(element => element.tagName === 'pre' && (attribute(element, 'class') ?? '').split(/\s+/).includes('mermaid')).length;
    const url = `${origin}${base}${relative}`;
    for (const element of elements.filter(element => ['a', 'link', 'img', 'script'].includes(element.tagName))) {
      for (const name of ['href', 'src']) {
        const value = attribute(element, name);
        if (value === undefined) continue;
        const target = new URL(value, url);
        if (target.origin === origin) links.add(target.href);
      }
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
