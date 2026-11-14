// The shared vectors of tests/dbspec through the language service: every canonical and normalize case of its recipe
// (tests/dbspec/canonical.json, normalize.json) formats to its canonical text, every invalid case of invalid.json reports
// its errors and is refused by format, formatting keeps the manifest and schema hashes and is idempotent, and the tokens
// of every analyze step of those recipes and of every syntax vector equal the tokens of openDocument after the UTF-16
// conversion. The documents of a sets case are written as a file tree with their set file and each takes its set from
// resolveSet, so a case whose documents repeat a name runs too: resolveSet reports the repetition.
// Requirements: DBS-99.
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

const vector = (name, body) => caseTest(name, body);

const { openDocument, resolveSet } = language;
// The hashes and sets recipes: the owned documents of their dbspec.set step, and the analyze steps that give the tokens.
const hashes = vectorsFile('hashes.json').cases;
const sets = vectorsFile('sets.json').cases;
// The document recipes: the cases of canonical, normalize and invalid documents, each with its format and analyze steps.
const recipes = { canonical: vectorsFile('canonical.json').cases, normalize: vectorsFile('normalize.json').cases, invalid: vectorsFile('invalid.json').cases };

/** The set of a map of document name to text for one of its documents: the other documents by name. */
function othersOf(texts, name) {
  return Object.fromEntries(Object.entries(texts).filter(([other]) => other !== name));
}

/** The name a header line declares. */
const headerName = lines => lines[0].split(' ')[2];

/** The 1-based line and code point column of a range start, with the rule and the message: the form of the case errors. */
function errorOf(text, d) {
  const line = parserLines(text)[d.range.start.line];
  return { line: d.range.start.line + 1, column: codePointIndex(line, d.range.start.character) + 1, rule: d.rule, message: d.message };
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

for (const [kind, c, outcome] of [
  ...recipes.canonical.map(c => ['canonical', c, 'itself']),
  ...recipes.normalize.map(c => ['normalize', c, 'its canonical text']),
]) {
  vector(`${kind} ${c.id} formats to ${outcome}`, () => {
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
    for (const [i, w] of step.expect.none.diagnostics.entries()) assert.ok(w.message, `expected diagnostic ${i} states no message`);
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

// A hashes case formats each of its owned documents and keeps the hashes of the set.
for (const c of hashes) {
  vector(`formatting keeps the hashes and is idempotent: ${c.id}`, () => {
    checkFormatKeepsHashes(Object.fromEntries(stepOf(c, 'dbspec.set').owned.map(text => [nameOf(text), text])));
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

/** The name a document text declares in its header line. */
function nameOf(text) {
  return text.split('\n')[0].split(' ')[2];
}

/**
 * Writes the documents of a built sets case as a file tree under a new temporary directory: the owned documents
 * `set/<place>.dbs` listed in `set/dbspec-set.json`, the external documents `external/<place>.dbs` listed as
 * `../external/<place>.dbs`. Returns the tree root with `/` separators.
 */
function setTree(step) {
  const root = mkdtempSync(joinPath(tmpdir(), 'dbspec-language-sets-')).replaceAll('\\', '/');
  mkdirSync(`${root}/set`);
  mkdirSync(`${root}/external`);
  const documents = step.owned.map((text, i) => {
    writeFileSync(`${root}/set/${i + 1}.dbs`, text);
    return `${i + 1}.dbs`;
  });
  const external = (step.external ?? []).map((text, i) => {
    writeFileSync(`${root}/external/${i + 1}.dbs`, text);
    return `../external/${i + 1}.dbs`;
  });
  writeFileSync(`${root}/set/dbspec-set.json`, JSON.stringify({ schema: 1, documents, external }));
  return root;
}

// Every analyze step of a hashes case gives the tokens of its document with the other documents as its set.
for (const c of hashes) {
  for (const step of c.steps.filter(x => x.op === 'dbspec.analyze')) {
    vector(`hashes ${c.id} analyzes to its tokens in UTF-16 (${step.text[0]})`, () => {
      const { text, set } = stepInput(step);
      assert.deepEqual(openDocument(text, { set }).tokens, utf16Tokens(text, step.expect.none.tokens));
    });
  }
}

// Every analyze step of a sets case gives the tokens of its document with the set of the step. A built set's owned
// document also resolves from its file tree to the same set.
for (const c of sets) {
  const build = stepOf(c, 'dbspec.set');
  vector(`sets ${c.id} analyzes to its tokens in UTF-16`, () => {
    if (build.expect.none.diagnostics === undefined && build.parsing === undefined) {
      const root = setTree(build);
      try {
        const resolved = resolveSet(`${root}/set/1.dbs`, nodeSetHost);
        assert.deepEqual(resolved.errors, []);
        assert.equal(resolved.setFile, `${root}/set/dbspec-set.json`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const analyses = c.steps.filter(x => x.op === 'dbspec.analyze');
    for (const step of analyses) {
      const { text, set } = stepInput(step);
      assert.deepEqual(openDocument(text, { set }).tokens, utf16Tokens(text, step.expect.none.tokens));
    }
  });
}

// A refused set whose owned documents repeat a name: resolveSet from each document of its file tree reports the
// repetition at every later document of the name, with the diagnostics of the set's dbspec.set step. This is the
// TypeScript language service's refusal (FCV-2: only the language service resolves a set from a file tree).
for (const c of sets) {
  const build = stepOf(c, 'dbspec.set');
  if (!build.expect.none.diagnostics?.some(d => d.rule === 'name.duplicate') || build.parsing !== undefined) continue;
  vector('sets repeated-document-name is refused by resolveSet with its name.duplicate diagnostics', () => {
    const root = setTree(build);
    try {
      const names = build.owned.map(nameOf);
      const repeated = names.flatMap((name, i) => (names.indexOf(name) < i ? [`${root}/set/${i + 1}.dbs`] : []));
      for (const place of names.keys()) {
        const resolved = resolveSet(`${root}/set/${place + 1}.dbs`, nodeSetHost);
        assert.deepEqual(resolved.diagnostics.map(d => d.path), repeated, `resolved from document ${place + 1}`);
        assert.deepEqual(resolved.diagnostics.map(d => ({ line: d.line, column: d.column, rule: d.rule })),
          build.expect.none.diagnostics, `resolved from document ${place + 1}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
