import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { COMPUTE, sections } from '../../tests/testcase.mjs';

const states = new Set([' ', '~', 'o', '!']);

function parseChecklist(content, language, errors) {
  const items = [];
  const seen = new Set();
  let itemContinuation = false;
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      itemContinuation = false;
      continue;
    }
    if (index === 2 && line.startsWith(language === 'en' ? 'Legend:' : '표기:')) continue;
    if (/^  +\S/.test(line) && itemContinuation) continue;
    const match = /^- \[([^\]]*)\] ([A-Za-z][A-Za-z0-9.]*)\s+(.+)$/.exec(line);
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
