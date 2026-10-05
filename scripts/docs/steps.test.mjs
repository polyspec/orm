// steps case는 docs check의 browser 동작이 실패할 때 그 이유를 적는지 확인한다. local server의 두 page는
// appearance switch가 없는 page와, switch를 투명하지 않은 overlay가 덮은 page다. click은 Playwright 동작의 기한
// (1초) 안에 실패하고, 실패는 기다린 것, 맞는 요소의 수, 요소마다 보이는지, 쓸 수 있는지, 그 가운데 점에서 위에 있는
// 요소, 요소의 HTML이나 page의 accessibility tree, request, error, event loop 지연과 host load를 적어야 한다.
// rawWaits case는 docs check가 helper 밖에서 Playwright로 기다리면 그 줄을 적는지 확인한다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { launchBrowser } from './browser.mjs';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import { browserSteps, rawWaits } from './steps.mjs';

const pages = {
  '/missing.html': '<!doctype html><html><body><nav><button>Menu</button></nav><main><h1>Docs</h1></main></body></html>',
  '/covered.html': '<!doctype html><html><body><button role="switch" aria-checked="false" style="position:absolute;left:10px;top:10px;width:40px;height:20px">Theme</button><div class="overlay" style="position:fixed;inset:0;background:#0003"></div></body></html>',
};

async function withPage(body) {
  const requests = [];
  const http = createServer((req, res) => {
    const entry = { url: req.url, received: Date.now(), answered: null, status: null };
    requests.push(entry);
    res.on('finish', () => { entry.answered = Date.now(); entry.status = res.statusCode; });
    const html = pages[req.url];
    res.writeHead(html ? 200 : 404, { 'Content-Type': html ? 'text/html' : 'text/plain' });
    res.end(html ?? 'Not found');
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await body(browserSteps(page, { requests }), origin);
  } finally {
    await browser.close();
    await new Promise(resolve => http.close(resolve));
  }
}

const failure = promise => promise.then(() => assert.fail('the step succeeded'), error => error.message);
const tail = /\npage URL \S+\n(?:no request is pending|\d+ request\(s\) pending)[^]*\nno failed request\nno console error\nno page error\nevent loop of this process, which runs the local server: longest delay \d+ ms, 99th percentile \d+ ms since the page was opened\nhost load average [\d.]+ [\d.]+ [\d.]+ \(1, 5, 15 min\) on \d+ CPUs, \d+ ms after the page was opened$/;

caseTest('a click on a missing switch names the missing element and the accessibility tree', COMPUTE, () => withPage(async (ui, origin) => {
  await ui.open(`${origin}/missing.html`);
  const message = await failure(ui.click(ui.getByRole('switch').first(), 'the appearance switch'));
  const lines = message.split('\n');
  assert.equal(lines[0], "locator.click: Timeout 1000ms exceeded. clicking the appearance switch (getByRole('switch').first())");
  assert.equal(lines[1], "no element matches getByRole('switch').first(); accessibility tree of the page:");
  assert.equal(lines.slice(2, 5).join('\n'), '  - navigation:\n    - button "Menu"\n  - main:', message);
  assert.match(message, tail);
}));

caseTest('a click on a covered switch names the element on top of it', COMPUTE, () => withPage(async (ui, origin) => {
  await ui.open(`${origin}/covered.html`);
  const message = await failure(ui.click(ui.getByRole('switch').first(), 'the appearance switch'));
  const lines = message.split('\n');
  assert.equal(lines[0], "locator.click: Timeout 1000ms exceeded. clicking the appearance switch (getByRole('switch').first())");
  assert.equal(lines[1], "1 element(s) match getByRole('switch').first():");
  assert.equal(lines[2], '  #1 visible (display block, visibility visible), enabled, box 10,10 40x20, is covered at its center 30,20 by <div class="overlay" style="position:fixed;inset:0;background:#0003"></div>');
  assert.equal(lines[3], '     element: <button role="switch" aria-checked="false" style="position:absolute;left:10px;top:10px;width:40px;height:20px">Theme</button>');
  assert.match(lines[4], /^     parent: <body><button role="switch"/);
  assert.match(message, tail);
}));

caseTest('the docs check waits in the browser only through browserSteps', COMPUTE, async () => {
  const source = await readFile(new URL('./check.mjs', import.meta.url), 'utf8');
  assert.deepEqual(rawWaits(source, ['ui', 'staticUi']), []);
  const raw = [
    'await page.getByRole(\'switch\').first().click();',
    'await interactive.waitForFunction(() => true);',
    'const text = await body.innerText();',
    'await ui.click(ui.locator(\'a\'), \'a link\');',
    'await ui.evaluate(() => [...document.links].map(link => link.getAttribute(\'href\')), \'links\');',
    'page.on(\'console\', message => message.type());',
  ].join('\n');
  assert.deepEqual(rawWaits(raw, ['ui']), [
    'line 1: ).click( waits outside browserSteps',
    'line 2: interactive.waitForFunction( waits outside browserSteps',
    'line 3: body.innerText( waits outside browserSteps',
  ]);
});
