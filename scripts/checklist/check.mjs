import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { COMPUTE, sections } from '../../tests/testcase.mjs';

const states = new Set([' ', '~', 'o', '!']);
const files = { en: 'docs/checklist.md', ko: 'docs/checklist.ko.md' };
// 상태 표시는 항목과 하위 항목의 맨 앞 상태로만 쓴다. 기계가 file의 모든 표시를 상태로 믿을 수 있도록, 범례,
// 제목, 항목의 글, 이어지는 글, inline code의 표시는 모두 오류다. 예외와 허용 목록은 없다.
const marker = /\[[ ~o!]\]/g;
const leadingState = /^ *- (?=\[)/;

function markerErrors(line, index, language, errors) {
  const leading = leadingState.exec(line)?.[0].length;
  for (const found of line.matchAll(marker)) {
    if (found.index === leading) continue;
    errors.push(`${files[language]}:${index + 1}:${found.index + 1}: state marker ${found[0]} outside the leading state of an item`);
  }
}

function parseChecklist(content, language, errors) {
  const items = [];
  const seen = new Set();
  let itemContinuation = false;
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    markerErrors(line, index, language, errors);
    if (line.startsWith('#')) {
      itemContinuation = false;
      continue;
    }
    // 들여 쓴 `- [state] ID` 줄은 하위 항목이고 최상위 항목처럼 id와 상태를 비교한다. 그 밖의 들여 쓴 줄은
    // 앞 항목의 이어지는 글이다.
    const match = /^(?:  +)?- \[([^\]]*)\] ([A-Za-z][A-Za-z0-9.-]*)\s+(.+)$/.exec(line);
    if (!match && /^  +\S/.test(line) && itemContinuation) continue;
    if (!match) {
      errors.push(`${language}:${index + 1}: unnumbered content in task tracker`);
      itemContinuation = false;
      continue;
    }
    itemContinuation = true;
    const [, state, id] = match;
    if (!states.has(state)) errors.push(`${language}:${index + 1}: invalid state [${state}] for ${id}`);
    if (seen.has(id)) errors.push(`${language}:${index + 1}: duplicate item ID ${id}`);
    seen.add(id);
    if (state === '!') {
      const cause = language === 'en' ? /\bCause:\s*\S/ : /원인:\s*\S/;
      const retry = language === 'en' ? /\bRetry:\s*\S/ : /재시도:\s*\S/;
      if (!cause.test(line)) errors.push(`${language}:${index + 1}: ${id} bypass has no cause`);
      if (!retry.test(line)) errors.push(`${language}:${index + 1}: ${id} bypass has no retry condition`);
    }
    items.push({ id, state });
  }
  if (items.length === 0) errors.push(`${language}: checklist has no items`);
  return items;
}

export function checkChecklistPair(english, korean) {
  const errors = [];
  const en = parseChecklist(english, 'en', errors);
  const ko = parseChecklist(korean, 'ko', errors);
  if (en.map(item => item.id).join('\n') !== ko.map(item => item.id).join('\n')) {
    errors.push('English and Korean checklist item IDs differ');
  } else {
    for (let i = 0; i < en.length; i++) {
      if (en[i].state !== ko[i].state) errors.push(`${en[i].id}: English and Korean state differs`);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // checklist check는 두 checklist file을 읽고 비교하는 case 하나다.
  const log = sections();
  log.begin('checklist', COMPUTE);
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const english = await readFile(resolve(root, 'docs/checklist.md'), 'utf8');
  const korean = await readFile(resolve(root, 'docs/checklist.ko.md'), 'utf8');
  const errors = checkChecklistPair(english, korean);
  for (const error of errors) console.error(`checklist: ${error}`);
  if (errors.length) process.exitCode = 1;
  else console.log('checklist: item IDs and four states agree');
  log.end(errors.length ? `${errors.length} error(s); each checklist line above names one` : undefined);
}
