import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { docs, root, files } from './lib.mjs';
import { COMPUTE, sections } from '../../tests/testcase.mjs';

// rules check는 문서 file을 읽어 쌍과 문체를 검사하는 case 하나다.
const log = sections();
log.begin('docs-rules', COMPUTE);

const rules = JSON.parse(await readFile(path.join(root, 'contracts/rules.json'), 'utf8'));
if (rules.version !== 1 || !Array.isArray(rules.rules)) throw new Error('contracts/rules.json: invalid rule registry');

const failures = [];
const fail = (id, message) => failures.push(`${id}: ${message}`);
const relative = file => path.relative(root, file).split(path.sep).join('/');

const allDocs = (await files(docs)).filter(file => file.endsWith('.md') && !file.includes(`${path.sep}.vitepress${path.sep}`));
// docs/ 밖의 추적되는 한국어 문서(AGENTS.ko.md, README.ko.md, CHANGELOG.ko.md 등)도 영문 원본과
// 같은 구조 검사를 받는다.
const pairedOutside = execFileSync('git', ['ls-files', '-z', '*.ko.md'], { cwd: root }).toString().split('\0')
  .filter(file => file && !file.startsWith('docs/')).map(file => path.join(root, file));
const sources = [...allDocs.filter(file => !file.endsWith('.ko.md')),
  ...pairedOutside.map(file => file.slice(0, -'.ko.md'.length) + '.md')];
const translations = new Map([...allDocs.filter(file => file.endsWith('.ko.md')), ...pairedOutside]
  .map(file => [file.slice(0, -'.ko.md'.length) + '.md', file]));

try {
  const legacyDir = path.join(docs, 'ko');
  if ((await stat(legacyDir)).isDirectory() && (await readdir(legacyDir)).length > 0) fail('docs.english-source', 'docs/ko is not allowed');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const headings = text => text.split('\n').filter(line => /^(#{1,6})\s+/.test(line)).map(line => line.match(/^(#{1,6})\s+/)[1].length);
// listShape는 제목으로 나눈 절마다 목록 항목의 들여쓰기를 차례로 돌려준다. code fence 안은 세지
// 않는다. 번역은 절마다 같은 수와 깊이의 목록 항목(규칙, 변경 기록 항목)을 가져야 한다.
const listShape = text => {
  const shape = [{ heading: '', items: [] }];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^#{1,6}\s/.test(line)) { shape.push({ heading: line, items: [] }); continue; }
    const item = /^(\s*)(?:[-*+]|\d+\.)\s/.exec(line);
    if (item) shape.at(-1).items.push(item[1].length);
  }
  return shape;
};
const fences = text => [...text.matchAll(/(^|\n)\s*```([^\n]*)\n/g)].map(match => match[2].trim());
const tables = text => text.split('\n').filter(line => /^\s*\|/.test(line)).map(line => line.split('|').length - 2);
// Style rules apply to prose. Code, HTML comments, inline code, link targets,
// and image targets are identifiers or values and are checked by other rules.
const prose = text => text
  .replace(/```[\s\S]*?```/g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/`[^`]*`/g, '')
  .replace(/!?(?:\[[^\]]*\])\(([^)]+)\)/g, '')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/<[^>]+>/g, '');
const stripCode = prose;
const koreanRatio = text => {
  const body = stripCode(text).replace(/https?:\/\/\S+/g, '').replace(/`[^`]*`/g, '');
  const korean = (body.match(/[가-힣]/g) || []).length;
  const latin = (body.match(/[A-Za-z]/g) || []).length;
  return korean / Math.max(1, korean + latin);
};
const normalizeLink = (href, file) => {
  const value = href.trim().split(/[?#]/, 1)[0];
  if (/^(?:[a-z]+:|\/\/)/i.test(value) || value === '') return value;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative(file)), value));
  return target.replace(/\.ko\.md$/, '.md').replace(/^\.\//, '');
};
const links = (text, file) => [...text.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)|\[[^\]]*\]\[([^\]]+)\]/g)].map(match => normalizeLink(match[1] || match[2], file));

for (const source of sources) {
  const translation = translations.get(source);
  if (!translation) {
    fail('docs.language-pair', `${relative(source)} has no ${relative(source).replace(/\.md$/, '.ko.md')} translation`);
    continue;
  }
  const english = await readFile(source, 'utf8');
  const korean = await readFile(translation, 'utf8');
  if (koreanRatio(english) > 0.2) fail('docs.language-pair', `${relative(source)} is not an English page`);
  if (JSON.stringify(headings(english)) !== JSON.stringify(headings(korean))) fail('docs.translation-shape', `${relative(translation)} headings differ`);
  if (JSON.stringify(fences(english)) !== JSON.stringify(fences(korean))) fail('docs.translation-shape', `${relative(translation)} code fence declarations differ`);
  if (JSON.stringify(tables(english)) !== JSON.stringify(tables(korean))) fail('docs.translation-shape', `${relative(translation)} table structure differs`);
  if (JSON.stringify(links(english, source)) !== JSON.stringify(links(korean, translation))) fail('docs.translation-shape', `${relative(translation)} link targets differ`);
  const englishLists = listShape(english);
  const koreanLists = listShape(korean);
  englishLists.forEach((section, index) => {
    const other = koreanLists[index];
    if (other && JSON.stringify(section.items) !== JSON.stringify(other.items))
      fail('docs.translation-shape', `${relative(translation)} section ${index} (${other.heading || 'before the first heading'}) has ${other.items.length} list items, ${relative(source)} section ${index} (${section.heading || 'before the first heading'}) has ${section.items.length}, or their depths differ`);
  });
}

const style = rules.rules.find(rule => rule.id === 'docs.writing-style');
if (!style || !Array.isArray(style.forbidden_ko) || !Array.isArray(style.forbidden_en)) fail('docs.writing-style', 'style lists are missing from contracts/rules.json');
for (const file of allDocs) {
  const text = prose(await readFile(file, 'utf8'));
  const terms = file.endsWith('.ko.md') ? style.forbidden_ko : style.forbidden_en;
  for (const term of terms) {
    const pattern = file.endsWith('.ko.md') ? term : `\\b${term}\\b`;
    if (new RegExp(pattern, 'i').test(text)) fail('docs.writing-style', `${relative(file)} contains forbidden expression ${JSON.stringify(term)}`);
  }
  if (file.endsWith('.ko.md') && /(?:요|어요|해요|합니다|됩니다|있어요|없어요)[.!?]?\s*$/.test(text.replace(/```[\s\S]*?```/g, '').trim())) fail('docs.writing-style', `${relative(file)} uses an informal ending`);
}

// VitePress는 문서의 Markdown을 Vue template으로 compile하므로, code 밖의 `<word>`는 HTML element로
// 읽혀 닫히지 않으면 build가 실패한다. code 밖에서 쓰는 element는 생성 문서의 줄바꿈 `<br>`뿐이다.
const allowedElements = new Set(['br']);
for (const file of allDocs) {
  const text = (await readFile(file, 'utf8'))
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`[^`\n]*`/g, '');
  for (const match of text.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)[^>\n]*>/g)) {
    if (!allowedElements.has(match[1].toLowerCase()))
      fail('docs.element', `${relative(file)} writes ${match[0]} outside code; put it in inline code`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`rules: ${sources.length} English documents, ${translations.size} Korean translations passed`);
log.end();
