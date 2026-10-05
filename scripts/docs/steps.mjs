import { loading, trackLoad } from './load.mjs';

// browserSteps는 docs check가 browser에서 기다리는 모든 일(page 열기와 다시 열기, click, 입력, 요소 기다리기,
// URL과 조건 기다리기, 글 읽기, page 안의 계산)을 하는 하나의 helper다. check는 Playwright의 page나 locator에서
// 직접 기다리지 않는다(rawWaits가 그것을 찾는다). 각 동작은 Playwright의 동작 기한을 그대로 쓰고, 실패하면
// Playwright의 이유에 다음을 더해 던진다:
// - 무엇을 기다렸는지;
// - locator가 있는 동작이면 맞는 요소의 수와, 요소마다 보이는지, 쓸 수 있는지, 그 가운데 점에서 가장 위에 있는
//   요소(다른 요소가 덮고 있으면 그 요소)와 요소의 HTML 조각, 맞는 요소가 없으면 page의 accessibility tree;
// - 남은 request와 실패한 request, console error와 page error, event loop 지연과 host load(load.mjs).
export function browserSteps(page, server) {
  const load = trackLoad(page, server);

  const fail = async (what, error, locator) => {
    const facts = [];
    if (locator) facts.push(await describeLocator(page, locator));
    facts.push(`page URL ${page.url()}`);
    facts.push(load.report());
    return new Error(`${error.message.split('\n')[0]} ${what}\n${facts.join('\n')}`);
  };

  const step = async (what, action, locator) => {
    try {
      return await action();
    } catch (error) {
      throw await fail(what, error, locator);
    }
  };

  // navigate는 page를 새로 불러오는 동작이다. 그 전의 request 기록은 버리고, 실패하면 load.mjs의 기록을 적는다.
  const navigate = (what, action) => loading(load, what, action);

  return {
    open: url => navigate(`opening ${url}`, () => page.goto(url)),
    reload: what => navigate(`reloading ${what}`, () => page.reload()),
    click: (locator, what) => step(`clicking ${what} (${locator})`, () => locator.click(), locator),
    fill: (locator, value, what) => step(`filling ${what} (${locator}) with ${JSON.stringify(value)}`, () => locator.fill(value), locator),
    waitFor: (locator, state, what) => step(`waiting for ${what} (${locator}) to be ${state}`, () => locator.waitFor({ state }), locator),
    text: (locator, what) => step(`reading the text of ${what} (${locator})`, () => locator.innerText(), locator),
    waitForURL: (predicate, what) => step(`waiting for the URL to become ${what}`, () => page.waitForURL(predicate)),
    waitUntil: (fn, what) => step(`waiting until ${what}`, () => page.waitForFunction(fn)),
    evaluate: (fn, what) => step(`evaluating ${what}`, () => page.evaluate(fn)),
    viewport: size => step(`setting the viewport to ${size.width}x${size.height}`, () => page.setViewportSize(size)),
    url: () => page.url(),
    locator: selector => page.locator(selector),
    getByRole: (role, options) => page.getByRole(role, options),
  };
}

// describeLocator는 locator에 맞는 요소들을 적는다. 기다리지 않고 지금의 DOM만 읽는다.
async function describeLocator(page, locator) {
  const lines = [];
  let count;
  try {
    count = await locator.count();
  } catch (error) {
    return `the elements of ${locator} could not be counted: ${error.message.split('\n')[0]}`;
  }
  if (count === 0) {
    lines.push(`no element matches ${locator}; accessibility tree of the page:`);
    try {
      const tree = await page.locator('body').ariaSnapshot({ timeout: 1000 });
      lines.push(indent(clip(tree, 3000)));
    } catch (error) {
      lines.push(`  the accessibility tree could not be read: ${error.message.split('\n')[0]}`);
    }
    return lines.join('\n');
  }
  lines.push(`${count} element(s) match ${locator}:`);
  const all = await locator.all();
  for (const [index, element] of all.slice(0, 5).entries()) {
    try {
      const facts = await element.evaluate(node => {
        const snippet = target => target ? target.outerHTML.replace(/\s+/g, ' ').slice(0, 300) : 'nothing';
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const top = box.width && box.height ? document.elementFromPoint(x, y) : null;
        return {
          box: `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`,
          display: style.display,
          visibility: style.visibility,
          disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true',
          point: `${Math.round(x)},${Math.round(y)}`,
          top: top === null ? null : (node === top || node.contains(top) ? 'itself' : snippet(top)),
          html: snippet(node),
          parent: snippet(node.parentElement).slice(0, 600),
        };
      }, undefined, { timeout: 1000 });
      const visible = await element.isVisible();
      const enabled = await element.isEnabled({ timeout: 1000 }).catch(() => !facts.disabled);
      const cover = facts.top === null ? 'has no area to click'
        : facts.top === 'itself' ? `is on top at its center ${facts.point}`
          : facts.top === 'nothing' ? `has nothing at its center ${facts.point} (outside the viewport)`
            : `is covered at its center ${facts.point} by ${facts.top}`;
      lines.push(`  #${index + 1} ${visible ? 'visible' : 'not visible'} (display ${facts.display}, visibility ${facts.visibility}), ${enabled ? 'enabled' : 'disabled'}, box ${facts.box}, ${cover}`);
      lines.push(`     element: ${facts.html}`);
      lines.push(`     parent: ${facts.parent}`);
    } catch (error) {
      lines.push(`  #${index + 1} could not be read: ${error.message.split('\n')[0]}`);
    }
  }
  if (count > 5) lines.push(`  and ${count - 5} more`);
  return lines.join('\n');
}

const clip = (text, length) => text.length > length ? `${text.slice(0, length)}\n... (${text.length - length} more characters)` : text;
const indent = text => text.split('\n').map(line => `  ${line}`).join('\n');

// waits는 Playwright의 page와 locator에서 기다리거나 page를 바꾸는 method다.
const waits = 'goto|reload|goBack|goForward|click|dblclick|fill|press|pressSequentially|hover|tap|check|uncheck|selectOption|setInputFiles|focus|blur|dispatchEvent|waitFor|waitForURL|waitForFunction|waitForLoadState|waitForSelector|waitForEvent|waitForTimeout|waitForResponse|waitForRequest|innerText|innerHTML|textContent|inputValue|getAttribute|isVisible|isHidden|isEnabled|isDisabled|isChecked|isEditable|evaluate|evaluateAll|evaluateHandle|ariaSnapshot|screenshot|setViewportSize';
// type은 입력 동작(locator.type(text))일 때만 기다림이다. 인자 없는 type()(console message의 종류)은 아니다.
const call = new RegExp(`([\\w$\\])]+)\\s*\\.\\s*(${waits}|type(?=\\s*\\(\\s*[^\\s)]))\\s*\\(`, 'g');

// browserCode는 helper의 evaluate와 waitUntil에 준 함수(browser 안에서 실행되는 code)를 같은 길이의 빈칸으로
// 바꾼다. 그 안의 DOM 호출(element.getAttribute 같은)은 Playwright의 기다림이 아니다.
function withoutBrowserCode(source, helpers) {
  let out = source;
  const start = new RegExp(`\\b(?:${helpers.join('|')})\\s*\\.\\s*(?:evaluate|waitUntil)\\s*\\(`, 'g');
  for (const match of source.matchAll(start)) {
    let depth = 1;
    let index = match.index + match[0].length;
    for (; index < source.length && depth > 0; index++) {
      if (source[index] === '(') depth++;
      else if (source[index] === ')') depth--;
    }
    const from = match.index + match[0].length;
    out = out.slice(0, from) + out.slice(from, index - 1).replace(/[^\n]/g, ' ') + out.slice(index - 1);
  }
  return out;
}

// rawWaits는 source(docs check의 JavaScript)가 helper(helpers에 이름이 있는 browserSteps의 값)를 거치지 않고
// Playwright에서 직접 기다리는 곳마다 줄과 호출을 돌려준다. 예외는 없다.
export function rawWaits(source, helpers) {
  const found = [];
  for (const [index, line] of withoutBrowserCode(source, helpers).split('\n').entries()) {
    if (/^\s*\/\//.test(line)) continue;
    for (const match of line.matchAll(call)) {
      if (helpers.includes(match[1])) continue;
      found.push(`line ${index + 1}: ${match[1]}.${match[2]}( waits outside browserSteps`);
    }
  }
  return found;
}
