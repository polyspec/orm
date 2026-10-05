import { cpus, loadavg } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// trackLoad는 page가 보내는 request를 기록한다. 그래서 page 열기가 실패하면 그 이유를 적을 수 있다:
// 보냈지만 끝나지도 실패하지도 않은 request(URL, 종류, 보낸 시각과 나이, 그리고 server가 받았는지와 답했는지),
// 실패한 request(HTTP status나 browser의 이유), console error와 page error, 실패한 때의 host load, 그리고 이
// process의 event loop 지연(local server는 이 process 안에서 답하므로, 지연이 길면 server가 답하지 못했다).
// server는 받은 request의 기록(requests: {url, received, answered})을 가진 local server다(lib.mjs serve).
export function trackLoad(page, server) {
  let started = Date.now();
  let pending = new Map();
  let failed = [];
  let consoleErrors = [];
  let pageErrors = [];
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  page.on('request', request => pending.set(request, Date.now()));
  page.on('requestfinished', request => pending.delete(request));
  page.on('requestfailed', request => {
    pending.delete(request);
    failed.push(`${request.failure()?.errorText ?? 'failed'} ${request.resourceType()} ${request.url()}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) failed.push(`HTTP ${response.status()} ${response.request().resourceType()} ${response.url()}`);
  });
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(error.message));

  // serverView는 server가 url의 request를 받았는지와 답했는지를 적는다.
  const serverView = (url, since) => {
    const path = new URL(url).pathname + new URL(url).search;
    const seen = (server?.requests ?? []).filter(entry => entry.url === path && entry.received >= since);
    if (seen.length === 0) return 'the server has not received it';
    return seen.map(entry => entry.answered === null
      ? `the server received it at +${entry.received - started} ms and has not answered`
      : `the server received it at +${entry.received - started} ms and answered ${entry.status} after ${entry.answered - entry.received} ms`).join('; ');
  };

  return {
    // begin은 page 하나를 열기 전에 부른다. 이전 page의 기록은 버린다.
    begin() {
      started = Date.now();
      pending = new Map();
      failed = [];
      consoleErrors = [];
      pageErrors = [];
      delay.reset();
    },
    // report는 지금까지의 기록을 줄마다 적는다.
    report() {
      const now = Date.now();
      const [one, five, fifteen] = loadavg();
      const lines = [];
      if (pending.size === 0) lines.push('no request is pending: every request the page sent has finished or failed');
      else lines.push(`${pending.size} request(s) pending (sent, neither finished nor failed):`);
      for (const [request, sent] of pending)
        lines.push(`  ${request.resourceType()} ${request.url()} sent at +${sent - started} ms, pending for ${now - sent} ms; ${serverView(request.url(), started)}`);
      lines.push(failed.length ? `failed request(s): ${failed.join('; ')}` : 'no failed request');
      lines.push(consoleErrors.length ? `console error(s): ${consoleErrors.join('; ')}` : 'no console error');
      lines.push(pageErrors.length ? `page error(s): ${pageErrors.join('; ')}` : 'no page error');
      lines.push(`event loop of this process, which runs the local server: longest delay ${(delay.max / 1e6).toFixed(0)} ms, 99th percentile ${(delay.percentile(99) / 1e6).toFixed(0)} ms since the page was opened`);
      lines.push(`host load average ${one.toFixed(2)} ${five.toFixed(2)} ${fifteen.toFixed(2)} (1, 5, 15 min) on ${cpus().length} CPUs, ${now - started} ms after the page was opened`);
      return lines.join('\n');
    },
  };
}

// loading은 page를 불러오는 동작(what, action)을 하고 load event를 기다린다. 실패하면 Playwright의 이유에
// tracker의 기록을 더해 던진다.
export async function loading(tracker, what, action) {
  tracker.begin();
  try {
    return await action();
  } catch (error) {
    throw new Error(`${error.message.split('\n')[0]} ${what}\n${tracker.report()}`);
  }
}
