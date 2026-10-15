import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { docs, root, files } from './lib.mts';
import { COMPUTE, sections } from '../../tests/testcase.mts';
import { kitCopies } from '../repo/kit-copies.mts';
import { readJsonFile } from '../json/schema.mts';
import { errorCode } from '../../tests/errors.mts';

// rules check는 문서 file을 읽어 쌍과 문체를 검사하는 case 하나다.
const log = sections();
log.begin('docs-rules', COMPUTE);

/** contracts/rules.json, the shape its schema (schema/rules.schema.json) declares. */
type RuleRegistry = { version: 1; rules: { id: string; source: string; checker: string; failure: string; forbidden_ko?: string[]; forbidden_en?: string[] }[] };
const rules = readJsonFile<RuleRegistry>(path.join(root, 'contracts/rules.json'), new URL('./schema/rules.schema.json', import.meta.url).pathname);

const failures: string[] = [];
const fail = (id: string, message: string) => failures.push(`${id}: ${message}`);
const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');

const allDocs = (await files(docs)).filter(file => file.endsWith('.md') && !file.includes(`${path.sep}.vitepress${path.sep}`));
// docs/ 밖의 추적되는 한국어 문서(AGENTS.ko.md, README.ko.md, CHANGELOG.ko.md 등)도 영문 원본과
// 같은 구조 검사를 받는다.
// The copies of @polyspec/kit (kit.copies of its package.json) are kit's documents: the rules of this repository do not read
// them (AGENTS.md), and kit checks them where they are written.
const vendored = new Set(Object.keys(kitCopies(root)));
const pairedOutside = execFileSync('git', ['ls-files', '-z', '*.ko.md'], { cwd: root }).toString().split('\0')
  .filter(file => file && !file.startsWith('docs/') && !vendored.has(file)).map(file => path.join(root, file));
const sources = [...allDocs.filter(file => !file.endsWith('.ko.md')),
  ...pairedOutside.map(file => file.slice(0, -'.ko.md'.length) + '.md')];
const translations = new Map([...allDocs.filter(file => file.endsWith('.ko.md')), ...pairedOutside]
  .map(file => [file.slice(0, -'.ko.md'.length) + '.md', file]));

try {
  const legacyDir = path.join(docs, 'ko');
  if ((await stat(legacyDir)).isDirectory() && (await readdir(legacyDir)).length > 0) fail('docs.english-source', 'docs/ko is not allowed');
} catch (error) {
  if (errorCode(error) !== 'ENOENT') throw error;
}

const headings = (text: string) => text.split('\n').filter((line: string) => /^(#{1,6})\s+/.test(line)).map((line: string) => /^(#{1,6})\s+/.exec(line)?.[1]?.length ?? 0);
// listShape는 제목으로 나눈 절마다 목록 항목의 들여쓰기를 차례로 돌려준다. code fence 안은 세지
// 않는다. 번역은 절마다 같은 수와 깊이의 목록 항목(규칙, 변경 기록 항목)을 가져야 한다.
const listShape = (text: string) => {
  const shape: { heading: string; items: number[] }[] = [{ heading: '', items: [] }];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^#{1,6}\s/.test(line)) { shape.push({ heading: line, items: [] }); continue; }
    const item = /^(\s*)(?:[-*+]|\d+\.)\s/.exec(line);
    if (item) shape.at(-1)?.items.push(item[1]?.length ?? 0);
  }
  return shape;
};
const fences = (text: string) => [...text.matchAll(/(^|\n)\s*```([^\n]*)\n/g)].map(match => (match[2] ?? '').trim());
const tables = (text: string) => text.split('\n').filter((line: string) => /^\s*\|/.test(line)).map((line: string) => line.split('|').length - 2);
// Style rules apply to prose. Code, HTML comments, inline code, link targets,
// and image targets are identifiers or values and are checked by other rules.
const prose = (text: string) => text
  .replace(/```[\s\S]*?```/g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/`[^`]*`/g, '')
  .replace(/!?(?:\[[^\]]*\])\(([^)]+)\)/g, '')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/<[^>]+>/g, '');
const stripCode = prose;
const koreanRatio = (text: string) => {
  const body = stripCode(text).replace(/https?:\/\/\S+/g, '').replace(/`[^`]*`/g, '');
  const korean = (body.match(/[가-힣]/g) || []).length;
  const latin = (body.match(/[A-Za-z]/g) || []).length;
  return korean / Math.max(1, korean + latin);
};
const normalizeLink = (href: string, file: string) => {
  const value = (href.trim().split(/[?#]/, 1)[0] ?? '');
  if (/^(?:[a-z]+:|\/\/)/i.test(value) || value === '') return value;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative(file)), value));
  return target.replace(/\.ko\.md$/, '.md').replace(/^\.\//, '');
};
const links = (text: string, file: string) => [...text.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)|\[[^\]]*\]\[([^\]]+)\]/g)].map(match => normalizeLink(match[1] || match[2] || '', file));

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
const forbidden = { ko: style?.forbidden_ko, en: style?.forbidden_en };
if (!forbidden.ko || !forbidden.en) fail('docs.writing-style', 'style lists are missing from contracts/rules.json');
for (const file of allDocs) {
  const text = prose(await readFile(file, 'utf8'));
  const terms = (file.endsWith('.ko.md') ? forbidden.ko : forbidden.en) ?? [];
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
    if (!allowedElements.has((match[1] ?? '').toLowerCase()))
      fail('docs.element', `${relative(file)} writes ${match[0]} outside code; put it in inline code`);
  }
}

// The implementation count of the documents is the client profile of config/parity.json, and the conformance runners
// of tests/conformance/check/main.mts (requiredLanguages) must be that same list. A document that counts clients,
// implementations, runners, planners or outputs in English or Korean states the profile's number; history (CHANGELOG,
// the checklist) is not checked.
type Parity = { profiles: { name: string; implementations: string[] }[] };
const parity = JSON.parse(await readFile(path.join(root, 'config/parity.json'), 'utf8')) as Parity;
const clients = parity.profiles.find(profile => profile.name === 'client')?.implementations ?? [];
const runnerSource = await readFile(path.join(root, 'tests/conformance/check/main.mts'), 'utf8');
const runners = [...(/export const requiredLanguages = \[([^\]]*)\]/.exec(runnerSource)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1] ?? '');
if (clients.length === 0) fail('docs.implementation-count', 'config/parity.json has no client profile');
if (JSON.stringify([...clients].sort()) !== JSON.stringify([...runners].sort()))
  fail('docs.implementation-count', `tests/conformance/check/main.mts requiredLanguages (${runners.join(', ')}) differs from the client profile of config/parity.json (${clients.join(', ')})`);
const numberWords: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const koreanNumbers: Record<string, number> = { 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const countedEnglish = /\b(two|three|four|five|six|seven|eight|nine|ten|\d+)\b(?:[ -]+[\w-]+){0,2}?[ -]+(clients?|implementations?|runners?|planners?)\b|\b(two|three|four|five|six|seven|eight|nine|ten|\d+)[ -]+(outputs?)\b/gi;
const countedKorean = /(?<![가-힣])(두|세|네|다섯|여섯|일곱|여덟|아홉|열|\d+)[ \t]*(?:개[ \t]*)?(클라이언트|구현|러너|플래너)/g;
for (const file of [...sources, ...translations.values()]) {
  if (file.includes(`${path.sep}docs${path.sep}plans${path.sep}`) || path.basename(file).startsWith('CHANGELOG')) continue;
  const text = prose(await readFile(file, 'utf8'));
  const isKorean = file.endsWith('.ko.md');
  for (const match of text.matchAll(isKorean ? countedKorean : countedEnglish)) {
    const word = (match[1] ?? match[3] ?? '').toLowerCase();
    const value = /^\d+$/.test(word) ? Number(word) : isKorean ? koreanNumbers[word] : numberWords[word];
    if (value !== clients.length) fail('docs.implementation-count', `${relative(file)} counts ${JSON.stringify(match[0].trim())}; config/parity.json declares ${clients.length} clients (${clients.join(', ')})`);
  }
}

// The planning table of protocol section 4 names every client of the profile, one row each.
const clientNames: Record<string, string> = { go: 'Go', php: 'PHP', rust: 'Rust', typescript: 'TypeScript', python: 'Python' };
for (const file of ['docs/protocol.md', 'docs/protocol.ko.md']) {
  const text = await readFile(path.join(root, file), 'utf8');
  const section = text.slice(text.search(/^## 4\./m), text.search(/^## 5\./m));
  const rows = section.split('\n').filter(line => /^\|/.test(line)).map(line => (line.split('|')[1] ?? '').trim());
  for (const client of clients) {
    const name = clientNames[client] ?? client;
    if (!rows.includes(name)) fail('docs.implementation-count', `${file} section 4 has no ${name} row; config/parity.json declares ${client}`);
  }
}

// Structured places: a table whose header names two or more client languages has one column per declared client, and a
// sentence that uses two or more client names as the set ("the clients", "implementations", "languages", "runners" or
// "planners", in English or Korean) names all of them. A subset statement about some clients is not checked.
const clientDisplay = [...new Set(clients.map(client => clientNames[client] ?? client))];
const names = clientDisplay.join('|');
const setNoun = /\b(clients?|implementations?|languages?|runners?|planners?)\b|클라이언트|구현|언어|러너|플래너/i;
const enumerated = new RegExp(`\\b(?:${names})\\b(?: extension)?(?:(?:\\s*[,·]\\s*(?:(?:and|or)\\s+)?(?:the\\s+)?|\\s+(?:and|or)\\s+)(?:${names})\\b(?: extension)?)+`, 'g');
for (const file of [...sources, ...translations.values()]) {
  if (file.includes(`${path.sep}docs${path.sep}plans${path.sep}`) || path.basename(file).startsWith('CHANGELOG')) continue;
  const lines = (await readFile(file, 'utf8')).replace(/```[\s\S]*?```|<!--[\s\S]*?-->/g, block => block.replace(/[^\n]/g, '')).replace(/`/g, '').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const next = lines[index + 1] ?? '';
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(next)) {
      const header = line.split('|').slice(1, -1).map(cell => cell.trim());
      const languages = header.map(cell => cell.split(/\s+/)[0] ?? '').filter(cell => clientDisplay.includes(cell));
      if (languages.length >= 2) {
        for (const name of clientDisplay) {
          if (!languages.includes(name)) fail('docs.implementation-count', `${relative(file)} line ${index + 1} table header names ${languages.join(', ')} and has no ${name} column`);
        }
      }
    }
    for (const match of line.matchAll(enumerated)) {
      // The run is the set when a set noun stands within two words before or after it in the same sentence.
      const start = match.index ?? 0;
      const before = line.slice(0, start).split(/[.!?。]\s+/).pop()?.trim().split(/\s+/).slice(-2).join(' ') ?? '';
      const after = line.slice(start + match[0].length).split(/[.!?。]\s+/)[0]?.trim().split(/\s+/).slice(0, 2).join(' ') ?? '';
      if (!setNoun.test(before) && !setNoun.test(after)) continue;
      const found = new Set([...match[0].matchAll(new RegExp(`\\b(${names})\\b`, 'g'))].map(item => item[1] ?? ''));
      const missing = clientDisplay.filter(name => !found.has(name));
      if (missing.length) fail('docs.implementation-count', `${relative(file)} line ${index + 1} uses ${JSON.stringify(match[0])} as the set and omits ${missing.join(', ')}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`rules: ${sources.length} English documents, ${translations.size} Korean translations passed`);
log.end();
