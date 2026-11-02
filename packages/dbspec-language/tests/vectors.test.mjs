// The shared vectors of tests/dbspec through the language service: every canonical and normalize case of its recipe
// (tests/dbspec/canonical.json, normalize.json) formats to its canonical text, every invalid case of invalid.json reports
// its errors and is refused by format, formatting keeps the manifest and schema hashes and is idempotent, and the tokens
// of every analyze step of those recipes and of every syntax vector equal the tokens of openDocument after the UTF-16
// conversion. The documents of a sets case are written as a file tree with their set file and each takes its set from
// resolveSet, so a case whose documents repeat a name runs too: resolveSet reports the repetition.
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
// The document recipes: the cases of canonical, normalize and invalid documents, each with its format and analyze steps.
const recipes = { canonical: vectorsFile('canonical.json').cases, normalize: vectorsFile('normalize.json').cases, invalid: vectorsFile('invalid.json').cases };

/** The text of a document of a sets or hashes case, joined with the case's line ends. */
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

/** The set of a map of document name to text for one of its documents: the other documents by name. */
function othersOf(texts, name) {
  return Object.fromEntries(Object.entries(texts).filter(([other]) => other !== name));
}

/** The name a header line declares. */
const headerName = lines => lines[0].split(' ')[2];

/** The 1-based line and code point column of a range start, with the rule: the form of the case errors. */
function errorOf(text, d) {
  const line = parserLines(text)[d.range.start.line];
  return { line: d.range.start.line + 1, column: codePointIndex(line, d.range.start.character) + 1, rule: d.rule };
}

/** The text and the set of a recipe step: its lines joined with the step's line ends, and the other documents by name. */
function stepInput(step) {
  const crlf = step.crlf === true;
  const mixed = step.mixed === true;
  const set = {};
  for (const [name, lines] of Object.entries(step.set ?? {})) set[name] = join(lines, crlf, mixed);
  return { text: join(step.text, crlf, mixed), set };
}

/** The step of a recipe case with the given op. */
function stepOf(c, op) {
  const step = c.steps.find(s => s.op === op);
  assert.ok(step, `${c.id} has a ${op} step`);
  return step;
}

/** The tokens of a recipe or syntax vector in UTF-16: the expected tokens of the language service for the text. */
function utf16Tokens(text, tokens) {
  const lines = parserLines(text);
  return tokens.map(([line, start, end, cls]) => ({
    class: cls,
    range: {
      start: { line: line - 1, character: utf16Index(lines[line - 1], start) },
      end: { line: line - 1, character: utf16Index(lines[line - 1], end) },
    },
  }));
}

for (const c of recipes.canonical) {
  vector(`canonical ${c.id} formats to itself`, () => {
    const step = stepOf(c, 'dbspec.format');
    const { text, set } = stepInput(step);
    const doc = openDocument(text, { set });
    assert.deepEqual(doc.diagnostics, []);
    assert.deepEqual(doc.format(), { text: join(step.expect.none.text, false), diagnostics: [] });
  });
}

for (const c of recipes.normalize) {
  vector(`normalize ${c.id} formats to its canonical text`, () => {
    const step = stepOf(c, 'dbspec.format');
    const { text, set } = stepInput(step);
    const doc = openDocument(text, { set });
    assert.deepEqual(doc.diagnostics, []);
    assert.deepEqual(doc.format(), { text: join(step.expect.none.text, false), diagnostics: [] });
  });
}

for (const c of recipes.invalid) {
  vector(`invalid ${c.id} is refused with its errors`, () => {
    const step = stepOf(c, 'dbspec.format');
    const { text, set } = stepInput(step);
    const doc = openDocument(text, { set });
    assert.deepEqual(doc.diagnostics.map(d => errorOf(text, d)), step.expect.none.diagnostics);
    const formatted = doc.format();
    assert.equal(formatted.text, null);
    assert.deepEqual(formatted.diagnostics, doc.diagnostics);
  });
}

// hashesOf returns the manifest and schema hashes of a document set given as document name to text. Each document is
// parsed with the others as its set; a document or the set that fails is an error, not a skipped hash.
function hashesOf(texts) {
  const documents = Object.keys(texts).sort().map(name => {
    const result = parseDbspec(texts[name], othersOf(texts, name));
    assert.deepEqual(result.diagnostics, [], `document ${name} parses`);
    return result.document;
  });
  const manifest = dbspecManifest(documents);
  assert.deepEqual(manifest.diagnostics, []);
  return { manifestHash: manifest.manifest.manifestHash, schemaHash: manifest.manifest.schemaHash };
}

// checkFormatKeepsHashes formats every document of a set (name to text) and checks that each formats, is idempotent,
// and keeps the hashes of the set.
function checkFormatKeepsHashes(texts) {
  const before = hashesOf(texts);
  for (const name of Object.keys(texts)) {
    const formatted = openDocument(texts[name], { set: othersOf(texts, name) }).format();
    assert.notEqual(formatted.text, null, `${name} formats`);
    assert.equal(openDocument(formatted.text, { set: othersOf(texts, name) }).format().text, formatted.text, `${name} is idempotent`);
    assert.deepEqual(hashesOf({ ...texts, [name]: formatted.text }), before, `hashes of ${name} after format`);
  }
}

// Each canonical and normalize recipe case is one document with its set: the set of the case keeps the hashes through format.
for (const [section, list] of [['canonical', recipes.canonical], ['normalize', recipes.normalize]]) {
  for (const c of list) {
    vector(`formatting keeps the hashes and is idempotent: ${section} ${c.id}`, () => {
      const step = stepOf(c, 'dbspec.format');
      const { text, set } = stepInput(step);
      checkFormatKeepsHashes({ ...set, [headerName(step.text)]: text });
    });
  }
}

for (const c of cases.hashes) {
  vector(`formatting keeps the hashes and is idempotent: ${c.id}`, () => {
    checkFormatKeepsHashes(Object.fromEntries(Object.keys(c.documents).map(name => [name, textOf(c, name)])));
  });
}

// The tokens of the analyze step of every document recipe case equal the tokens of openDocument.
for (const [section, list] of Object.entries(recipes)) {
  for (const c of list) {
    vector(`${section} ${c.id} analyzes to its tokens in UTF-16`, () => {
      const step = stepOf(c, 'dbspec.analyze');
      // The analysis takes the set of its own step, or else the set of the format step of the case.
      const { text, set } = stepInput(step);
      const withSet = step.set === undefined ? stepInput(stepOf(c, 'dbspec.format')).set : set;
      assert.deepEqual(openDocument(text, { set: withSet }).tokens, utf16Tokens(text, step.expect.none.tokens));
    });
  }
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
 * The text and the set of the document a syntax vector id names: `hashes.<case>.<document>`, and `sets.<case>.<place>`
 * for the document at that 1-based place of a sets case, whose set is the one resolveSet gives from the case's file
 * tree. A repeated document name is the one diagnostic resolveSet gives there: the case's name.duplicate errors at the
 * later documents.
 */
function syntaxCase(id) {
  const parts = id.split('.');
  const group = parts[0];
  if (group === 'hashes') {
    const c = cases.hashes.find(x => x.id === parts[1]);
    assert.ok(c, `hashes case ${parts[1]}`);
    return { text: join(c.documents[parts[2]], false), set: setOf(c, parts[2]) };
  }
  assert.equal(group, 'sets', `syntax vector ${id} names a hashes or sets case`);
  const c = cases.sets.find(x => x.id === parts.slice(1, -1).join('.'));
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

for (const s of syntax.cases) {
  vector(`syntax ${s.id} gives the vector's tokens in UTF-16`, () => {
    const { text, set } = syntaxCase(s.id);
    assert.deepEqual(openDocument(text, { set }).tokens, utf16Tokens(text, s.tokens));
  });
}
