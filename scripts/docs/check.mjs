import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchBrowser } from './browser.mjs';
import { docs, dist, files, serve, siteBase } from './lib.mjs';
import { browserSteps } from './steps.mjs';
import { COMPUTE, runCase, runLong } from '../../tests/testcase.mjs';

// docs check는 build한 site를 browser로 읽는다. server 시작과 browser 실행은 장기 작업이므로 runLong으로
// 단계 로그와 함께 기한 없이 실행하고, page 하나의 검사, link 검사, 검색, theme와 mobile 탐색은 저마다
// 자기 기한을 가진 case다.
// PAGE: local server의 page 하나를 열고 본문, 그림, id와 link를 읽는 case. 한 page는 1초 안에 끝나고
// Playwright 동작 하나의 기한(15초)이 그 안에 있으므로 30초를 넘긴 case는 멈춘 것이다.
const PAGE = 30_000;
// INTERACTION: 검색 결과로 이동하거나 theme를 바꾸고 mobile menu로 이동하는 case. 동작마다 15초의
// Playwright 기한을 가지며, 몇 개의 동작이 2분 안에 끝난다.
const INTERACTION = 120_000;
let failed = 0;
const check = async (name, deadline, body) => { if (!(await runCase(name, deadline, body))) failed++; };

const base = siteBase();
let pages = [];
await check('docs-static/pages', COMPUTE, async () => {
  const prepared = JSON.parse(await readFile(path.join(docs, '.vitepress/generated/site.json'), 'utf8'));
  assert.equal(prepared.base, base, 'Rebuild with the same VITEPRESS_BASE before checking');
  pages = (await files(dist)).filter(file => file.endsWith('.html'));
  assert.ok(pages.length > 1, 'No static pages were built');
  for (const source of (await files(docs)).filter(file => file.endsWith('.md'))) {
    const relativeSource = path.relative(docs, source).split(path.sep).join('/');
    const relativePage = relativeSource.endsWith('.ko.md')
      ? `ko/${relativeSource.slice(0, -'.ko.md'.length)}.html`
      : relativeSource.replace(/\.md$/, '.html');
    const target = path.join(dist, relativePage);
    assert.ok(pages.includes(target), `Missing HTML for ${source}`);
  }
});
if (failed) process.exit(1);

let server;
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
  if (!(await runLong('docs-static/server', async ({ step }) => {
    server = await serve(dist, base);
    step(`serving ${dist} at ${server.origin}${base}`);
  }))) process.exit(1);
  if (!(await runLong('docs-static/browser', async ({ step }) => {
    browser = await launchBrowser(chromium);
    step(`chromium ${browser.version()} launched headless`);
  }))) process.exit(1);
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
  // browser에서 기다리는 모든 일은 browserSteps를 거친다. 실패하면 기다린 것, 요소의 상태, request, error,
  // event loop 지연과 host load를 적는다(scripts/docs/steps.mjs).
  const staticUi = browserSteps(page, server);
  let diagramCount = 0;
  for (const file of pages) {
    const relative = path.relative(dist, file).split(path.sep).join('/');
    await check(`docs-static/page/${relative}`, PAGE, async () => {
      const before = errors.length;
      const url = `${server.origin}${base}${relative}`;
      assert.equal((await staticUi.open(url)).status(), 200, relative);
      const body = staticUi.locator('#VPContent');
      const text = await staticUi.text(body, 'the page content');
      assert.ok(text.trim().length > 30, `Empty static body: ${relative}`);
      if (relative === 'index.html') {
        assert.ok(text.includes('$count =') && text.includes('let count ='), 'All language examples must remain visible without JavaScript');
      }
      // Browsers load all images eagerly when scripting is disabled.
      const state = await staticUi.evaluate(async () => {
        await Promise.all([...document.images].map(image => image.decode()));
        return {
          ids: [...document.querySelectorAll('[id]')].map(element => element.id),
          urls: [...document.querySelectorAll('a[href], link[href], img[src], script[src]')].map(element => element.getAttribute('href') || element.getAttribute('src')),
          diagrams: document.querySelectorAll('.orm-diagram img').length,
          broken: [...document.images].filter(image => !image.naturalWidth).map(image => image.src),
        };
      }, 'the ids, links, diagrams and images of the page');
      assert.deepEqual(state.broken, [], relative);
      anchors.set(relative, new Set(state.ids));
      diagramCount += state.diagrams;
      for (const href of state.urls) {
        const target = new URL(href, url);
        if (target.origin === server.origin) links.add(target.href);
      }
      assert.deepEqual(errors.slice(before), [], `Browser errors on ${relative}`);
    });
  }
  await check('docs-static/links', COMPUTE, async ({ step }) => {
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
    step(`${pages.length} HTML pages and ${links.size} internal targets passed without JavaScript`);
  });
  await staticContext.close();

  const context = await browser.newContext();
  context.setDefaultTimeout(15000);
  const interactive = await context.newPage();
  inspect(interactive);
  const ui = browserSteps(interactive, server);
  await check('docs-static/search', INTERACTION, async () => {
    const before = errors.length;
    await ui.open(`${server.origin}${base}`);
    await ui.click(ui.locator('.VPNavBarSearch button'), 'the search button');
    await ui.fill(ui.locator('#localsearch-input'), 'getCountBy', 'the search input');
    const result = ui.locator('.VPLocalSearchBox .result').first();
    await ui.waitFor(result, 'visible', 'the first search result');
    const beforeSearch = ui.url();
    await ui.click(result, 'the first search result');
    await ui.waitForURL(url => url.href !== beforeSearch, `other than ${beforeSearch}`);
    await ui.waitUntil(() => {
      const id = decodeURIComponent(location.hash.slice(1));
      return id && document.getElementById(id);
    }, 'the element of the URL fragment exists');
    assert.ok((await ui.text(ui.locator('#VPContent'), 'the page content')).includes('getCountBy'), 'Search did not navigate to matching content');
    assert.deepEqual(errors.slice(before), [], 'Browser errors during search');
  });
  await check('docs-static/theme-and-mobile', INTERACTION, async () => {
    const before = errors.length;
    await ui.open(`${server.origin}${base}interfaces.html`);
    await ui.click(ui.getByRole('switch').first(), 'the appearance switch');
    await ui.waitUntil(() => document.documentElement.classList.contains('dark'), 'the page is dark');
    await ui.viewport({ width: 390, height: 844 });
    await ui.reload('the page at the mobile viewport');
    await ui.click(ui.locator('.VPLocalNav .menu'), 'the mobile menu button');
    await ui.waitFor(ui.locator('.VPSidebar.open'), 'visible', 'the open sidebar');
    await ui.click(ui.locator('.VPSidebar.open a[href$="schema.html"]'), 'the sidebar link to schema.html');
    await ui.waitForURL(url => url.pathname.endsWith('/schema.html'), 'schema.html');
    await ui.waitUntil(() => document.querySelector('.vp-doc h1')?.textContent.includes('Schema'), 'the page heading includes Schema');
    const overflow = await ui.evaluate(() => document.documentElement.scrollWidth - window.innerWidth, 'the horizontal overflow');
    assert.ok(overflow <= 1, `Mobile page overflows horizontally by ${overflow}px`);
    assert.deepEqual(errors.slice(before), [], 'Browser errors during theme and mobile navigation');
  });
  await context.close();
  if (failed) {
    console.log(`docs: ${failed} case(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`docs: ${pages.length} static pages, ${links.size} internal links/assets, ${diagramCount} SVG diagrams; no-JS reading, search, theme and mobile navigation passed at ${base}`);
  }
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}
