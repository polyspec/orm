import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { docs, dist, files, serve, siteBase } from './lib.mjs';

const base = siteBase();
const prepared = JSON.parse(await readFile(path.join(docs, '.vitepress/generated/site.json'), 'utf8'));
assert.equal(prepared.base, base, 'Rebuild with the same VITEPRESS_BASE before checking');
const pages = (await files(dist)).filter(file => file.endsWith('.html'));
assert.ok(pages.length > 1, 'No static pages were built');
for (const source of (await files(docs)).filter(file => file.endsWith('.md'))) {
  const relativeSource = path.relative(docs, source).split(path.sep).join('/');
  const relativePage = relativeSource.endsWith('.ko.md')
    ? `ko/${relativeSource.slice(0, -'.ko.md'.length)}.html`
    : relativeSource.replace(/\.md$/, '.html');
  const target = path.join(dist, relativePage);
  assert.ok(pages.includes(target), `Missing HTML for ${source}`);
}

const server = await serve(dist, base);
let browser;
const errors = [];
const links = new Set();
const anchors = new Map();
function inspect(page, { scripting = true } = {}) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => {
    const reason = request.failure()?.errorText;
    // Playwright disables scripts through CSP; those intentional denials are not site failures.
    if (!scripting && reason === 'csp' && request.resourceType() === 'script') return;
    errors.push(`${reason} ${request.url()}`);
  });
}
try {
  browser = await chromium.launch({ headless: true });
  const staticContext = await browser.newContext({ javaScriptEnabled: false });
  staticContext.setDefaultTimeout(15000);
  await staticContext.route('**/*', route => {
    if (new URL(route.request().url()).origin !== server.origin) {
      errors.push(`External resource required: ${route.request().url()}`);
      return route.abort();
    }
    return route.continue();
  });
  const page = await staticContext.newPage();
  inspect(page, { scripting: false });
  let diagramCount = 0;
  for (const file of pages) {
    const relative = path.relative(dist, file).split(path.sep).join('/');
    const url = `${server.origin}${base}${relative}`;
    assert.equal((await page.goto(url)).status(), 200, relative);
    const body = page.locator('#VPContent');
    assert.ok((await body.innerText()).trim().length > 30, `Empty static body: ${relative}`);
    if (relative === 'index.html') {
      const text = await body.innerText();
      assert.ok(text.includes('$count =') && text.includes('let count ='), 'All language examples must remain visible without JavaScript');
    }
    // Browsers load all images eagerly when scripting is disabled.
    const state = await page.evaluate(async () => {
      await Promise.all([...document.images].map(image => image.decode()));
      return {
        ids: [...document.querySelectorAll('[id]')].map(element => element.id),
        urls: [...document.querySelectorAll('a[href], link[href], img[src], script[src]')].map(element => element.getAttribute('href') || element.getAttribute('src')),
        diagrams: document.querySelectorAll('.orm-diagram img').length,
        broken: [...document.images].filter(image => !image.naturalWidth).map(image => image.src),
      };
    });
    assert.deepEqual(state.broken, [], relative);
    anchors.set(relative, new Set(state.ids));
    diagramCount += state.diagrams;
    for (const href of state.urls) {
      const target = new URL(href, url);
      if (target.origin === server.origin) links.add(target.href);
    }
  }
  assert.ok(diagramCount >= 12, 'Expected interface and schema diagrams in static HTML');
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
  await staticContext.close();
  console.log(`docs: ${pages.length} HTML pages and ${links.size} internal targets passed without JavaScript`);

  const context = await browser.newContext();
  context.setDefaultTimeout(15000);
  const interactive = await context.newPage();
  inspect(interactive);
  await interactive.goto(`${server.origin}${base}`);
  await interactive.locator('.VPNavBarSearch button').click();
  await interactive.locator('#localsearch-input').fill('getCountBy');
  const result = interactive.locator('.VPLocalSearchBox .result').first();
  await result.waitFor({ state: 'visible' });
  const beforeSearch = interactive.url();
  await result.click();
  await interactive.waitForURL(url => url.href !== beforeSearch);
  await interactive.waitForFunction(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    return id && document.getElementById(id);
  });
  assert.ok((await interactive.locator('#VPContent').innerText()).includes('getCountBy'), 'Search did not navigate to matching content');
  await interactive.goto(`${server.origin}${base}interfaces.html`);
  await interactive.getByRole('switch', { name: '어두운 테마' }).click();
  await interactive.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await interactive.setViewportSize({ width: 390, height: 844 });
  await interactive.reload();
  const menu = interactive.locator('.VPLocalNav .menu');
  await menu.click();
  await interactive.locator('.VPSidebar.open').waitFor();
  await interactive.locator('.VPSidebar.open a[href$="schema.html"]').click();
  await interactive.waitForURL(url => url.pathname.endsWith('/schema.html'));
  await interactive.waitForFunction(() => document.querySelector('.vp-doc h1')?.textContent.includes('schema.md'));
  const overflow = await interactive.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `Mobile page overflows horizontally by ${overflow}px`);
  await context.close();
  assert.deepEqual(errors, [], 'Browser errors');
  console.log(`docs: ${pages.length} static pages, ${links.size} internal links/assets, ${diagramCount} SVG diagrams; no-JS reading, search, theme and mobile navigation passed at ${base}`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
