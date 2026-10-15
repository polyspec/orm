// The shared vectors of tests/dbspec through the language service: every canonical and normalize case formats to its
// canonical text, every invalid case reports its errors and is refused by format, formatting keeps the manifest and
// schema hashes and is idempotent, and the tokens of every syntax vector equal the tokens of openDocument after the
// UTF-16 conversion. The documents of a sets case are written as a file tree with their set file and each takes its
// set from resolveSet, so a case whose documents repeat a name runs too: resolveSet reports the repetition.
//
// Usage: node --test packages/dbspec-language/tests/vectors.test.mjs (after the build)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { caseTest } from '../../../tests/testcase.mts';
import * as language from '../dist/index.js';
import { nodeSetHost } from '../dist/cli/host.js';
import { parseDbspec } from '@polyspec/orm/dbspec';
import { dbspecManifest } from '@polyspec/orm';
import { codePointIndex, join, parserLines, utf16Index, vectorsFile } from './helpers.mjs';
import { readCases } from '../../../tests/dbspec/cases.mts';

// The deadline of one case; each case runs through caseTest so it reports its RUN, PASS or FAIL line.
const TIMEOUT = 15000;
const vector = (name, body) => caseTest(name, TIMEOUT, body);

const { openDocument, resolveSet } = language;
const cases = readCases();
const syntax = vectorsFile('syntax.json');

/** The text of a document of a case, joined with the case's line ends. */
function textOf(c, name) {
  return join(c.documents[name], c.crlf === true, c.mixed === true);
}

/** The set of a case for one of its documents: the other documents by name. */
function setOf(c, name) {
  const set = {};
  for (const other of Object.keys(c.documents)) {
    if (other !== name) set[other] = textOf(c, other);
  }
  return set;
}

/** The name a header line declares. */
const headerName = lines => lines[0].split(' ')[2];

/** The 1-based line and code point column of a range start, with the rule: the form of the case errors. */
function errorOf(text, d) {
  const line = parserLines(text)[d.range.start.line];
  return { line: d.range.start.line + 1, column: codePointIndex(line, d.range.start.character) + 1, rule: d.rule };
}

for (const c of cases.canonical) {
  vector(`canonical ${c.id} formats to itself`, () => {
    const text = textOf(c, c.main);
    const doc = openDocument(text, { set: setOf(c, c.main) });
    assert.deepEqual(doc.diagnostics, []);
    assert.deepEqual(doc.format(), { text: join(c.documents[c.main], false), diagnostics: [] });
  });
}

for (const c of cases.normalize) {
  vector(`normalize ${c.id} formats to its canonical text`, () => {
    const text = textOf(c, c.main);
    const doc = openDocument(text, { set: setOf(c, c.main) });
    assert.deepEqual(doc.diagnostics, []);
    assert.deepEqual(doc.format(), { text: join(c.canonical, false), diagnostics: [] });
  });
}

for (const c of cases.invalid) {
  vector(`invalid ${c.id} is refused with its errors`, () => {
    const text = textOf(c, c.main);
    const doc = openDocument(text, { set: setOf(c, c.main) });
    assert.deepEqual(doc.diagnostics.map(d => errorOf(text, d)), c.errors);
    const formatted = doc.format();
    assert.equal(formatted.text, null);
    assert.deepEqual(formatted.diagnostics, doc.diagnostics);
  });
}

// hashesOf returns the manifest and schema hashes of a document set given as document name to text. Each document is
// parsed with the others as its set; a document or the set that fails is an error, not a skipped hash.
function hashesOf(texts) {
  const documents = Object.keys(texts).sort().map(name => {
    const set = {};
    for (const [other, text] of Object.entries(texts)) if (other !== name) set[other] = text;
    const result = parseDbspec(texts[name], set);
    assert.deepEqual(result.diagnostics, [], `document ${name} parses`);
    return result.document;
  });
  const manifest = dbspecManifest(documents);
  assert.deepEqual(manifest.diagnostics, []);
  return { manifestHash: manifest.manifest.manifestHash, schemaHash: manifest.manifest.schemaHash };
}

for (const c of [...cases.canonical, ...cases.normalize, ...cases.hashes]) {
  vector(`formatting keeps the hashes and is idempotent: ${c.id}`, () => {
    const texts = Object.fromEntries(Object.keys(c.documents).map(name => [name, textOf(c, name)]));
    const before = hashesOf(texts);
    for (const name of Object.keys(c.documents)) {
      const formatted = openDocument(texts[name], { set: setOf(c, name) }).format();
      assert.notEqual(formatted.text, null, `${name} formats`);
      assert.equal(openDocument(formatted.text, { set: setOf(c, name) }).format().text, formatted.text, `${name} is idempotent`);
      assert.deepEqual(hashesOf({ ...texts, [name]: formatted.text }), before, `hashes of ${name} after format`);
    }
  });
}

/**
 * Writes the documents of a sets case as a file tree under a new temporary directory: the owned documents
 * `set/<place>.dbs` listed in `set/dbspec-set.json`, the external documents `external/<place>.dbs` listed as
 * `../external/<place>.dbs`. Returns the tree root with `/` separators.
 */
function setTree(c) {
  const root = mkdtempSync(joinPath(tmpdir(), 'dbspec-language-sets-')).replaceAll('\\', '/');
  mkdirSync(`${root}/set`);
  mkdirSync(`${root}/external`);
  const documents = c.documents.map((lines, i) => {
    writeFileSync(`${root}/set/${i + 1}.dbs`, join(lines, false));
    return `${i + 1}.dbs`;
  });
  const external = (c.external ?? []).map((lines, i) => {
    writeFileSync(`${root}/external/${i + 1}.dbs`, join(lines, false));
    return `../external/${i + 1}.dbs`;
  });
  writeFileSync(`${root}/set/dbspec-set.json`, JSON.stringify({ schema: 1, documents, external }));
  return root;
}

/**
 * The text and the set of the document a syntax vector id names: `<group>/<case>` for a canonical, normalize or
 * invalid case (its main document), `hashes/<case>/<document>`, and `sets/<case>/<place>` for the document at that
 * 1-based place of a sets case, whose set is the one resolveSet gives from the case's file tree. A repeated document
 * name is the one diagnostic resolveSet gives there: the case's name.duplicate errors at the later documents.
 */
function syntaxCase(id) {
  const parts = id.split('/');
  const group = parts[0];
  if (group === 'hashes') {
    const c = cases.hashes.find(x => x.id === parts[1]);
    assert.ok(c, `hashes case ${parts[1]}`);
    return { text: join(c.documents[parts[2]], false), set: setOf(c, parts[2]) };
  }
  if (group === 'sets') {
    const c = cases.sets.find(x => x.id === parts.slice(1, -1).join('/'));
    assert.ok(c, `sets case ${id}`);
    const place = Number(parts.at(-1));
    const root = setTree(c);
    try {
      const resolved = resolveSet(`${root}/set/${place}.dbs`, nodeSetHost);
      assert.deepEqual(resolved.errors, []);
      assert.equal(resolved.setFile, `${root}/set/dbspec-set.json`);
      const names = c.documents.map(headerName);
      const repeated = names.flatMap((name, i) => (names.indexOf(name) < i ? [`${root}/set/${i + 1}.dbs`] : []));
      assert.deepEqual(resolved.diagnostics.map(d => d.path), repeated);
      assert.deepEqual(resolved.diagnostics.map(d => ({ line: d.line, column: d.column, rule: d.rule })),
        repeated.length === 0 ? [] : c.errors.filter(e => e.rule === 'name.duplicate'));
      return { text: join(c.documents[place - 1], false), set: resolved.set };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const caseId = parts.slice(1).join('/');
  const c = cases[group].find(x => x.id === caseId);
  assert.ok(c, `${group} case ${caseId}`);
  return { text: textOf(c, c.main), set: setOf(c, c.main) };
}

for (const s of syntax.cases) {
  vector(`syntax ${s.id} gives the vector's tokens in UTF-16`, () => {
    const { text, set } = syntaxCase(s.id);
    const lines = parserLines(text);
    const expected = s.tokens.map(([line, start, end, cls]) => ({
      class: cls,
      range: {
        start: { line: line - 1, character: utf16Index(lines[line - 1], start) },
        end: { line: line - 1, character: utf16Index(lines[line - 1], end) },
      },
    }));
    assert.deepEqual(openDocument(text, { set }).tokens, expected);
  });
}
