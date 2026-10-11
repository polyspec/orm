// The rules of the language-parity check that read text: R9 (a list of implementation names in another file, such as the
// language constant of a tool, that differs from its profile) and R10 (a document that counts or lists the implementations
// unlike every profile).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { matchesAny } from './glob.mjs';
import { scanFences, withoutInlineCode } from './markdown.mjs';
import { captured, difference, finding } from './parity-declaration.mjs';

/** The words of a list: each run of letters, digits, _ and - that starts with a letter. */
const words = text => [...text.matchAll(/[A-Za-z][A-Za-z0-9_-]*/g)].map(match => match[0].toLowerCase());

/** R9: the names of each declared list against its profile. */
export function languageLists(model, root) {
  return (model.config.languageLists ?? []).flatMap((list) => {
    const expected = model.profiles.get(list.profile);
    const matches = captured(readFileSync(path.join(root, list.file), 'utf8'), list.pattern);
    if (!matches.length) return [finding('R9', `the pattern ${list.pattern} matches nothing; the list moved or the declaration is stale`, { place: list.file })];
    return matches.flatMap((match) => {
      const found = [...new Set(words(match.text))];
      const differs = difference(expected, found, 'the profile');
      return differs ? [finding('R9', `the list differs from the profile ${list.profile}: ${differs}`, { place: `${list.file}:${match.line}` })] : [];
    });
  });
}

// The numbers that a count of implementations is written with: digits, the English words with both, and the Korean native
// numerals.
const NUMBERS = { one: 1, two: 2, both: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The text between two names of one list: a comma, and, or, /, 및, or a Korean particle 와 or 과 after the name.
const SEPARATOR = /^(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or|및)\s+|(?:와|과)\s+|\s*\/\s*)$/i;

/**
 * The counts of `text`: each number followed by one of `nouns` after a space, a hyphen (four-client) or a Korean counter
 * (6개 언어, 여섯 개 언어, 세 가지 언어), as `{ text, count, index }`.
 */
function countsOf(text, nouns) {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(\\d+|${Object.keys(NUMBERS).join('|')})(?:\\s*(?:개|가지)\\s*|\\s+|-)(?:${nouns.map(escape).join('|')})(?![A-Za-z0-9])`, 'giu');
  return [...text.matchAll(pattern)].map(match => ({ text: match[0], count: /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBERS[match[1].toLowerCase()], index: match.index }));
}

/** The implementation names of `text` in the order of the text, as `{ name, index, end }`. */
function namesOf(text, names) {
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${[...names].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z0-9_-])`, 'gi');
  return [...text.matchAll(pattern)].map(match => ({ name: match[0].toLowerCase(), index: match.index, end: match.index + match[0].length }));
}

/** The lists of `text`: each run of three or more of the names `found` joined by separators, as `{ names, index }`. */
function listsOf(text, found) {
  const lists = [];
  for (const match of found) {
    const last = lists.at(-1);
    if (last && SEPARATOR.test(text.slice(last.end, match.index))) Object.assign(last, { names: [...last.names, match.name], end: match.end });
    else lists.push({ names: [match.name], index: match.index, end: match.end });
  }
  return lists.map(list => ({ names: [...new Set(list.names)], index: list.index })).filter(list => list.names.length >= 3);
}

// The Markdown blocks that bound a passage: an ATX heading and a table row stand alone; a list item, a block quote after
// other text and a setext underline start or end one; a line indented by four spaces outside a passage is code.
const ATX = /^ {0,3}#{1,6}(?:\s|$)/;
const TABLE = /^ {0,3}\|/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;
const QUOTE = /^(?: {0,3}> ?)+/;
const SETEXT = /^ {0,3}(?:=+|-+)\s*$/;
const INDENTED = /^(?: {4}|\t)/;

/**
 * The passages of the Markdown `text` outside its fenced blocks, each `{ text, line, table }` with the number of its first
 * line: a paragraph or a list item with the lines that continue it (a block quote without its markers), a heading, or a
 * table row. Inline code is blanked.
 */
function passagesOf(text) {
  const { fenced } = scanFences(text);
  const passages = [];
  let current;
  text.split('\n').forEach((raw, index) => {
    if (fenced[index] || !raw.trim()) {
      current = undefined;
      return;
    }
    const quoted = QUOTE.test(raw);
    const line = withoutInlineCode(raw.replace(QUOTE, ''));
    if (!line.trim() || (current && SETEXT.test(line))) {
      current = undefined;
      return;
    }
    if (!current && !quoted && INDENTED.test(raw)) return;
    const alone = ATX.test(line) || TABLE.test(line);
    if (current && !alone && !ITEM.test(line) && !(quoted && !current.quoted)) {
      current.text += `\n${line}`;
      return;
    }
    current = { text: line, line: index + 1, table: TABLE.test(line), quoted };
    passages.push(current);
    if (alone) current = undefined;
  });
  return passages;
}

const blank = text => text.replace(/[^\n]/g, ' ');

/**
 * The prose of a passage: its comments, HTML tags, autolinks, bare URLs, link definitions and link destinations blanked, a
 * link keeping its text, so that only prose names an implementation and each character keeps its line.
 */
function proseOf(text) {
  return text.replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<(?:https?:\/\/|mailto:)[^>\s]*>/g, blank)
    .replace(/<\/?[A-Za-z][^>]*>/g, blank)
    .replace(/^ {0,3}\[[^\]\n]+\]:.*$/gm, blank)
    .replace(/!?\[([^\]\n]*)\](?:\([^)\n]*\)|\[[^\]\n]*\])/g, (whole, label) => {
      const open = whole.indexOf('[') + 1;
      return blank(whole.slice(0, open)) + label + blank(whole.slice(open + label.length));
    })
    .replace(/\bhttps?:\/\/\S+/g, blank);
}

/** The sentences of `text`, each `{ text, index }`: they end at ., ! or ? before a space or the end, and a table cell ends one. */
function sentencesOf(text, table) {
  const sentences = [];
  let start = 0;
  for (const match of text.matchAll(table ? /[.!?](?=\s|$)|(?<!\\)\|/g : /[.!?](?=\s|$)/g)) {
    sentences.push({ text: text.slice(start, match.index + 1), index: start });
    start = match.index + 1;
  }
  if (start < text.length) sentences.push({ text: text.slice(start), index: start });
  return sentences;
}

/**
 * R10: the counts and lists of implementations in the prose of the declared documents. A count N, a number before a noun of
 * `documents`, holds when a profile of N implementations holds every implementation that its sentence names, or when its
 * sentence names exactly N implementations and the names of its passage together are a profile. A list, three names or more,
 * holds when the names of its sentence together are a profile.
 */
export function documentCounts(model, root, files) {
  const documents = model.config.documents;
  if (!documents) return [];
  const profiles = [...model.profiles].map(([name, members]) => ({ name, members }));
  const known = profiles.map(profile => `${profile.name} ${profile.members.length}`).join(', ');
  const listed = profiles.map(profile => `${profile.name}: ${profile.members.join(', ')}`).join('; ');
  const sameSet = (names, members) => names.length === members.length && names.every(name => members.includes(name));
  const found = [];
  for (const file of [...files].filter(name => matchesAny(documents.globs, name)).sort()) {
    for (const passage of passagesOf(readFileSync(path.join(root, file), 'utf8'))) {
      const prose = proseOf(passage.text);
      const place = index => `${file}:${passage.line + prose.slice(0, index).split('\n').length - 1}`;
      const named = text => [...new Set(namesOf(text, model.implementations.keys()).map(match => match.name))];
      const passageProfile = profiles.some(profile => sameSet(named(prose), profile.members));
      for (const sentence of sentencesOf(prose, passage.table)) {
        const names = namesOf(sentence.text, model.implementations.keys());
        const sentenceNames = named(sentence.text);
        for (const count of countsOf(sentence.text, documents.nouns)) {
          const held = profiles.some(profile => profile.members.length === count.count && sentenceNames.every(name => profile.members.includes(name)));
          if (held || (sentenceNames.length === count.count && passageProfile)) continue;
          const holds = sentenceNames.length ? `no profile of ${count.count} implementations holds ${sentenceNames.join(', ')}, the implementations of its sentence` : `no profile has ${count.count} implementations`;
          found.push(finding('R10', `"${count.text}" counts ${count.count}, and ${holds} (${known})`, { place: place(sentence.index + count.index) }));
        }
        if (profiles.some(profile => sameSet(sentenceNames, profile.members))) continue;
        for (const list of listsOf(sentence.text, names)) {
          found.push(finding('R10', `the list ${list.names.join(', ')} is in a sentence that names ${sentenceNames.join(', ')}, which is no profile (${listed})`, { place: place(sentence.index + list.index) }));
        }
      }
    }
  }
  return found;
}
