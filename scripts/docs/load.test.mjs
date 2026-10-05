// load case는 page 열기가 load event를 기다리다 실패할 때 그 이유를 적는지 확인한다. local server는 page,
// 답하지 않는 stylesheet(/slow.css), 없는 그림(/missing.png)을 가지고, page의 script는 console error와 page
// error를 낸다. case는 page가 commit된 뒤 그 실패와 error가 모두 일어나기를 event로 기다리고, 그 다음에야
// load event를 1초 기한으로 기다리므로 기록은 언제나 같다. 실패는 기한 초과만이 아니라 남은 request의
// URL, 보낸 시각과 나이, server가 그것을 받고 답하지 않았다는 것, 실패한 request의 status, console error, page
// error, 이 process의 event loop 지연과 host load를 적어야 한다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { launchBrowser } from './browser.mjs';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import { loading, trackLoad } from './load.mjs';

const PAGE = `<!doctype html><html><head><script>console.error('boom in console'); setTimeout(() => { throw new Error('boom in page'); });</script>
<link rel="stylesheet" href="/slow.css"></head><body><img src="/missing.png"></body></html>`;

caseTest('a page that does not load names its pending and failed requests and its errors', COMPUTE, async () => {
  const requests = [];
  const held = [];
  const http = createServer((req, res) => {
    const entry = { url: req.url, received: Date.now(), answered: null, status: null };
    requests.push(entry);
    res.on('finish', () => { entry.answered = Date.now(); entry.status = res.statusCode; });
    if (req.url === '/slow.css') { held.push(res); return; }
    if (req.url === '/page.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage();
    const tracker = trackLoad(page, { requests });
    const url = `${origin}/page.html`;
    const happened = Promise.all([
      page.waitForEvent('response', response => response.url().endsWith('/missing.png'), { timeout: 0 }),
      page.waitForEvent('console', message => message.text() === 'boom in console', { timeout: 0 }),
      page.waitForEvent('console', message => message.text().startsWith('Failed to load resource'), { timeout: 0 }),
      page.waitForEvent('pageerror', { timeout: 0 }),
    ]);
    const error = await loading(tracker, `opening ${url}`, async () => {
      await page.goto(url, { waitUntil: 'commit' });
      await happened;
      await page.waitForLoadState('load', { timeout: 1000 });
    }).then(() => null, failure => failure);
    assert.ok(error, 'the page loaded although its stylesheet was never answered');
    const lines = error.message.split('\n');
    assert.match(lines[0], new RegExp(`^page\\.waitForLoadState: Timeout 1000ms exceeded\\. opening ${origin}/page\\.html$`));
    assert.equal(lines[1], '1 request(s) pending (sent, neither finished nor failed):');
    assert.match(lines[2], new RegExp(`^  stylesheet ${origin}/slow\\.css sent at \\+\\d+ ms, pending for \\d+ ms; the server received it at \\+\\d+ ms and has not answered$`));
    assert.equal(lines[3], `failed request(s): HTTP 404 image ${origin}/missing.png`);
    assert.equal(lines[4], 'console error(s): boom in console; Failed to load resource: the server responded with a status of 404 (Not Found)');
    assert.equal(lines[5], 'page error(s): boom in page');
    assert.match(lines[6], /^event loop of this process, which runs the local server: longest delay \d+ ms, 99th percentile \d+ ms since the page was opened$/);
    assert.match(lines[7], /^host load average \d+\.\d\d \d+\.\d\d \d+\.\d\d \(1, 5, 15 min\) on \d+ CPUs, \d+ ms after the page was opened$/);
    assert.equal(lines.length, 8, error.message);
  } finally {
    for (const res of held) res.end();
    await browser.close();
    await new Promise(resolve => http.close(resolve));
  }
});
