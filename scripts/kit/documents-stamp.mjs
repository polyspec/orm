#!/usr/bin/env node
// Writes the revision marker of the Korean documents (`make documents-stamp`): in every pair that config/documents.json
// selects, the Korean file gets `<!-- source-sha256: <sha256 of the English file> -->`, which replaces its marker or, when
// it has none, follows its `<!-- doc-id: ... -->` line. Run it after the Korean text matches the English text; the checker
// (`make documents-check`) compares the marker, so a stamp on an unreviewed translation hides a missing translation.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG, documentsOf } from './check-documents.mjs';
import { sha256 } from './digest.mjs';
import { readJson, writeAtomic } from './files.mjs';
import { proseLines } from './markdown.mjs';
import { isMain, ROOT } from './paths.mjs';

const REVISION = /<!-- source-sha256: [^>]*? -->/;
const DOC_ID = /<!-- doc-id: [^>]*? -->/;

/** The text of a Korean document with the marker `<!-- source-sha256: ${sha} -->`, or null when it has no doc-id line. */
export function stamped(text, sha) {
  const marker = `<!-- source-sha256: ${sha} -->`;
  const lines = text.split('\n');
  const prose = proseLines(text);
  const existing = prose.find(entry => REVISION.test(entry.text));
  if (existing) {
    lines[existing.line - 1] = lines[existing.line - 1].replace(REVISION, marker);
    return lines.join('\n');
  }
  const id = prose.find(entry => DOC_ID.test(entry.text));
  if (!id) return null;
  lines.splice(id.line, 0, marker);
  return lines.join('\n');
}

/** Stamps every Korean document of the pairs; returns `{ changed, failed }` lists of file names. */
export function stampAll(root, config) {
  const changed = [];
  const failed = [];
  for (const english of documentsOf(root, config)) {
    const korean = english.replace(/\.md$/, '.ko.md');
    if (!existsSync(path.join(root, english)) || !existsSync(path.join(root, korean))) continue;
    const before = readFileSync(path.join(root, korean), 'utf8');
    const after = stamped(before, sha256(readFileSync(path.join(root, english))));
    if (after === null) failed.push(korean);
    else if (after !== before) {
      writeAtomic(path.join(root, korean), after);
      changed.push(korean);
    }
  }
  return { changed, failed };
}

if (isMain(import.meta.url)) {
  if (!existsSync(path.join(ROOT, CONFIG))) {
    console.error(`[documents-stamp] ${CONFIG} does not exist`);
    process.exit(1);
  }
  const { changed, failed } = stampAll(ROOT, readJson(ROOT, CONFIG));
  for (const file of changed) console.log(`[documents-stamp] stamped ${file}`);
  for (const file of failed) console.error(`[documents-stamp] ${file} has no <!-- doc-id: ... --> line; add the doc-id of the English file first`);
  console.log(`[documents-stamp] ${changed.length} stamped, ${failed.length} failed`);
  if (failed.length) process.exit(1);
}
