// launchBrowser는 문서 검사의 headless Chromium을 자기 임시 directory(TMPDIR)와 함께 시작한다. Chromium은 TMPDIR에
// `.org.chromium.Chromium.*` directory를 만들고 닫힌 뒤에도 남기기도 하므로, 그 directory를 이 실행의 것으로 주고
// browser를 닫을 때 지운다. 그래서 문서 검사는 check runner 단계의 임시 directory에 아무것도 남기지 않는다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchBrowser(chromium, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'orm-chromium-'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...options, env: { ...process.env, ...options.env, TMPDIR: temporary } });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    try {
      await close(...args);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
  return browser;
}
