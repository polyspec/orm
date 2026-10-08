#!/usr/bin/env node
// Checks the documents of a checkout (`make documents-check`), as `config/documents.json` declares them:
//
//   pair-missing    every English document has a Korean twin .ko.md and the reverse
//   doc-id          both files hold the same <!-- doc-id: <id> --> once; an id belongs to one document
//   revision        the Korean file holds <!-- source-sha256: <sha256 of the English file> --> once
//   sections        the explicit anchors <a id="..."></a> are the same in both files and appear once
//   fences          the fenced code blocks (info string and content) are the same in both files and every fence closes
//   link            every relative link resolves to a file, a directory, an explicit anchor or a heading anchor
//   private-path    no document holds a path into a user's home directory
//   interpolation   no {{ outside a fenced code block in the documents that a site renderer evaluates
//   checklist-*     the checklists of config/checklist.json hold only tasks, their markers and states are valid and equal in
//                   both languages (the strict reading of scripts/kit/checklist.mjs)
//   status-table    the status tables have the declared cells and values, equal in both languages
//   changelog       the changelogs start with ## Unreleased, then the versions newest first, equal in both languages
//
// Each finding is one line `<file>:<line>:<column>: <rule>: <message>` (line and column are left out where the finding
// has none). The command prints its findings and exits with status 1, or prints the count of what it checked.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { changelogFindings, changelogPairFindings } from './changelog.mjs';
import { CONFIG as CHECKLIST_CONFIG, loadConfig as loadChecklists, readChecklist, twinFindings } from './checklist.mjs';
import { matchesAny } from './glob.mjs';
import { anchors, headingAnchors, links, proseLines, scanFences } from './markdown.mjs';
import { readStatusTable } from './status-table.mjs';
import { trackedFiles } from './tracked-files.mjs';
import { isMain, ROOT } from './paths.mjs';
import { sha256 } from './digest.mjs';
import { readJson } from './files.mjs';

export const CONFIG = 'config/documents.json';
const DOC_ID = /<!-- doc-id: ([^>]*?) -->/g;
const REVISION = /<!-- source-sha256: ([^>]*?) -->/g;
const PRIVATE_PATH = /(?:\/(?:Users|home)\/[^/\s"'<>`)]+\/|[A-Za-z]:\\Users\\[^\\\s"'<>`)]+\\)/g;

const koreanOf = file => file.replace(/\.md$/, '.ko.md');
const englishOf = file => file.replace(/\.ko\.md$/, '.md');
const position = (text, offset) => {
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
};

/** A finding of `file` as the line the command prints. */
export const format = (file, found) => `${file}${found.line ? `:${found.line}${found.column ? `:${found.column}` : ''}` : ''}: ${found.rule}: ${found.message}`;

/** The English documents of the checkout: tracked Markdown files that `include` selects and `exclude` does not. */
export function documentsOf(root, config) {
  const excluded = config.exclude ?? [];
  const documents = new Set();
  for (const file of trackedFiles(root)) {
    if (file.endsWith('.md') && matchesAny(config.include, file) && !matchesAny(excluded, file)) documents.add(englishOf(file));
  }
  return [...documents].sort();
}

/** The findings of the link `target` written in `file`: an empty list when it resolves. */
function linkFindings(root, config, file, link, read) {
  const { target } = link;
  const at = (message) => ({ line: link.line, column: link.column, rule: 'link', message });
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return [];
  const [location, fragment] = [target.split('#')[0], target.includes('#') ? decodeURIComponent(target.slice(target.indexOf('#') + 1)) : ''];
  if (location.startsWith('/')) return config.siteLinks ? [] : [at(`the link ${target} starts with /; write a link relative to the file`)];
  if (location.includes('?')) return [at(`the link ${target} has a query; a link to a file has none`)];
  let absolute = path.resolve(root, path.dirname(file));
  if (location) {
    try { absolute = path.resolve(absolute, decodeURIComponent(location)); } catch { return [at(`the link ${target} is not a valid path (bad % escape)`)]; }
  } else absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [at(`the link ${target} leaves the repository`)];
  let resolved = absolute;
  if (!existsSync(resolved) && config.siteLinks) {
    resolved = [`${absolute}.md`, `${absolute}.ko.md`, path.join(absolute, 'index.md')].find(existsSync) ?? absolute;
  }
  if (!existsSync(resolved)) return [at(`the link ${target} names ${relative}, which does not exist`)];
  if (!fragment) return [];
  if (statSync(resolved).isDirectory() || !resolved.endsWith('.md')) return [at(`the link ${target} has an anchor, but ${path.relative(root, resolved)} is not a Markdown file`)];
  const text = read(path.relative(root, resolved));
  if (anchors(text).includes(fragment) || headingAnchors(text).includes(fragment.toLowerCase())) return [];
  return [at(`the link ${target} names the anchor #${fragment}, which ${path.relative(root, resolved)} does not define`)];
}

/** The findings of one pair as `[file, finding]` entries. */
function pairFindings(root, config, english, ids, read) {
  const korean = koreanOf(english);
  const found = [];
  const add = (file, entry) => found.push([file, entry]);
  const exists = { [english]: existsSync(path.join(root, english)), [korean]: existsSync(path.join(root, korean)) };
  if (!exists[english]) add(korean, { rule: 'pair-missing', message: `the English file ${english} does not exist; every Korean document has an English original` });
  if (!exists[korean]) add(english, { rule: 'pair-missing', message: `the Korean twin ${korean} does not exist; every English document has one` });
  if (!exists[english] || !exists[korean]) return found;
  const bytes = readFileSync(path.join(root, english));
  const texts = { [english]: bytes.toString('utf8'), [korean]: read(korean) };
  const files = [english, korean];

  // A marker written inside inline code or a fenced block describes the marker and is not one.
  const prose = Object.fromEntries(files.map(file => [file, proseLines(texts[file]).map(entry => entry.text).join('\n')]));
  const identifiers = files.map(file => [...prose[file].matchAll(DOC_ID)].map(match => match[1]));
  files.forEach((file, index) => {
    if (identifiers[index].length !== 1) add(file, { rule: 'doc-id', message: `the file has ${identifiers[index].length} doc-id markers; expected exactly 1 <!-- doc-id: <id> -->` });
    else if (!/^[a-z][a-z0-9-]*$/.test(identifiers[index][0])) add(file, { rule: 'doc-id', message: `the doc-id ${JSON.stringify(identifiers[index][0])} does not match [a-z][a-z0-9-]*` });
  });
  if (identifiers.every(list => list.length === 1)) {
    if (identifiers[0][0] !== identifiers[1][0]) add(korean, { rule: 'doc-id', message: `the doc-id is ${identifiers[1][0]}; the English file ${english} has ${identifiers[0][0]}` });
    else if (ids.has(identifiers[0][0])) add(english, { rule: 'doc-id', message: `the doc-id ${identifiers[0][0]} is also the doc-id of ${ids.get(identifiers[0][0])}; an id names one document` });
    else ids.set(identifiers[0][0], english);
  }

  const revisions = [...prose[korean].matchAll(REVISION)].map(match => match[1]);
  const expected = sha256(bytes);
  if (revisions.length !== 1) add(korean, { rule: 'revision', message: `the file has ${revisions.length} source-sha256 markers; expected exactly 1 <!-- source-sha256: ${expected} -->` });
  else if (revisions[0] !== expected) add(korean, { rule: 'revision', message: `the source-sha256 is ${revisions[0]}; the sha256 of ${english} is ${expected}; review the translation and update the marker` });

  const anchorLists = files.map(file => anchors(texts[file]));
  files.forEach((file, index) => {
    const repeated = anchorLists[index].find((anchor, at) => anchorLists[index].indexOf(anchor) !== at);
    if (repeated) add(file, { rule: 'sections', message: `the section anchor ${repeated} appears more than once` });
  });
  if (anchorLists[0].join('\n') !== anchorLists[1].join('\n')) add(korean, { rule: 'sections', message: `the section anchors are [${anchorLists[1].join(', ')}]; ${english} has [${anchorLists[0].join(', ')}]` });

  const fences = files.map(file => scanFences(texts[file]));
  files.forEach((file, index) => {
    if (fences[index].unclosed) add(file, { line: fences[index].unclosed, column: 1, rule: 'fences', message: 'the fenced code block opened here never closes' });
  });
  const [a, b] = [fences[0].blocks, fences[1].blocks];
  const differing = a.findIndex((block, at) => !b[at] || block.info !== b[at].info || block.body !== b[at].body);
  if (differing !== -1 || a.length !== b.length) {
    const at = differing === -1 ? a.length : differing;
    add(korean, { line: b[at]?.line, column: b[at] ? 1 : undefined, rule: 'fences', message: `the fenced code block ${at + 1} differs from ${english}${a[at] ? ` (line ${a[at].line})` : ''}; the files have ${b.length} and ${a.length} blocks` });
  }

  for (const file of files) {
    const read1 = links(texts[file]);
    for (const problem of read1.problems) add(file, { ...problem, rule: 'link' });
    for (const link of read1.links) for (const entry of linkFindings(root, config, file, link, read)) add(file, entry);
    for (const match of texts[file].matchAll(PRIVATE_PATH)) {
      add(file, { ...position(texts[file], match.index), rule: 'private-path', message: `the document holds the path ${match[0]} into a home directory; write a repository-relative path` });
    }
    if (matchesAny(config.interpolation ?? [], english)) {
      const { fenced } = fences[files.indexOf(file)];
      texts[file].split('\n').forEach((line, index) => {
        if (fenced[index]) return;
        const prose = line.replace(/<(code|span)\s+v-pre>[\s\S]*?<\/\1>/g, match => ' '.repeat(match.length));
        const at = prose.indexOf('{{');
        if (at !== -1) add(file, { line: index + 1, column: at + 1, rule: 'interpolation', message: '{{ outside a fenced code block is evaluated by the site renderer; write it in <code v-pre>...</code>' });
      });
    }
  }
  return found;
}

/** The findings of the checkout at `root` under `config`, as printed lines, sorted. */
export function check(root, config) {
  const cache = new Map();
  const read = file => {
    if (!cache.has(file)) cache.set(file, readFileSync(path.join(root, file), 'utf8'));
    return cache.get(file);
  };
  const found = [];
  const add = (file, entry) => found.push([file, entry]);
  const documents = documentsOf(root, config);
  const ids = new Map();
  for (const english of documents) found.push(...pairFindings(root, config, english, ids, read));

  const both = (files, source, run) => {
    for (const name of files) {
      if (!existsSync(path.join(root, name))) add(name, { rule: 'pair-missing', message: `the file named in ${source} does not exist` });
      else run(name, read(name));
    }
  };
  let checklists = [];
  if (existsSync(path.join(root, CHECKLIST_CONFIG))) {
    try { checklists = loadChecklists(root).trackers; } catch (error) { add(CHECKLIST_CONFIG, { rule: 'config', message: error.message }); }
  }
  for (const list of checklists) {
    const results = [];
    both([list.path, ...(list.translation ? [list.translation] : [])], CHECKLIST_CONFIG, (name, text) => {
      const result = readChecklist(text, list, { strict: true });
      for (const entry of result.findings) add(name, entry);
      results.push(result.items);
    });
    if (results.length === 2) for (const entry of twinFindings(results[0], results[1], list, { strict: true })) add(list.translation, entry);
  }
  for (const table of config.statusTables ?? []) {
    const results = [];
    both([table.path, koreanOf(table.path)], CONFIG, (name, text) => {
      const result = readStatusTable(text, table);
      for (const entry of result.findings) add(name, entry);
      results.push([name, result.rows]);
    });
    if (results.length === 2) {
      const [[, en], [ko, kor]] = results;
      const show = rows => rows.map(row => [row.id, ...row.values].join('/')).join(' ');
      if (show(en) !== show(kor)) add(ko, { rule: 'status-table', message: `the rows differ from ${table.path}: [${show(kor)}] and [${show(en)}]` });
    }
  }
  for (const changelog of config.changelogs ?? []) {
    const texts = [];
    both([changelog, koreanOf(changelog)], CONFIG, (name, text) => {
      for (const entry of changelogFindings(text)) add(name, entry);
      texts.push(text);
    });
    if (texts.length === 2) for (const entry of changelogPairFindings(texts[0], texts[1])) add(koreanOf(changelog), entry);
  }
  const lines = found.map(([file, entry]) => [file, entry.line ?? 0, entry.column ?? 0, format(file, entry)]);
  lines.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || x[2] - y[2] || (x[3] < y[3] ? -1 : 1)));
  return { findings: [...new Set(lines.map(line => line[3]))], documents: documents.length, checklists: checklists.length };
}

if (isMain(import.meta.url)) {
  const root = ROOT;
  if (!existsSync(path.join(root, CONFIG))) {
    console.error(`[check-documents] ${CONFIG} does not exist; declare the documents of the repository there (scripts/kit/schema/documents.schema.json)`);
    process.exit(1);
  }
  const config = readJson(root, CONFIG);
  console.log(`[check-documents] reading the documents selected by ${CONFIG}`);
  const { findings, documents, checklists } = check(root, config);
  for (const line of findings) console.error(`[check-documents] ${line}`);
  if (findings.length) {
    console.error(`[check-documents] ${findings.length} findings in ${documents} document pairs`);
    process.exit(1);
  }
  console.log(`[check-documents] ${documents} document pairs, ${checklists} checklists, ${(config.statusTables ?? []).length} status tables and ${(config.changelogs ?? []).length} changelogs passed`);
}
