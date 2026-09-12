import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { docs, root, files } from './lib.mjs';

const rules = JSON.parse(await readFile(path.join(root, 'contracts/rules.json'), 'utf8'));
if (rules.version !== 1 || !Array.isArray(rules.rules)) throw new Error('contracts/rules.json: invalid rule registry');

const failures = [];
const fail = (id, message) => failures.push(`${id}: ${message}`);
const relative = file => path.relative(root, file).split(path.sep).join('/');

const allDocs = (await files(docs)).filter(file => file.endsWith('.md') && !file.includes(`${path.sep}.vitepress${path.sep}`));
const sources = allDocs.filter(file => !file.endsWith('.ko.md'));
const translations = new Map(allDocs.filter(file => file.endsWith('.ko.md')).map(file => [file.slice(0, -'.ko.md'.length) + '.md', file]));

try {
  const legacyDir = path.join(docs, 'ko');
  if ((await stat(legacyDir)).isDirectory() && (await readdir(legacyDir)).length > 0) fail('docs.english-source', 'docs/ko is not allowed');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const headings = text => text.split('\n').filter(line => /^(#{1,6})\s+/.test(line)).map(line => line.match(/^(#{1,6})\s+/)[1].length);
const fences = text => [...text.matchAll(/(^|\n)\s*```([^\n]*)\n([\s\S]*?)(?:\n\s*)?```/g)].map(match => [match[2].trim(), match[3].replace(/\r\n/g, '\n')]);
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

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`rules: ${sources.length} English documents, ${translations.size} Korean translations passed`);
