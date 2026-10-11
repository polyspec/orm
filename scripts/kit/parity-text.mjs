// The rules of the language-parity check that read text: R9 (a list of implementation names in another file, such as the
// language constant of a tool, that differs from its profile) and R10 (a document that counts or lists the implementations
// unlike every profile).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { matchesAny } from './glob.mjs';
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

// The numbers that a count of implementations is written with: digits, the English words and the Korean native numerals.
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The text between two names of one list: a comma, and, or, /, 및, or a Korean particle 와 or 과 after the name.
const SEPARATOR = /^(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or|및)\s+|(?:와|과)\s+|\s*\/\s*)$/i;

/** The counts of `line`: each number followed by one of `nouns`, as `{ text, count }`. */
function countsOf(line, nouns) {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(\\d+|${Object.keys(NUMBERS).join('|')})\\s+(?:${nouns.map(escape).join('|')})(?![A-Za-z0-9])`, 'giu');
  return [...line.matchAll(pattern)].map(match => ({ text: match[0], count: /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBERS[match[1].toLowerCase()] }));
}

/** The lists of `line`: each run of three or more implementation names joined by separators, in the order of the text. */
function listsOf(line, names) {
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${[...names].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z0-9_-])`, 'gi');
  const lists = [];
  let current = [];
  let end = -1;
  for (const match of line.matchAll(pattern)) {
    if (current.length && !SEPARATOR.test(line.slice(end, match.index))) {
      lists.push(current);
      current = [];
    }
    current.push(match[0].toLowerCase());
    end = match.index + match[0].length;
  }
  lists.push(current);
  return lists.map(list => [...new Set(list)]).filter(list => list.length >= 3);
}

/** R10: the counts and lists of implementations in the declared documents, each equal to some profile. */
export function documentCounts(model, root, files) {
  const documents = model.config.documents;
  if (!documents) return [];
  const profiles = [...model.profiles].map(([name, members]) => ({ name, members }));
  const known = profiles.map(profile => `${profile.name} ${profile.members.length}`).join(', ');
  const sameSet = (list, members) => list.length === members.length && list.every(name => members.includes(name));
  const found = [];
  for (const file of [...files].filter(name => matchesAny(documents.globs, name)).sort()) {
    readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, index) => {
      const place = `${file}:${index + 1}`;
      for (const count of countsOf(line, documents.nouns)) {
        if (!profiles.some(profile => profile.members.length === count.count)) found.push(finding('R10', `"${count.text}" counts ${count.count}, and no profile has ${count.count} implementations (${known})`, { place }));
      }
      for (const list of listsOf(line, model.implementations.keys())) {
        if (!profiles.some(profile => sameSet(list, profile.members))) found.push(finding('R10', `the list ${list.join(', ')} is no profile (${profiles.map(profile => `${profile.name}: ${profile.members.join(', ')}`).join('; ')})`, { place }));
      }
    });
  }
  return found;
}
