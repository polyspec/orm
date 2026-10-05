// launchBrowser가 Chromium에게 자기 임시 directory를 주고 browser를 닫을 때 그것을 지우는지 가짜 chromium으로 본다.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import { launchBrowser } from './browser.mjs';

caseTest('the documentation browser gets a temporary directory of its own, removed when it closes', COMPUTE, async () => {
  let given;
  const chromium = {
    launch: async options => {
      given = options;
      writeFileSync(join(options.env.TMPDIR, '.org.chromium.Chromium.left'), '');
      return { close: async () => {} };
    },
  };
  const browser = await launchBrowser(chromium);
  assert.equal(given.headless, true);
  assert.ok(existsSync(join(given.env.TMPDIR, '.org.chromium.Chromium.left')));
  await browser.close();
  assert.equal(existsSync(given.env.TMPDIR), false, 'what Chromium left in its temporary directory is removed');
  // 문서 검사의 모든 browser는 launchBrowser로 시작한다.
  const docs = resolve(fileURLToPath(new URL('.', import.meta.url)));
  const direct = readdirSync(docs).filter(name => name.endsWith('.mjs') && name !== 'browser.mjs')
    .filter(name => /chromium\.launch\(/.test(readFileSync(join(docs, name), 'utf8')));
  assert.deepEqual(direct, []);
});
